# botiva MCP packages (planned)

MCP support currently lives in the examples, not in a reusable package:

- `examples/ts/mcp-server.ts` — standalone SQL-backed shop MCP server
  (Streamable HTTP, :8794).
- `examples/ts/mcp-demo-server.ts` — agent consuming those tools, plus an
  Extension middleware that hides/redacts sensitive tool traffic.
- `examples/dotnet/Botiva.Example/Mcp/` — MCP tool server + `McpClient`
  consumption over the official C# MCP SDK.

Promoting this to first-class `packages/mcp/<language>` packages (a reusable
redaction/tool-filter Extension and MCP tool-loading helpers) is tracked in
[AimTune/botiva#3](https://github.com/AimTune/botiva/issues/3)
(draft: [docs/issues/mcp-package.md](../../docs/issues/mcp-package.md)).
