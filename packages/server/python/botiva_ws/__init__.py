"""botiva WebSocket transport — stdlib-only asyncio RFC 6455 server + client
(the Python counterpart of @botiva/websocket; no third-party deps).

Identity handshake (either works, PROTOCOL.md §2):
  • Query params:  ws://host/chat?userId=u-1&conversationId=c-1&watermark=12
  • Hello frame:   first message {"type": "hello", "userId": ..., "watermark": ...}
If neither arrives within ``hello_timeout`` a fresh identity is generated and
announced via the ``welcome`` frame (the client should persist it).

The transport is intentionally thin — everything protocol-related lives in the
engine (PROTOCOL.md §8: socket open → connect, inbound → receive, close →
close, deliver → socket write):

    from botiva import ConversationEngine, DemoRuntime
    from botiva_ws import serve

    engine = ConversationEngine(DemoRuntime(), greeting="hi")
    server = await serve(engine, port=8795)          # ws://localhost:8795/chat
    await server.serve_forever()

For production behind FastAPI/Starlette, map the same four calls onto their
WebSocket objects instead — the engine surface is identical.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import struct
from typing import Any
from urllib.parse import parse_qs, urlsplit

from botiva.auth import AUTH_CLOSE_CODE, AuthInput, AuthenticationError
from botiva.engine import ConversationEngine
from botiva.protocol import Frame, error_frame, parse_incoming

logger = logging.getLogger("botiva_ws")

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MAX_MESSAGE = 16 << 20  # 16 MiB guard against hostile frames

OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


def _accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()


def _encode_frame(opcode: int, payload: bytes, mask: bool) -> bytes:
    """One frame as a single bytes object (a frame is always one write)."""
    frame = bytearray([0x80 | opcode])
    length = len(payload)
    mask_bit = 0x80 if mask else 0
    if length < 126:
        frame.append(mask_bit | length)
    elif length <= 0xFFFF:
        frame.append(mask_bit | 126)
        frame += struct.pack(">H", length)
    else:
        frame.append(mask_bit | 127)
        frame += struct.pack(">Q", length)
    if mask:
        key = os.urandom(4)
        frame += key
        frame += bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    else:
        frame += payload
    return bytes(frame)


async def _read_frame(
    reader: asyncio.StreamReader, first_byte: bytes | None = None
) -> tuple[bool, int, bytes]:
    b0 = first_byte if first_byte else await reader.readexactly(1)
    b1 = (await reader.readexactly(1))[0]
    fin = bool(b0[0] & 0x80)
    opcode = b0[0] & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", await reader.readexactly(8))[0]
    if length > _MAX_MESSAGE:
        raise ConnectionError("websocket: frame too large")
    key = await reader.readexactly(4) if masked else b""
    payload = await reader.readexactly(length) if length else b""
    if masked:
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload


class _Socket:
    """Minimal RFC 6455 connection: text messages, ping/pong, close."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, *, client: bool) -> None:
        self._reader = reader
        self._writer = writer
        self._client = client  # client frames are masked
        self._close_sent = False
        self.close_code = 0  # status code from the peer's close frame, if any
        # Serialize write+drain: an out-of-turn engine.post() can deliver to the
        # same socket concurrently with in-turn dispatch, and two overlapping
        # drains on one StreamWriter trip asyncio's FlowControlMixin assertion.
        self._write_lock = asyncio.Lock()

    async def send_text(self, text: str) -> None:
        """Send one text frame, serialized against concurrent senders."""
        if self._writer.is_closing():
            raise ConnectionError("websocket: closed")
        async with self._write_lock:
            self._writer.write(_encode_frame(OP_TEXT, text.encode(), self._client))
            await self._writer.drain()

    async def recv_text(self, first_byte: bytes | None = None) -> str | None:
        """Next complete text message; None once the peer closes."""
        message = bytearray()
        in_message = False
        while True:
            try:
                fin, opcode, payload = await _read_frame(self._reader, first_byte)
            except (asyncio.IncompleteReadError, ConnectionError, OSError):
                return None
            first_byte = None
            if opcode == OP_PING:
                self._writer.write(_encode_frame(OP_PONG, payload, self._client))
            elif opcode == OP_PONG:
                pass
            elif opcode == OP_CLOSE:
                if len(payload) >= 2:
                    self.close_code = struct.unpack(">H", payload[:2])[0]
                if not self._close_sent:
                    self._close_sent = True
                    self._writer.write(_encode_frame(OP_CLOSE, payload, self._client))
                return None
            elif opcode in (OP_TEXT, OP_BINARY):
                if in_message:
                    return None  # protocol violation
                message += payload
                in_message = True
                if fin:
                    return message.decode("utf-8", errors="replace")
            elif opcode == OP_CONT:
                if not in_message or len(message) + len(payload) > _MAX_MESSAGE:
                    return None
                message += payload
                if fin:
                    return message.decode("utf-8", errors="replace")
            else:
                return None

    async def close(self) -> None:
        if not self._close_sent and not self._writer.is_closing():
            self._close_sent = True
            self._writer.write(_encode_frame(OP_CLOSE, b"", self._client))
            try:
                await self._writer.drain()
            except (ConnectionError, OSError):
                pass
        self._writer.close()

    async def close_with_code(self, code: int, reason: str = "") -> None:
        """Send a close frame with an application status code + reason
        (RFC 6455 §5.5.1), then close. Used for auth rejections (4401)."""
        if not self._close_sent and not self._writer.is_closing():
            self._close_sent = True
            payload = struct.pack(">H", code) + reason.encode("utf-8")
            self._writer.write(_encode_frame(OP_CLOSE, payload, self._client))
            try:
                await self._writer.drain()
            except (ConnectionError, OSError):
                pass
        self._writer.close()


# ── server ────────────────────────────────────────────────────────────────────


class WebSocketServer:
    def __init__(
        self,
        engine: ConversationEngine,
        *,
        host: str = "0.0.0.0",
        port: int = 8795,
        path: str = "/chat",
        hello_timeout: float = 0.3,
    ) -> None:
        self.engine = engine
        self.host = host
        self.port = port
        self.path = path
        self.hello_timeout = hello_timeout
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._on_client, self.host, self.port)

    async def serve_forever(self) -> None:
        if self._server is None:
            await self.start()
        assert self._server is not None
        async with self._server:
            await self._server.serve_forever()

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _on_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await self._serve_client(reader, writer)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass  # client went away — the conversation stays resumable
        except Exception:  # noqa: BLE001
            logger.warning("[botiva/ws] connection failed", exc_info=True)
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def _serve_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        method, target, headers = await _read_http_request(reader)
        url = urlsplit(target)
        if url.path != self.path:
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            return
        key = headers.get("sec-websocket-key")
        if (
            method.upper() != "GET"  # RFC 6455 §4.1: the handshake is a GET
            or key is None
            or "websocket" not in headers.get("upgrade", "").lower()
            or "upgrade" not in headers.get("connection", "").lower()
        ):
            writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            return
        writer.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {_accept_key(key)}\r\n\r\n"
            ).encode()
        )
        await writer.drain()

        socket = _Socket(reader, writer, client=False)
        query = parse_qs(url.query)

        def q(name: str) -> str | None:
            values = query.get(name)
            return values[0] if values else None

        user_id = q("userId")
        conversation_id = q("conversationId")
        raw_watermark = q("watermark")
        # A malformed watermark is NOT identity — mirror Go (Atoi) / .NET
        # (TryParse), which still open the hello wait when parsing fails.
        has_watermark = raw_watermark is not None and raw_watermark.isdigit()
        watermark = int(raw_watermark) if has_watermark else 0
        meta: dict[str, Any] | None = None
        buffered: str | None = None

        # Auth credential (§2.1): ?token=, then Authorization: Bearer; a hello
        # frame may still add one below. Headers are forwarded (cookie support).
        token = q("token")
        if token is None:
            authz = headers.get("authorization", "")
            if authz.lower().startswith("bearer "):
                token = authz[7:].strip()

        # No identity in the URL → give the client a beat to send a hello frame.
        # Only the first byte is awaited under the timeout, so a frame that has
        # started arriving is always read to completion (no torn frames).
        if user_id is None and conversation_id is None and not has_watermark and self.hello_timeout > 0:
            try:
                first_byte = await asyncio.wait_for(reader.readexactly(1), self.hello_timeout)
            except asyncio.TimeoutError:
                first_byte = None  # fresh visitor — the engine generates ids
            if first_byte is not None:
                text = await socket.recv_text(first_byte)
                if text is None:
                    return
                inbound = parse_incoming(text)
                if inbound is not None and inbound.hello is not None:
                    hello = inbound.hello
                    user_id, conversation_id, meta = hello.user_id, hello.conversation_id, hello.meta
                    if hello.watermark is not None:
                        watermark = hello.watermark
                    if hello.token is not None:
                        token = hello.token
                else:
                    buffered = text  # first frame was a normal message → handle after connect

        def deliver(frame: Frame) -> Any:
            return socket.send_text(json.dumps(frame, ensure_ascii=False))

        try:
            connection = await self.engine.connect(
                deliver,
                user_id=user_id,
                conversation_id=conversation_id,
                watermark=watermark,
                meta=meta,
                auth=AuthInput(
                    transport="websocket",
                    token=token,
                    query={k: v[0] for k, v in query.items() if v},
                    headers=headers,
                ),
            )
        except AuthenticationError as err:
            await socket.send_text(json.dumps(error_frame(err.code, err.reason)))
            await socket.close_with_code(AUTH_CLOSE_CODE, err.reason)
            return
        try:
            if buffered is not None:
                await connection.receive(buffered)
            while True:
                text = await socket.recv_text()
                if text is None:
                    return
                await connection.receive(text)
        finally:
            await connection.close()


async def serve(engine: ConversationEngine, **kwargs: Any) -> WebSocketServer:
    """Start a WebSocketServer and return it (call ``serve_forever`` to block)."""
    server = WebSocketServer(engine, **kwargs)
    await server.start()
    return server


async def _read_http_request(reader: asyncio.StreamReader) -> tuple[str, str, dict[str, str]]:
    request_line = (await reader.readline()).decode("latin-1").strip()
    parts = request_line.split(" ")
    if len(parts) < 3:
        raise ConnectionError(f"websocket: bad request line {request_line!r}")
    method, target = parts[0], parts[1]
    headers: dict[str, str] = {}
    while True:
        line = (await reader.readline()).decode("latin-1").strip()
        if not line:
            break
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return method, target, headers


# ── client (for scripted self-tests and CLI tools) ───────────────────────────


class WebSocketClient:
    """Tiny masked-frame client:

    client = await WebSocketClient.connect("ws://localhost:8795/chat")
    await client.send('{"type":"text","data":{"text":"hello"}}')
    frame = await client.recv()          # str | None
    """

    def __init__(self, socket: _Socket) -> None:
        self._socket = socket

    @classmethod
    async def connect(cls, url: str, headers: dict[str, str] | None = None) -> "WebSocketClient":
        parts = urlsplit(url)
        if parts.scheme != "ws":
            raise ValueError("only ws:// URLs are supported by this minimal client")
        host = parts.hostname or "localhost"
        port = parts.port or 80
        reader, writer = await asyncio.open_connection(host, port)
        key = base64.b64encode(os.urandom(16)).decode()
        target = parts.path or "/"
        if parts.query:
            target += "?" + parts.query
        extra = "".join(f"{name}: {value}\r\n" for name, value in (headers or {}).items())
        writer.write(
            (
                f"GET {target} HTTP/1.1\r\n"
                f"Host: {parts.netloc}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                f"{extra}"
                "\r\n"
            ).encode()
        )
        await writer.drain()
        status = (await reader.readline()).decode("latin-1")
        if " 101 " not in status:
            writer.close()
            raise ConnectionError(f"websocket: handshake rejected ({status.strip()})")
        headers: dict[str, str] = {}
        while True:
            line = (await reader.readline()).decode("latin-1").strip()
            if not line:
                break
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        if headers.get("sec-websocket-accept") != _accept_key(key):
            writer.close()
            raise ConnectionError("websocket: bad Sec-WebSocket-Accept")
        return cls(_Socket(reader, writer, client=True))

    async def send(self, text: str) -> None:
        await self._socket.send_text(text)

    async def recv(self) -> str | None:
        return await self._socket.recv_text()

    @property
    def close_code(self) -> int:
        """Status code from the server's close frame (0 if none seen yet)."""
        return self._socket.close_code

    async def close(self) -> None:
        await self._socket.close()
