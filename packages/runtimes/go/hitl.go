package langchaingo

import "context"

// InterruptError is the HITL pause signal (PROTOCOL.md §5) — return it from a
// Tool.Execute (via Interrupt) and the runtime stores the pending call, emits
// a botiva interrupt event (approval chips in the client) and ends the turn.
// Not an error in the failure sense.
type InterruptError struct {
	Payload any // recommended: map with {question, options} → rendered as chips
}

func (e *InterruptError) Error() string { return "botiva interrupt (waiting for user input)" }

// resumeHolder carries the user's answer into the re-run of the paused tool.
// One-shot: a second Interrupt in the same run pauses again.
type resumeHolder struct {
	value string
	used  bool
}

type resumeKey struct{}

func withResume(ctx context.Context, value string) context.Context {
	return context.WithValue(ctx, resumeKey{}, &resumeHolder{value: value})
}

// Interrupt is the Go counterpart of LangGraph's interrupt() for this adapter.
//
// First pass: returns an *InterruptError — propagate it as the tool error and
// the run pauses. Resume pass (the user's next message): returns the answer.
//
//	func generateReport(ctx context.Context, args map[string]any) (string, error) {
//	    answer, err := langchaingo.Interrupt(ctx, map[string]any{
//	        "question": "Generate the report?", "options": []string{"Approve", "Cancel"},
//	    })
//	    if err != nil { return "", err } // pause
//	    if !approveRe.MatchString(answer) { return "The user declined.", nil }
//	    ...
//	}
func Interrupt(ctx context.Context, payload any) (string, error) {
	if holder, ok := ctx.Value(resumeKey{}).(*resumeHolder); ok && !holder.used {
		holder.used = true
		return holder.value, nil
	}
	return "", &InterruptError{Payload: payload}
}
