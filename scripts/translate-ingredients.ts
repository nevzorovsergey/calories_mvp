/**
 * Русификация справочника (§8.2 PRD).
 *
 *   npx tsx scripts/translate-ingredients.ts [--limit N] [--model ID]
 *
 * Батчами по 50 гоняет английские `description` из дампов USDA через дешёвую
 * текстовую модель polza.ai и получает `name_ru` + 2–4 синонима.
 *
 * Результат копится в data/translations.json и коммитится в репозиторий.
 * Это принципиально: повторный импорт справочника не тратит деньги заново и
 * даёт тот же результат, а ручная вычитка топ-500 (data/translations.override.csv)
 * не теряется при перезапуске.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const BASE_URL = process.env.POLZA_BASE_URL ?? "https://polza.ai/api/v1";
const OUT_PATH = join(process.cwd(), "data", "translations.json");
const BATCH_SIZE = 50;

interface Translation {
  name_ru: string;
  synonyms: string[];
}

const SYSTEM_PROMPT = `Ты переводишь названия продуктов из базы USDA FoodData Central на русский язык.

Правила:
- name_ru — короткое узнаваемое русское название, как его напишет обычный человек
  («куриная грудка запечённая», а не «мясо птицы курица грудная часть без кожи»).
- synonyms — 2–4 варианта, которыми этот продукт могут назвать в быту, включая
  разговорные и региональные формы. Без повторов name_ru.
- Сохраняй важные уточнения из оригинала: способ приготовления, жирность, сырое/готовое.
- Не рассуждай. Верни только JSON.`;

async function loadDescriptions(limit: number): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const dir of ["sr_legacy", "foundation"]) {
    const path = join(process.cwd(), "data", "usda", dir, "food.csv");
    if (!existsSync(path)) continue;
    const parser = createReadStream(path).pipe(
      parse({ columns: true, skip_empty_lines: true, relax_quotes: true }),
    );
    for await (const row of parser) {
      const r = row as Record<string, string>;
      if (r.fdc_id && r.description) result.set(r.fdc_id, r.description);
      if (result.size >= limit) return result;
    }
  }
  return result;
}

async function translateBatch(
  batch: { fdc_id: string; description: string }[],
  model: string,
): Promise<Record<string, Translation>> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.POLZA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Переведи. Верни JSON вида {"<fdc_id>": {"name_ru": "...", "synonyms": ["...", "..."]}}.\n\n${batch
            .map((item) => `${item.fdc_id}: ${item.description}`)
            .join("\n")}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`polza.ai HTTP ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Пустой ответ модели");

  const cleaned = content
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```\s*$/, "");
  return JSON.parse(cleaned) as Record<string, Translation>;
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 20_000;
  const modelArg = args.indexOf("--model");
  // Дешёвая текстовая модель: перевод названий не требует мультимодальности.
  const model = modelArg >= 0 ? args[modelArg + 1] : "openai/gpt-5.1-mini";

  if (!process.env.POLZA_API_KEY) {
    throw new Error("POLZA_API_KEY не задан — положите ключ в .env.local");
  }

  const existing: Record<string, Translation> = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, "utf8"))
    : {};
  console.log(`Уже переведено: ${Object.keys(existing).length}`);

  const descriptions = await loadDescriptions(limit);
  const pending = [...descriptions.entries()]
    .filter(([fdcId]) => !existing[fdcId])
    .map(([fdc_id, description]) => ({ fdc_id, description }));

  console.log(`К переводу: ${pending.length} (модель ${model})`);
  if (pending.length === 0) return;

  mkdirSync(join(process.cwd(), "data"), { recursive: true });

  for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
    const batch = pending.slice(offset, offset + BATCH_SIZE);
    try {
      const translated = await translateBatch(batch, model);
      for (const [fdcId, value] of Object.entries(translated)) {
        if (value?.name_ru) {
          existing[fdcId] = {
            name_ru: value.name_ru,
            synonyms: Array.isArray(value.synonyms) ? value.synonyms : [],
          };
        }
      }
      // Пишем после каждого батча: прерванный на середине прогон не теряет
      // уже оплаченную работу.
      writeFileSync(OUT_PATH, JSON.stringify(existing, null, 1), "utf8");
      console.log(
        `  ${Math.min(offset + BATCH_SIZE, pending.length)}/${pending.length}`,
      );
    } catch (error) {
      console.error(`  батч ${offset} не прошёл:`, error);
    }
  }

  console.log(`Готово. Всего переводов: ${Object.keys(existing).length}`);
  console.log(
    "Дальше: выгрузите топ-500 частых продуктов, вычитайте руками и положите\n" +
      "правки в data/translations.override.csv (fdc_id,name_ru,synonyms) — они\n" +
      "имеют приоритет при импорте.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
