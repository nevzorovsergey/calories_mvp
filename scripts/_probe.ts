/** Разовый зонд: сырой ответ модели. npx tsx scripts/_probe.ts <model> <фото> <max_tokens> [json_object] */
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { buildSystemPrompt, buildUserText } from "../src/lib/llm/prompt";
import { buildResponseSchema } from "../src/lib/llm/schema";

loadEnv({ path: ".env.local" });

async function main() {
  const [modelId, dish = "sent-dish-2.jpg", tokens = "4000", mode = "json_schema"] =
    process.argv.slice(2);
  const maxTokens = Number(tokens);
  const imageBase64 = readFileSync(`fixtures/${dish}`).toString("base64");
  const system = buildSystemPrompt("v2-scale");

  const body = {
    model: modelId,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format:
      mode === "json_object"
        ? { type: "json_object" as const }
        : { type: "json_schema" as const, json_schema: buildResponseSchema("v2-scale") },
    messages: [
      {
        role: "system",
        content:
          mode === "json_object"
            ? `${system}\n\nВерни строго один JSON-объект по схеме dish_analysis без markdown-обёртки.`
            : system,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" } },
          { type: "text", text: buildUserText({}) },
        ],
      },
    ],
  };

  const res = await fetch(
    `${process.env.POLZA_BASE_URL ?? "https://polza.ai/api/v1"}/chat/completions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.POLZA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as any;
  console.log(`HTTP ${res.status} | ${modelId} | ${dish} | ${mode} | max_tokens ${maxTokens}`);
  if (res.status >= 400) { console.log(JSON.stringify(json).slice(0, 600)); return; }
  console.log("finish_reason:", json?.choices?.[0]?.finish_reason, "| usage:", JSON.stringify(json?.usage?.completion_tokens), "| ₽", json?.usage?.cost_rub);
  const msg = json?.choices?.[0]?.message;
  console.log("--- content ---");
  const c = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content) ?? "";
  console.log("длина content:", c.length);
  console.log(c.slice(0, 1200));
  console.log("\n--- хвост ---");
  console.log(c.slice(-1500));
}

main().catch((e) => { console.error(e); process.exit(1); });
