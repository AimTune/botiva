// botivaEmit — emit events into the current turn from ANYWHERE in the async
// call tree, without threading the context through your own code:
//
//   import { botivaEmit, botivaContext, ui } from "@botiva/core";
//
//   // inside a LangGraph node / LangChain tool / any function called
//   // during a turn:
//   botivaEmit(ui("weather-card", { temp: 22 }));
//   const ctx = botivaContext();           // who am I talking to?
//   await ctx?.userStore.patch({ seen: true });
//
// Implementation: Node AsyncLocalStorage. Equivalents in other languages
// (see PROTOCOL.md §9): Python contextvars, .NET AsyncLocal<T>,
// Go context.Context (passed explicitly).

import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentEvent } from "./events.js";
import type { TurnContext } from "./runtime.js";

const storage = new AsyncLocalStorage<TurnContext>();

/**
 * Emit an event into the current turn. Returns false when called outside a
 * turn (no-op) — e.g. from a background job; use engine.post() there instead.
 */
export function botivaEmit(event: AgentEvent): boolean {
    const ctx = storage.getStore();
    if (!ctx) return false;
    ctx.emit(event);
    return true;
}

/** The TurnContext of the currently executing turn, if any. */
export function botivaContext(): TurnContext | undefined {
    return storage.getStore();
}

/** Used by the engine (or custom engines) to establish the turn context. */
export function runWithTurnContext<T>(ctx: TurnContext, fn: () => T): T {
    return storage.run(ctx, fn);
}
