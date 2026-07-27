/** Последовательный прогон строго через json_schema, без фолбэка. */
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { buildSystemPrompt, buildUserText } from "../src/lib/llm/prompt";
import { buildResponseSchema, dishAnalysisSchema } from "../src/lib/llm/schema";
import { runScaleChecks } from "../src/lib/llm/scale-check";

loadEnv({ path: ".env.local" });

const modelId = process.argv[2];
const maxTokens = Number(process.argv[3] ?? 5000);
const exp = JSON.parse(readFileSync("fixtures/expectations.json", "utf8")) as any;

function strip(t: string) {
  const s = t.trim();
  return s.startsWith("```") ? s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim() : s;
}

async function one(d: any) {
  const imageBase64 = readFileSync(`fixtures/${d.file}`).toString("base64");
  const started = Date.now();
  const res = await fetch(`${process.env.POLZA_BASE_URL ?? "https://polza.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.POLZA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId, temperature: 0.2, max_tokens: maxTokens,
      response_format: { type: "json_schema", json_schema: buildResponseSchema("v2-scale") },
      messages: [
        { role: "system", content: buildSystemPrompt("v2-scale") },
        { role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" } },
          { type: "text", text: buildUserText({}) },
        ] },
      ],
    }),
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  const json: any = await res.json();
  if (res.status >= 400) return console.log(`✗ ${d.file} HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  const fin = json?.choices?.[0]?.finish_reason;
  const rub = json?.usage?.cost_rub?.toFixed(2);
  const content = json?.choices?.[0]?.message?.content;
  if (!content) return console.log(`✗ ${d.file} пустой ответ | ${fin} | ${secs} с | ${rub} ₽`);
  let parsed: unknown;
  try { parsed = JSON.parse(strip(content)); }
  catch { return console.log(`✗ ${d.file} невалидный JSON | ${fin} | ${secs} с | ${rub} ₽`); }
  const v = dishAnalysisSchema.safeParse(parsed);
  if (!v.success) return console.log(`✗ ${d.file} не по схеме: ${v.error.issues.slice(0,2).map(i=>i.path.join('.')).join(', ')} | ${fin} | ${secs} с | ${rub} ₽`);
  const a = v.data;
  const hay = a.ingredients.map(i => `${i.name_ru} ${i.name_en}`.toLowerCase()).join(" | ");
  const missing = d.required.filter((g: string[]) => !g.some(k => hay.includes(k.toLowerCase()))).map((g: string[]) => g[0]);
  const w = a.total_weight_g >= d.weightRange[0] && a.total_weight_g <= d.weightRange[1];
  const ref = d.scaleReference ? a.scale_references.some(r => r.type === d.scaleReference) : null;
  const chain = runScaleChecks(a, []);
  console.log(
    `✓ ${d.file} состав ${d.required.length - missing.length}/${d.required.length}` +
    ` | ${a.total_weight_g} г ${w ? "✓" : "✗"} | эталон ${ref === null ? "—" : ref ? "✓" : "✗"}` +
    ` | цепочка ${chain.consistency_flags.length === 0 ? "✓" : "✗ " + chain.consistency_flags.join(",")}` +
    ` | ${secs} с | ${rub} ₽` + (missing.length ? ` | не назвала: ${missing.join(", ")}` : ""),
  );
}

async function main() {
  console.log(`${modelId}, max_tokens ${maxTokens}, строго json_schema, последовательно\n`);
  for (const d of exp.dishes) await one(d);
}
main().catch(e => { console.error(e); process.exit(1); });
