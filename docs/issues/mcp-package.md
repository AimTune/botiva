# Promote MCP support from examples to packages/mcp/*

## Problem

MCP integration is example-level only. `packages/mcp/` is currently just a
placeholder README. What exists today:

- **TS**: `examples/ts/mcp-server.ts` (SQL-backed shop MCP server, Streamable
  HTTP) and `examples/ts/mcp-demo-server.ts`, which contains the genuinely
  reusable part — an Extension middleware that hides/redacts sensitive MCP
  tool traffic before it reaches clients — buried in a demo file.
- **.NET**: `examples/dotnet/Botiva.Example/Mcp/IterationMcpTools.cs` — MCP
  tool server via `ModelContextProtocol.AspNetCore`, consumed through a real
  `McpClient` (`McpClientTool : AIFunction` drops straight into
  `ChatClientRuntimeOptions.Tools`).

Anyone wanting "MCP tools behind botiva with traffic redaction" has to copy
demo code.

## Proposal

1. **`packages/mcp/ts` → `@botiva/mcp`**:
   - Generalize the redaction/hide Extension from `mcp-demo-server.ts` into a
     configurable `mcpRedactionExtension(options)` (match tools by name/glob,
     hide tool_call frames entirely or redact args/results).
   - Helpers to load MCP tools into runtimes (thin glue over
     `@langchain/mcp-adapters` / `@modelcontextprotocol/sdk`) so demos shrink
     to configuration.
   - Keep `examples/ts/mcp-server.ts` and the demo server as consumers.
2. **Later, per demand**: `packages/mcp/dotnet` (extract the reusable client
   wiring from `Botiva.Example`), Go/Python equivalents once their runtimes
   grow MCP consumption.

## Open questions

- Should the redaction Extension live in `@botiva/mcp` or in core as a
  generic frame-filter Extension (MCP is just one user of it)?
- Which languages actually need first-class MCP packages beyond TS and .NET?
