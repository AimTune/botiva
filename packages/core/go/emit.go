package botiva

import "context"

// Go has no ambient async context — the idiomatic equivalent of botivaEmit is
// carrying the TurnContext in a context.Context (PROTOCOL.md §9):
//
//	func myNode(ctx context.Context, state State) error {
//	    botiva.Emit(ctx, botiva.UI("weather-card", props)) // no plumbing beyond ctx
//	    tc := botiva.FromContext(ctx)                      // stores, ids, log
//	    ...
//	}
//
// Runtime adapters should call WithTurnContext before invoking agent code.

type turnContextKey struct{}

// WithTurnContext returns a context carrying the TurnContext.
func WithTurnContext(ctx context.Context, tc *TurnContext) context.Context {
	return context.WithValue(ctx, turnContextKey{}, tc)
}

// FromContext returns the current TurnContext, or nil outside a turn.
func FromContext(ctx context.Context) *TurnContext {
	tc, _ := ctx.Value(turnContextKey{}).(*TurnContext)
	return tc
}

// Emit pushes an event into the current turn. Returns false outside a turn.
func Emit(ctx context.Context, ev AgentEvent) bool {
	tc := FromContext(ctx)
	if tc == nil {
		return false
	}
	tc.Emit(ev)
	return true
}
