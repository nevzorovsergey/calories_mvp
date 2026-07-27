/** Разовая проверка: какой параметр реально гасит reasoning на polza.ai. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { buildSystemPrompt, buildUserText } from "../src/lib/llm/prompt";
import { buildResponseSchema } from "../src/lib/llm/schema";

loadEnv({ path: ".env.local" });

const BASE_URL = process.env.POLZA_BASE_URL ?? "https://polza.ai/api/v1";
const imageBase64 = readFileSync(
  join(process.cwd(), "fixtures", "sent-dish-4.jpg"),
).toString("base64");

function body(modelId: string, extra: Record<string, unknown>) {
  return {
    model: modelId,
    temperature: 0.2,
    max_tokens: 4000,
    response_format: {
      type: "json_schema",
      json_schema: buildResponseSchema("v2-scale"),
    },
    messages: [
      { role: "system", content: buildSystemPrompt("v2-scale") },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
              detail: "high",
            },
          },
          { type: "text", text: buildUserText({}) },
        ],
      },
    ],
    ...extra,
  };
}

const VARIANTS: { name: string; extra: Record<string, unknown> }[] = [
  { name: "baseline", extra: {} },
  { name: "reasoning:{enabled:false}", extra: { reasoning: { enabled: false } } },
  { name: 'reasoning_effort:"none"', extra: { reasoning_effort: "none" } },
  { name: 'reasoning_effort:"minimal"', extra: { reasoning_effort: "minimal" } },
];

async function main() {
  const modelId = process.argv[2] ?? "google/gemini-3.6-flash";
  for (const variant of VARIANTS) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.POLZA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body(modelId, variant.extra)),
    });
    const json = (await res.json()) as Record<string, any>;
    const usage = json.usage ?? {};
    const content = json.choices?.[0]?.message?.content;
    console.log(
      `${variant.name.padEnd(28)} http=${res.status} ` +
        `completion=${String(usage.completion_tokens).padEnd(6)} ` +
        `reasoning=${String(usage.completion_tokens_details?.reasoning_tokens).padEnd(6)} ` +
        `₽${usage.cost_rub?.toFixed?.(2) ?? "—"} ` +
        `json=${content ? "да" : "НЕТ"} ` +
        `${res.ok ? "" : JSON.stringify(json).slice(0, 160)}`,
    );
  }
}

main();
