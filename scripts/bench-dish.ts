/**
 * Бенчмарк промпта v3-dish: насколько модели угадывают НАЗВАНИЕ блюда.
 *
 *   npx tsx scripts/bench-dish.ts [--models a,b,c] [--dishes 1,2] [--max-tokens 4000]
 *
 * Отдельный скрипт, а не флаг к bench-models.ts, потому что меряется другое.
 * Там — доля названных ингредиентов, правдоподобность массы и сходимость
 * масштабной цепочки. Здесь модель ингредиентов не называет вовсе, и вопросы к
 * ней такие:
 *
 *   схема    — приняла ли strict json_schema (критерий приёмки тикета 07)
 *   три      — вернула ли РОВНО три варианта, и различимы ли они между собой
 *   имя@1/@3 — попало ли ожидаемое название в первый вариант / в тройку
 *   справ.   — нашлись ли варианты в справочнике блюд (search_dishes)
 *   порция   — вернула ли размер порции
 *   цена и латентность — из usage ответа
 *
 * «Три различимых варианта» — не придирка к форме. Весь смысл экрана выбора в
 * том, что варианты РАЗНЫЕ; «борщ / борщ украинский / борщ с говядиной» — это
 * один вариант, показанный трижды, и выбирать там нечего.
 *
 * Результаты пишутся в fixtures/bench-dish-results.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import type { ModelConfig } from "../config/models";
import { computeCost, recognizeDish } from "../src/lib/llm/polza";

loadEnv({ path: ".env.local" });

const FIXTURES = join(process.cwd(), "fixtures");

/** Те же кандидаты, что в bench-models.ts (цены — ₽ за 1M токенов). */
const CANDIDATES = [
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", vendor: "anthropic" },
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash", vendor: "google" },
  { id: "openai/gpt-5.1", label: "GPT-5.1", vendor: "openai" },
  { id: "openai/gpt-5.6-luna-pro", label: "GPT-5.6 Luna Pro", vendor: "openai" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", vendor: "google" },
  { id: "qwen/qwen3-vl-235b-a22b-instruct", label: "Qwen3-VL 235B", vendor: "alibaba" },
  { id: "qwen/qwen3.6-flash", label: "Qwen3.6 Flash", vendor: "alibaba" },
  { id: "x-ai/grok-4.5", label: "Grok 4.5", vendor: "xai" },
  { id: "thinkingmachines/inkling", label: "Inkling", vendor: "thinkingmachines" },
  { id: "google/gemma-4-31b-it", label: "Gemma 4 31B", vendor: "google" },
  { id: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", vendor: "google" },
];

/**
 * Ожидаемые названия, размечены руками по тем же фотографиям, что и
 * fixtures/expectations.json. Группа синонимов засчитывается целиком: блюдо
 * можно назвать по-разному, и «куриное филе» против «жареной курицы» — это не
 * разные ответы, а одно и то же.
 */
const EXPECTED: Record<string, string[]> = {
  "sent-dish-1.jpg": ["куриное филе", "куриная грудка", "курин", "курица"],
  "sent-dish-2.jpg": ["цезарь"],
  "sent-dish-3.jpg": ["борщ", "свекольник"],
  "sent-dish-4.jpg": ["яичница", "глазунья", "бекон", "завтрак"],
  "sent-dish-5.jpg": ["болоньезе", "спагетти", "паста", "макарон"],
};

interface DishRow {
  dish: string;
  ok: boolean;
  error: string | null;
  schemaStrict: boolean;
  candidates: string[];
  distinct: boolean;
  hitAt1: boolean;
  hitAt3: boolean;
  catalogMatched: number;
  catalogNames: string[];
  portionSize: string | null;
  latencyMs: number;
  costRub: number | null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function hits(name: string, keywords: string[]): boolean {
  const n = normalize(name);
  return keywords.some((k) => n.includes(normalize(k)));
}

/**
 * Различимость: два названия считаются одним вариантом, если одно содержится в
 * другом («борщ» и «борщ украинский») — ровно тот случай, который промпт
 * запрещает.
 */
function areDistinct(names: string[]): boolean {
  const n = names.map(normalize);
  for (let i = 0; i < n.length; i += 1) {
    for (let j = i + 1; j < n.length; j += 1) {
      if (n[i].includes(n[j]) || n[j].includes(n[i])) return false;
    }
  }
  return true;
}

async function catalogLookup(
  db: SupabaseClient | null,
  names: string[],
): Promise<{ matched: number; found: string[] }> {
  if (!db) return { matched: 0, found: [] };
  const found: string[] = [];
  for (const name of names) {
    const { data, error } = await db.rpc("search_dishes", { q: name, max_results: 1 });
    if (error || !data?.length) continue;
    if (Number(data[0].match_score) >= 0.3) found.push(data[0].name_ru as string);
  }
  return { matched: found.length, found };
}

async function benchOne(
  model: ModelConfig,
  file: string,
  db: SupabaseClient | null,
): Promise<DishRow> {
  const imageBase64 = readFileSync(join(FIXTURES, file)).toString("base64");
  const result = await recognizeDish({ model, imageBase64 });
  const cost = computeCost(result.usage, model.vendorPricing);
  const base = {
    dish: file,
    schemaStrict: !result.usedJsonObjectFallback,
    latencyMs: result.latencyMs,
    costRub: cost.cost_rub_actual,
  };

  if (result.status === "failed" || !result.guess) {
    return {
      ...base,
      ok: false,
      error: result.errorText,
      candidates: [],
      distinct: false,
      hitAt1: false,
      hitAt3: false,
      catalogMatched: 0,
      catalogNames: [],
      portionSize: null,
    };
  }

  // Схема не может потребовать ровно три (minItems вырезается перед отправкой),
  // поэтому «три» — это измеряемый признак, а не данность.
  const names = result.guess.dish_candidates.map((c) => c.name_ru);
  const keywords = EXPECTED[file] ?? [];
  const catalog = await catalogLookup(db, names);

  return {
    ...base,
    ok: true,
    error: null,
    candidates: names,
    distinct: names.length === 3 && areDistinct(names),
    hitAt1: names.length > 0 && hits(names[0], keywords),
    hitAt3: names.some((n) => hits(n, keywords)),
    catalogMatched: catalog.matched,
    catalogNames: catalog.found,
    portionSize: result.guess.portion_size,
  };
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

async function main() {
  if (!process.env.POLZA_API_KEY) {
    throw new Error("POLZA_API_KEY не задан — положите ключ в .env.local");
  }

  const args = process.argv.slice(2);
  const pick = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const maxTokens = Number(pick("--max-tokens") ?? 4000);
  const modelsArg = pick("--models");
  const dishesArg = pick("--dishes");

  const selected = modelsArg
    ? CANDIDATES.filter((c) => modelsArg.split(",").includes(c.id))
    : CANDIDATES;

  const files = Object.keys(EXPECTED).filter(
    (_, i) => !dishesArg || dishesArg.split(",").includes(String(i + 1)),
  );

  // Справочник нужен, чтобы померить не только «модель угадала», но и «мы это
  // название нашли». Без базы бенчмарк всё равно осмыслен, поэтому не падаем.
  let db: SupabaseClient | null = null;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
  } else {
    console.log("справочник недоступен — колонка «справ.» будет пустой\n");
  }

  console.log(`моделей: ${selected.length}, фото: ${files.length}, промпт v3-dish\n`);

  const report: Record<string, DishRow[]> = {};

  for (const candidate of selected) {
    const model: ModelConfig = {
      ...candidate,
      enabled: true,
      imageDetail: "high",
      maxTokens,
      temperature: 0.2,
      promptVersion: "v3-dish",
      vendorPricing: null,
    };

    const rows = await mapLimited(files, 3, (file) => benchOne(model, file, db));
    report[candidate.id] = rows;

    const ok = rows.filter((r) => r.ok);
    const n = rows.length;
    const cost = rows.reduce((s, r) => s + (r.costRub ?? 0), 0);
    const latency = Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / n / 1000);

    console.log(
      `${candidate.label.padEnd(26)} ` +
        `сбоев ${String(n - ok.length).padStart(2)}  ` +
        `схема ${pct(rows.filter((r) => r.schemaStrict).length / n).padStart(4)}  ` +
        `три ${pct(rows.filter((r) => r.distinct).length / n).padStart(4)}  ` +
        `n̄ ${(rows.reduce((s, r) => s + r.candidates.length, 0) / n).toFixed(1)}  ` +
        `имя@1 ${pct(rows.filter((r) => r.hitAt1).length / n).padStart(4)}  ` +
        `имя@3 ${pct(rows.filter((r) => r.hitAt3).length / n).padStart(4)}  ` +
        `справ. ${(
          (rows.reduce((s, r) => s + r.catalogMatched, 0) /
            Math.max(rows.reduce((s, r) => s + r.candidates.length, 0), 1)) *
          100
        ).toFixed(0).padStart(3)}%  ` +
        `${String(latency).padStart(3)}с  ${cost.toFixed(2)}₽`,
    );
    for (const row of rows) {
      const mark = row.ok ? (row.hitAt1 ? "✓" : row.hitAt3 ? "~" : "×") : "!";
      console.log(
        `   ${mark} ${row.dish}: ${row.candidates.join(" / ") || row.error}` +
          (row.portionSize ? `  [${row.portionSize}]` : ""),
      );
    }
    console.log();
  }

  writeFileSync(
    join(FIXTURES, "bench-dish-results.json"),
    JSON.stringify(report, null, 1),
    "utf8",
  );
  console.log("результаты → fixtures/bench-dish-results.json");
}

main();
