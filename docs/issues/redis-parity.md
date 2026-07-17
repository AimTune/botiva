# Redis state/history stores for the Go, .NET and Python ports

## Problem

Persistent stores exist only in TypeScript: `packages/state/redis/ts`
(`@botiva/redis`) implements `RedisStateStore` + `RedisHistoryStore` over a
duck-typed `RedisClientLike` (works with ioredis and node-redis casing). The
Go, .NET and Python ports only ship the in-memory reference stores
(`state.go`, `State.cs`, `state.py`), so their engines lose all state on
restart.

## Proposal

Add Redis implementations of the `StateStore`/`HistoryStore` ports (method
shapes fixed by PROTOCOL.md §8) for the three other languages, mirroring the
TS keyspace exactly (`user:{userId}`, `conv:{conversationId}`,
`conv:{conversationId}:botiva`, history keys with monotonic 1-based `seq`):

- **Go** — `packages/state/redis/go` as a **separate module** (like the
  langchaingo adapter) so `packages/core/go` stays zero-dependency; use
  `github.com/redis/go-redis/v9`.
- **.NET** — `packages/state/redis/dotnet` (`Botiva.Redis`), own project
  referencing core; use `StackExchange.Redis`.
- **Python** — `packages/state/redis/python` (`botiva_redis`), optional
  dependency on `redis>=5` (asyncio client), duck-typed like the TS package
  where practical.

Each with a deterministic selftest (skipped or backed by a fake when no Redis
is reachable), wired into the per-language test commands in CLAUDE.md.

## Notes / scope guards

- Botiva state/transcript only — LangGraph checkpoints stay in
  `@langchain/langgraph-checkpoint-redis` (and equivalents), as today.
- The turn lock and live-connection registry remain process-local
  (PROTOCOL.md §10); store-based locking / pub-sub fan-out is explicitly out
  of scope here.
