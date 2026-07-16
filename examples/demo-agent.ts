// Demo LangGraph agent — a REAL LLM (Claude) + local fake city-guide tools.
// No MCP required; just ANTHROPIC_API_KEY (or anthropic-key.txt in the
// parent repo root).
//
// What it demonstrates:
//   - LangGraph tool-use loop → tool_call events (client activity strip);
//     "city stats" questions chain list_cities → get_city_stats.
//   - generate_report_pdf pauses via LangGraph interrupt() → HITL: approval
//     chips appear; "Approve" resumes the tool via Command({resume}); a GenUI
//     download card follows.
//   - get_weather triggers a client-registered "weather" component through
//     dispatchCustomEvent("genui") — or equivalently botivaEmit(ui(...)).

import { ChatAnthropic } from "@langchain/anthropic";
import { interrupt, MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { z } from "zod";
import { botivaContext, botivaEmit, ui } from "@botiva/core";

// ── fake city-guide data ─────────────────────────────────────────────────────
const CITIES = [
    { id: 1, name: "Lisbon" },
    { id: 2, name: "Kyoto" },
    { id: 3, name: "Oslo" },
];

const listCities = tool(async () => JSON.stringify(CITIES), {
    name: "list_cities",
    description: "Lists all cities in the guide (id + name).",
    schema: z.object({}),
});

const getCityStats = tool(
    async ({ cityId, year }: { cityId: number; year: number }) => {
        const city = CITIES.find((c) => c.id === cityId);
        if (!city) return JSON.stringify({ resultFound: false, message: "City not found." });
        // Deterministic "fake" stats — vary by id/year.
        const seed = cityId * 7 + (year % 100);
        return JSON.stringify({
            resultFound: true,
            city: city.name,
            year,
            visitorsMillions: Math.round((1 + (seed % 20) / 2) * 10) / 10,
            avgHotelPricePerNight: 80 + (seed % 90),
            sunnyDays: 150 + (seed % 120),
            museums: 10 + (seed % 40),
        });
    },
    {
        name: "get_city_stats",
        description: "Returns a city's tourism stats (visitors, hotel prices, sunny days, museums).",
        schema: z.object({
            cityId: z.number().describe("city id from list_cities"),
            year: z.number().describe("e.g. 2025"),
        }),
    },
);

const generateReportPdf = tool(
    async ({ cityId, year }: { cityId: number; year: number }) => {
        const city = CITIES.find((c) => c.id === cityId);
        // Human approval: the LangGraph run pauses here (written to the
        // checkpoint); the user's answer returns via Command({ resume }).
        const answer = interrupt({
            question: `Generate the PDF city guide for ${city?.name ?? cityId} / ${year}?`,
            options: ["Approve", "Cancel"],
        });
        if (!/approve|yes|onay|evet/i.test(String(answer))) {
            return "The user declined — no report was generated.";
        }

        const fileName = `city-guide-${(city?.name ?? "city").toLowerCase()}-${year}.pdf`;
        // GenUI: trigger the built-in download card. botivaEmit knows which
        // conversation/user this turn belongs to — no plumbing required.
        botivaEmit(
            ui("genui-card", {
                title: `📄 ${fileName}`,
                description: `${city?.name} / ${year} city guide is ready.`,
                actions: [{ label: "⬇️ Download", value: `download ${fileName}` }],
            }),
        );
        const who = botivaContext(); // e.g. tag the report with the user id
        return `Report ready: ${fileName} (download card shown to ${who?.userId ?? "user"})`;
    },
    {
        name: "generate_report_pdf",
        description: "Generates the city guide as a PDF (asks the user for approval).",
        schema: z.object({
            cityId: z.number(),
            year: z.number(),
        }),
    },
);

const getWeather = tool(
    async ({ city }: { city: string }) => {
        const seed = [...city].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const data = {
            city,
            temp: 12 + (seed % 20),
            condition: ["Sunny", "Partly Cloudy", "Rainy"][seed % 3],
            humidity: 40 + (seed % 40),
            wind: 5 + (seed % 20),
        };
        // The dispatchCustomEvent path — equivalent to botivaEmit(ui(...)),
        // shown here because it also works without botiva imports.
        await dispatchCustomEvent("genui", { component: "weather", props: data });
        return JSON.stringify(data);
    },
    {
        name: "get_weather",
        description: "Returns a city's weather and shows a weather card in the chat.",
        schema: z.object({ city: z.string().describe("e.g. Istanbul") }),
    },
);

const SYSTEM_PROMPT = `You are a city-guide assistant (demo). Answer city/tourism questions ONLY by
calling the provided tools; never invent data. If a city is referred to by name, resolve its id via
list_cities first. If the user asks for a PDF guide, call generate_report_pdf directly WITHOUT
asking for confirmation — the tool asks for approval itself. For weather questions call get_weather;
the card is already shown, so one short sentence is enough. Reply in the user's language, short and
to the point.`;

export function buildDemoAgent() {
    const llm = new ChatAnthropic({
        model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
        maxTokens: 2000,
    });
    return createReactAgent({
        llm,
        tools: [listCities, getCityStats, generateReportPdf, getWeather],
        prompt: SYSTEM_PROMPT,
        checkpointer: new MemorySaver(),
    });
}
