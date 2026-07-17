package botiva

import (
	"context"
	"fmt"
	"regexp"
	"time"
)

// DemoRuntime — dependency-free reference implementation of the Runtime port
// (same behavior as the TS DemoRuntime; used by the port's tests).
type DemoRuntime struct{}

var (
	nameRe    = regexp.MustCompile(`(?i)(?:my name is|ad[ıi]m)\s+(\p{L}+)`)
	askNameRe = regexp.MustCompile(`(?i)what.*my name|ad[ıi]m ne`)
	approveRe = regexp.MustCompile(`(?i)approve|yes|onay|evet`)
	weatherRe = regexp.MustCompile(`(?i)weather|hava`)
	reportRe  = regexp.MustCompile(`(?i)report|rapor`)
)

func (DemoRuntime) Run(ctx context.Context, input RunInput, tc *TurnContext) (<-chan AgentEvent, error) {
	out := make(chan AgentEvent, 16)
	go func() {
		defer close(out)
		out <- RunStarted()

		if input.IsResume {
			if approveRe.MatchString(input.Resume) {
				out <- Message("✅ Approved — the PDF report is ready: report-2025.pdf")
			} else {
				out <- Message("❌ Cancelled — no report was generated.")
			}
			out <- RunFinished()
			return
		}

		text := input.Text
		switch {
		case nameRe.MatchString(text):
			name := nameRe.FindStringSubmatch(text)[1]
			_, _ = tc.UserStore.Patch(ctx, map[string]any{"name": name})
			out <- Message(fmt.Sprintf("Nice to meet you, %s! I'll remember that across conversations.", name))
		case askNameRe.MatchString(text):
			user, _ := tc.UserStore.Get(ctx)
			if name, ok := user["name"].(string); ok {
				out <- Message(fmt.Sprintf("Your name is %s.", name))
			} else {
				out <- Message("I don't know your name yet — tell me with “my name is …”.")
			}
		case weatherRe.MatchString(text):
			// Out-of-band emit through the ambient context.
			Emit(WithTurnContext(ctx, tc), UI("weather", map[string]any{"city": "Istanbul", "temp": 22}))
			out <- Message("Here is the current weather.")
		case reportRe.MatchString(text):
			id := fmt.Sprintf("demo-%d", time.Now().UnixMilli())
			out <- ToolCallEvent(ToolCall{ID: id, Name: "get_sales_stats", Status: "running", StartedAt: time.Now().UnixMilli()})
			out <- ToolCallEvent(ToolCall{ID: id, Name: "get_sales_stats", Status: "completed",
				Result: map[string]any{"totalOrders": 42, "growth": 0.87}, EndedAt: time.Now().UnixMilli()})
			out <- Interrupt(map[string]any{
				"question": "42 orders, 87% growth in EMEA. Generate the PDF report?",
				"options":  []any{"Approve", "Cancel"},
			}, "")
		default:
			out <- Message("Echo: " + text)
		}
		out <- RunFinished()
	}()
	return out, nil
}
