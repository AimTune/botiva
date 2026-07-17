// DemoRuntime — dependency-free reference implementation of the Runtime port.
// Lets you exercise the full framework (tool activity, HITL, GenUI via
// botivaEmit, user/conversation state) without an LLM or API key, and shows
// adapter authors what the contract looks like:
//
//   "my name is X" / "adım X"  → writes ctx.userStore   (persists across conversations)
//   "what's my name"           → reads ctx.userStore
//   "weather" / "hava"         → botivaEmit(ui(...)) out-of-band GenUI card
//   "report" / "rapor"         → fake tool_call (running→completed) + HITL interrupt
//   answer to the interrupt    → resume completes the run
//   anything else              → echo

import { botivaEmit } from "./emit.js";
import {
    interrupt,
    message,
    runFinished,
    runStarted,
    toolCall,
    ui,
    type AgentEvent,
} from "./events.js";
import type { RunInput, Runtime, TurnContext } from "./runtime.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoRuntime implements Runtime {
    async *run(input: RunInput, ctx: TurnContext): AsyncGenerator<AgentEvent> {
        yield runStarted();

        // HITL continuation: the user answered the pending interrupt.
        if (input.resume !== undefined) {
            const ok = /approve|yes|onay|evet/i.test(String(input.resume));
            yield message(
                ok
                    ? "✅ Approved — the PDF report is ready: report-2025.pdf"
                    : "❌ Cancelled — no report was generated.",
            );
            yield runFinished();
            return;
        }

        const text = (input.text ?? "").trim();
        let match: RegExpMatchArray | null;

        if ((match = text.match(/(?:my name is|ad[ıi]m)\s+(\p{L}+)/iu))) {
            await ctx.userStore.patch({ name: match[1] });
            yield message(`Nice to meet you, ${match[1]}! I'll remember that across conversations.`);
        } else if (/what.*my name|ad[ıi]m ne/i.test(text)) {
            const user = (await ctx.userStore.get()) as { name?: string } | undefined;
            yield message(
                user?.name
                    ? `Your name is ${user.name}.`
                    : "I don't know your name yet — tell me with “my name is …”.",
            );
        } else if (/weather|hava/i.test(text)) {
            // Out-of-band emit — works from anywhere in the async call tree.
            botivaEmit(ui("weather", { city: "Istanbul", temp: 22, condition: "Sunny" }));
            yield message("Here is the current weather.");
        } else if (/report|rapor/i.test(text)) {
            const id = `demo-${Date.now()}`;
            yield toolCall(id, "get_sales_stats", "running", {
                params: { region: "EMEA", year: 2025 },
                startedAt: Date.now(),
            });
            await sleep(400);
            yield toolCall(id, "get_sales_stats", "completed", {
                result: { totalOrders: 42, growth: 0.87 },
                endedAt: Date.now(),
            });
            yield interrupt({
                question: "42 orders, 87% growth in EMEA. Generate the PDF report?",
                options: ["Approve", "Cancel"],
            });
        } else {
            yield message(`Echo: ${text}`);
        }

        yield runFinished();
    }
}
