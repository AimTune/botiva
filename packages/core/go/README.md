# botiva (Go reference port)

Go port of the botiva conversation framework — same signatures as
`@botiva/core` (see [../../../PROTOCOL.md](../../../PROTOCOL.md) §8). The core
package is zero-dependency (stdlib only).

Four Go modules, stitched together by the repo-root `go.work`:

```
packages/core/go/        module github.com/aimtune/botiva/core     — engine, protocol, events, stores, DemoRuntime (zero deps)
packages/server/go/      module github.com/aimtune/botiva/server/ws  — WebSocket transport, stdlib-only RFC 6455 server + client
packages/runtimes/go/    module github.com/aimtune/botiva/runtimes/langchaingo — agent adapter for langchaingo llms.Model
examples/go/server/      runnable demo server (:8793) with --selftest
```

## Serve a bot

```go
package main

import (
    "net/http"

    botiva "github.com/aimtune/botiva/core"
    "github.com/aimtune/botiva/server/ws"
)

func main() {
    engine := botiva.NewConversationEngine(botiva.EngineOptions{
        Runtime:  botiva.DemoRuntime{}, // swap for your Runtime / the langchaingo adapter
        Greeting: "Hi! 👋",
    })
    mux := http.NewServeMux()
    mux.Handle("/chat", ws.NewHandler(engine, nil)) // ws://localhost:8793/chat
    http.ListenAndServe(":8793", mux)
}
```

The transport accepts identity via query
(`?userId=&conversationId=&watermark=`) **or** a first `hello` frame, and
handles watermark replay, fan-out and HITL exactly like the TS transport.
`ws.Dial` is a matching minimal client for scripted tests.

## Agent framework — langchaingo

`packages/runtimes/go` (its own module, so the core stays dependency-free)
plugs any langchaingo `llms.Model` into the Runtime port with a manual
tool-calling loop, tool_call tracing, ConversationStore-backed chat memory and
LangGraph-style HITL:

```go
import lcadapter "github.com/aimtune/botiva/runtimes/langchaingo"

runtime := lcadapter.New(model, lcadapter.Options{ // model: openai.New(...), anthropic.New(...), ollama.New(...)
    Tools: []lcadapter.Tool{{
        Name: "generate_report_pdf", Description: "Generates a report (asks for approval).",
        Parameters: map[string]any{"type": "object", "properties": map[string]any{
            "topic": map[string]any{"type": "string"},
        }},
        Execute: func(ctx context.Context, args map[string]any) (string, error) {
            answer, err := lcadapter.Interrupt(ctx, map[string]any{ // ⏸ HITL pause
                "question": "Generate the report?", "options": []string{"Approve", "Cancel"},
            })
            if err != nil {
                return "", err // first pass → interrupt event → approval chips
            }
            // resume pass: answer = the user's next message
            botiva.Emit(ctx, botiva.UI("genui-card", map[string]any{"title": "📄 report.pdf"}))
            return "Report ready.", nil
        },
    }},
})
engine := botiva.NewConversationEngine(botiva.EngineOptions{Runtime: runtime})
```

Inside `Execute`, `botiva.FromContext(ctx)` gives the `TurnContext`
(UserStore/ConversationStore) and `botiva.Emit(ctx, …)` pushes GenUI/events —
the Go equivalents of `botivaContext()`/`botivaEmit()` (PROTOCOL.md §9).

## Run / test

All from the repo root (workspace mode via `go.work`):

```sh
go test github.com/aimtune/botiva/...     # every module: engine + ws transport + adapter
go run ./examples/go/server                  # demo server on :8793 (PORT overridable)
go run ./examples/go/server --selftest       # + scripted WS client, exit 0/1
```

Or per module, standalone (`replace` directives resolve the local deps):

```sh
cd packages/core/go && go test ./...         # engine
cd packages/server/go && go test ./...       # ws transport (E2E over httptest)
cd packages/runtimes/go && go test ./...     # agent adapter (scripted fake model)
```
