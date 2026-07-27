/** Разовая проверка: что именно возвращает gemma-4-26b-a4b на схеме и на json_object. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { buildSystemPrompt, buildUserText } from "../src/lib/llm/prompt";
import { buildResponseSchema } from "../src/lib/llm/schema";

loadEnv({ path: ".env.local" });

const BASE_URL = process.env.POLZA_BASE_URL ?? "https://polza.ai/api/v1";
const MODEL = "google/gemma-4-26b-a4b-it";
const dish = process.argv[2] ?? "sent-dish-1.jpg";
const maxTokens = Number(process.argv[3] ?? 4000);
const imageBase64 = readFileSync(
  join(process.cwd(), "fixtures", dish),
).toString("base64");

function body(format: "json_schema" | "json_object") {
  return {
    model: MODEL,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format:
      format === "json_schema"
        ? { type: "json_schema", json_schema: buildResponseSchema("v2-scale") }
        : { type: "json_object" },
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
  };
}

async function run(format: "json_schema" | "json_object") {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.POLZA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body(format)),
  });
  const json = (await res.json()) as Record<string, any>;
  const choice = json.choices?.[0];
  console.log(`\n===== ${format} (max_tokens=${maxTokens}, ${dish}) http=${res.status}`);
  console.log("finish_reason:", choice?.finish_reason);
  console.log("usage:", JSON.stringify(json.usage));
  if (!res.ok) console.log("error:", JSON.stringify(json).slice(0, 600));
  const content = choice?.message?.content;
  console.log("content length:", content?.length);
  console.log("content head:", content?.slice(0, 700));
  console.log("content tail:", content?.slice(-300));
}

async function main() {
  const only = process.argv[4] as "json_schema" | "json_object" | undefined;
  if (only) {
    await run(only);
    return;
  }
  await run("json_schema");
  await run("json_object");
}

main();
