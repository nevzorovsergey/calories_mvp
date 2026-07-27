/**
 * Бенчмарк моделей на реальных фотографиях блюд.
 *
 *   npx tsx scripts/bench-models.ts [--models a,b,c] [--dishes 1,2] [--prompt v2-scale]
 *
 * Гоняет каждую модель-кандидата по всем фото из fixtures/ и сравнивает не
 * «на глаз», а по проверяемым признакам:
 *
 *   схема   — приняла ли модель strict json_schema или пришлось падать на json_object
 *   состав  — доля обязательных ингредиентов из fixtures/expectations.json, которые
 *             модель действительно назвала (размеченo вручную, глазами)
 *   вес     — попал ли суммарный вес в здравый диапазон
 *   эталон  — нашла ли предмет известного размера там, где он реально есть
 *   цепочка — сходятся ли числа scale_chain между собой (§7.5.2)
 *   цена и латентность — из usage ответа
 *
 * Это не бенчмарк «кто умнее», а отбор моделей, пригодных для сбора датасета:
 * важнее предсказуемый разбор состава, чем красивая итоговая цифра.
 *
 * Результаты пишутся в fixtures/bench-results.json — их можно перечитать без
 * повторных трат.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import type { ModelConfig, PromptVersion } from "../config/models";
import { computeCost, recognizeDish } from "../src/lib/llm/polza";
import { runScaleChecks } from "../src/lib/llm/scale-check";
import type { DishAnalysis } from "../src/lib/llm/schema";

loadEnv({ path: ".env.local" });

const FIXTURES = join(process.cwd(), "fixtures");

/** Кандидаты: разные вендоры и разные ценовые уровни (цены — ₽ за 1M токенов). */
const CANDIDATES: { id: string; label: string; vendor: string; priceNote: string }[] = [
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", vendor: "anthropic", priceNote: "212 / 1062" },
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash", vendor: "google", priceNote: "159 / 797" },
  { id: "openai/gpt-5.1", label: "GPT-5.1", vendor: "openai", priceNote: "133 / 1062" },
  { id: "openai/gpt-5.6-luna-pro", label: "GPT-5.6 Luna Pro", vendor: "openai", priceNote: "106 / 636" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", vendor: "google", priceNote: "53 / 319" },
  { id: "qwen/qwen3-vl-235b-a22b-instruct", label: "Qwen3-VL 235B", vendor: "alibaba", priceNote: "28 / 110" },
  { id: "qwen/qwen3.6-flash", label: "Qwen3.6 Flash", vendor: "alibaba", priceNote: "20 / 119" },
  { id: "x-ai/grok-4.5", label: "Grok 4.5", vendor: "xai", priceNote: "212 / 637" },
  { id: "thinkingmachines/inkling", label: "Inkling", vendor: "thinkingmachines", priceNote: "106 / 430" },
  { id: "google/gemma-4-31b-it", label: "Gemma 4 31B", vendor: "google", priceNote: "13 / 39" },
  { id: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", vendor: "google", priceNote: "6 / 35" },
];

interface Expectation {
  file: string;
  title: string;
  required: string[][];
  optional: string[][];
  weightRange: [number, number];
  container: string[];
  scaleReference: string | null;
}

interface DishResult {
  dish: string;
  ok: boolean;
  error: string | null;
  schemaStrict: boolean;
  ingredients: number;
  matchedRequired: number;
  totalRequired: number;
  missing: string[];
  totalWeight: number | null;
  weightPlausible: boolean;
  container: string | null;
  scaleRefFound: boolean | null;
  scaleMode: string | null;
  chainFlags: string[];
  latencyMs: number;
  costRub: number | null;
  names: string[];
}

function matchesGroup(analysis: DishAnalysis, group: string[]): boolean {
  const haystack = analysis.ingredients
    .map((i) => `${i.name_ru} ${i.name_en}`.toLowerCase())
    .join(" | ");
  return group.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

async function benchOne(
  model: ModelConfig,
  expectation: Expectation,
): Promise<DishResult> {
  const imageBase64 = readFileSync(join(FIXTURES, expectation.file)).toString("base64");
  const result = await recognizeDish({ model, imageBase64 });
  const cost = computeCost(result.usage, model.vendorPricing);

  if (result.status === "failed" || !result.analysis) {
    return {
      dish: expectation.file,
      ok: false,
      error: result.errorText,
      schemaStrict: !result.usedJsonObjectFallback,
      ingredients: 0,
      matchedRequired: 0,
      totalRequired: expectation.required.length,
      missing: expectation.required.map((g) => g[0]),
      totalWeight: null,
      weightPlausible: false,
      container: null,
      scaleRefFound: null,
      scaleMode: null,
      chainFlags: [],
      latencyMs: result.latencyMs,
      costRub: cost.cost_rub_actual,
      names: [],
    };
  }

  const analysis = result.analysis;
  const missing = expectation.required
    .filter((group) => !matchesGroup(analysis, group))
    .map((group) => group[0]);
  const scale = runScaleChecks(analysis, []);

  return {
    dish: expectation.file,
    ok: true,
    error: null,
    schemaStrict: !result.usedJsonObjectFallback,
    ingredients: analysis.ingredients.length,
    matchedRequired: expectation.required.length - missing.length,
    totalRequired: expectation.required.length,
    missing,
    totalWeight: analysis.total_weight_g,
    weightPlausible:
      analysis.total_weight_g >= expectation.weightRange[0] &&
      analysis.total_weight_g <= expectation.weightRange[1],
    container: analysis.container.type,
    // Эталон засчитываем только там, где он реально есть в кадре.
    scaleRefFound: expectation.scaleReference
      ? analysis.scale_references.some((r) => r.type === expectation.scaleReference)
      : null,
    scaleMode: analysis.scale_chain?.scale_mode ?? null,
    chainFlags: scale.consistency_flags,
    latencyMs: result.latencyMs,
    costRub: cost.cost_rub_actual,
    names: analysis.ingredients.map((i) => `${i.name_ru} ${Math.round(i.weight_g)}г`),
  };
}

/** Ограниченный параллелизм: 30 vision-запросов подряд — это полчаса ожидания. */
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

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

async function main() {
  if (!process.env.POLZA_API_KEY) {
    throw new Error("POLZA_API_KEY не задан — положите ключ в .env.local");
  }

  const args = process.argv.slice(2);
  const modelsArg = args.indexOf("--models");
  const dishesArg = args.indexOf("--dishes");
  const promptArg = args.indexOf("--prompt");
  const promptVersion = (promptArg >= 0 ? args[promptArg + 1] : "v2-scale") as PromptVersion;
  // Рассуждающим моделям 4000 токенов может не хватить: размышления съедают
  // лимит, и ответ приходит пустым. Тогда прогон повторяют с большим лимитом.
  const maxTokensArg = args.indexOf("--max-tokens");
  const maxTokens = maxTokensArg >= 0 ? Number(args[maxTokensArg + 1]) : 4000;

  const selected =
    modelsArg >= 0
      ? CANDIDATES.filter((c) => args[modelsArg + 1].split(",").includes(c.id))
      : CANDIDATES;

  const expectationsFile = JSON.parse(
    readFileSync(join(FIXTURES, "expectations.json"), "utf8"),
  ) as { dishes: Expectation[] };
  const dishes =
    dishesArg >= 0
      ? expectationsFile.dishes.filter((_, i) =>
          args[dishesArg + 1].split(",").includes(String(i + 1)),
        )
      : expectationsFile.dishes;

  console.log(
    `Моделей: ${selected.length}, фото: ${dishes.length}, промпт: ${promptVersion}\n` +
      `Всего запросов: ${selected.length * dishes.length}\n`,
  );

  const jobs = selected.flatMap((candidate) =>
    dishes.map((dish) => ({ candidate, dish })),
  );

  const started = Date.now();
  const raw = await mapLimited(jobs, 4, async ({ candidate, dish }) => {
    const model: ModelConfig = {
      id: candidate.id,
      label: candidate.label,
      vendor: candidate.vendor,
      enabled: true,
      imageDetail: "high",
      maxTokens,
      temperature: 0.2,
      promptVersion,
      vendorPricing: null,
    };
    const result = await benchOne(model, dish);
    process.stdout.write(
      `${result.ok ? "✓" : "✗"} ${candidate.label} · ${dish.file}` +
        `${result.ok ? ` — ${result.matchedRequired}/${result.totalRequired} состав, ${result.totalWeight} г, ${(result.latencyMs / 1000).toFixed(0)} с` : ` — ${result.error?.slice(0, 90)}`}\n`,
    );
    return { model: candidate, result };
  });

  console.log(`\nВсего заняло ${((Date.now() - started) / 1000).toFixed(0)} с\n`);

  // ── Сводная таблица ───────────────────────────────────────────────────────
  const summary = selected.map((candidate) => {
    const rows = raw.filter((r) => r.model.id === candidate.id).map((r) => r.result);
    const ok = rows.filter((r) => r.ok);
    const recall =
      ok.length > 0
        ? ok.reduce((s, r) => s + r.matchedRequired / r.totalRequired, 0) / ok.length
        : 0;
    const withRef = ok.filter((r) => r.scaleRefFound !== null);
    return {
      candidate,
      // Лимит записываем в строку модели, а не в шапку файла: медленным моделям
      // его поднимают отдельно, и в сводной таблице должно быть видно, кого
      // мерили в других условиях.
      maxTokens,
      runs: rows.length,
      failures: rows.length - ok.length,
      strictSchema: rows.every((r) => r.schemaStrict),
      recall,
      weightOk: ok.length > 0 ? ok.filter((r) => r.weightPlausible).length / ok.length : 0,
      avgIngredients:
        ok.length > 0 ? ok.reduce((s, r) => s + r.ingredients, 0) / ok.length : 0,
      refDetect:
        withRef.length > 0
          ? withRef.filter((r) => r.scaleRefFound === true).length / withRef.length
          : null,
      chainOk:
        ok.length > 0 ? ok.filter((r) => r.chainFlags.length === 0).length / ok.length : 0,
      avgLatency: ok.length > 0 ? ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length : 0,
      avgCost:
        ok.filter((r) => r.costRub !== null).length > 0
          ? ok.reduce((s, r) => s + (r.costRub ?? 0), 0) /
            ok.filter((r) => r.costRub !== null).length
          : null,
    };
  });

  const header = [
    "Модель".padEnd(26),
    "цена ₽/1M".padEnd(12),
    "сбой",
    "strict",
    "состав",
    "вес",
    "поз.",
    "эталон",
    "цепочка",
    "сек",
    "₽/шт",
  ].join(" ");
  console.log(header);
  console.log("─".repeat(header.length + 8));

  for (const s of summary.sort((a, b) => b.recall - a.recall)) {
    console.log(
      [
        s.candidate.label.padEnd(26),
        s.candidate.priceNote.padEnd(12),
        String(s.failures).padEnd(4),
        (s.strictSchema ? "да" : "нет").padEnd(6),
        pct(s.recall).padEnd(6),
        pct(s.weightOk).padEnd(4),
        s.avgIngredients.toFixed(1).padEnd(4),
        (s.refDetect === null ? "—" : pct(s.refDetect)).padEnd(6),
        pct(s.chainOk).padEnd(7),
        (s.avgLatency / 1000).toFixed(0).padEnd(3),
        s.avgCost !== null ? s.avgCost.toFixed(2) : "—",
      ].join(" "),
    );
  }

  console.log(
    "\nсостав — доля обязательных ингредиентов, названных моделью;\n" +
      "вес — доля фото, где суммарная масса попала в здравый диапазон;\n" +
      "поз. — среднее число ингредиентов в ответе;\n" +
      "эталон — нашла ли предмет известного размера там, где он есть;\n" +
      "цепочка — доля ответов, где числа scale_chain сходятся между собой.",
  );

  // ── Что именно назвали ────────────────────────────────────────────────────
  for (const dish of dishes) {
    console.log(`\n=== ${dish.title} (${dish.file}) ===`);
    for (const { model, result } of raw.filter((r) => r.result.dish === dish.file)) {
      if (!result.ok) {
        console.log(`  ${model.label.padEnd(26)} ✗ ${result.error?.slice(0, 120)}`);
        continue;
      }
      console.log(
        `  ${model.label.padEnd(26)} ${result.totalWeight}г  ${result.names.join(", ")}`,
      );
      if (result.missing.length > 0) {
        console.log(`  ${" ".repeat(26)} не назвала: ${result.missing.join(", ")}`);
      }
    }
  }

  writeFileSync(
    join(FIXTURES, "bench-results.json"),
    JSON.stringify({ promptVersion, ranAt: new Date().toISOString(), raw, summary }, null, 1),
    "utf8",
  );
  console.log("\nПодробности: fixtures/bench-results.json");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
