/**
 * Прогон активных моделей по базовой выборке January Food Benchmark.
 *
 *   npx tsx scripts/bench-jfb.ts [--models a,b] [--items fsb_00000,fsb_00437]
 *                                [--concurrency 4] [--max-tokens 4000]
 *
 * Отличие от scripts/bench-models.ts: там пять своих фотографий с ручной
 * разметкой «какие ингредиенты обязаны быть названы», здесь — 20 фото из JFB
 * (fixtures/jfb-baseline-20.json), где у каждого блюда есть покомпонентная
 * раскладка с калориями. Это позволяет мерить не только «назвала/не назвала»,
 * а числовое расхождение.
 *
 * Что считаем:
 *
 *   калории — Σ(weight_g · kcal_per_100g / 100) против total_calories из JFB.
 *             Единственная метрика с прямым эталоном.
 *
 *   масса   — прямого эталона нет: JFB даёт «0.6 cup», «1 slice», «1 piece»,
 *             а не граммы. Опорную массу восстанавливаем через калорийность:
 *             для каждого ингредиента, который модель назвала, делим калории
 *             JFB на kcal_per_100g этой же модели. Получается «сколько граммов
 *             этого продукта нужно, чтобы вышла калорийность эталона» — при
 *             условии, что модель не ошиблась в самом продукте. Метрика
 *             отделяет ошибку порции от ошибки в выборе продукта, но она
 *             производная, а не измерение. Считаем только там, где модель
 *             покрыла ≥60% калорий эталона (иначе экстраполяция слишком дикая).
 *
 *   состав  — «основными» считаем ингредиенты JFB, дающие ≥15% калорий блюда.
 *             Их пропуск и есть значительное отклонение состава. Отдельно
 *             считаем обратную ошибку: позиции, которых в эталоне нет, а
 *             модель дала им ≥15% калорий блюда.
 *
 * Сопоставление ингредиентов — по name_en, нестрогое (общий значимый корень
 * или синоним из таблицы ниже). Все несопоставленные пары печатаются в конце,
 * чтобы дефекты сопоставления было видно глазами, а не только в проценте.
 *
 * Результаты — fixtures/jfb-bench-results.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { getEnabledModels, variantKey, type ModelConfig } from "../config/models";
import { computeCost, recognizeDish } from "../src/lib/llm/polza";
import type { DishAnalysis } from "../src/lib/llm/schema";

loadEnv({ path: ".env.local" });

const ROOT = process.cwd();
const MANIFEST = join(ROOT, "fixtures", "jfb-baseline-20.json");
const OUT = join(ROOT, "fixtures", "jfb-bench-results.json");

/** Доля калорий блюда, начиная с которой ингредиент считается основным. */
const MAJOR_SHARE = 0.15;
/** Минимальное покрытие калорий эталона, при котором опорная масса осмысленна. */
const MIN_KCAL_COVERAGE = 0.6;

interface ManifestIngredient {
  name: string;
  quantity: number;
  unit: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface ManifestItem {
  image_id: string;
  file: string;
  category: string;
  title_ru: string;
  meal_name: string;
  note: string;
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  ingredients: ManifestIngredient[];
}

// ── Сопоставление названий ──────────────────────────────────────────────────

/**
 * Слова, которые ничего не говорят о продукте: если оставить их значимыми,
 * «grilled chicken» совпадёт с «grilled vegetables» по слову grilled.
 */
const STOPWORDS = new Set([
  "fresh", "raw", "cooked", "grilled", "roasted", "baked", "fried", "steamed",
  "boiled", "sauteed", "sautéed", "mixed", "sliced", "chopped", "diced",
  "shredded", "crumbled", "whole", "large", "medium", "small", "with", "and",
  "of", "in", "on", "the", "a", "style", "homemade", "plain", "light", "low",
  "fat", "free", "extra", "virgin", "ground", "assorted", "side",
]);
// «dressing» намеренно НЕ в стоп-словах: заправка — отдельная позиция с
// заметной калорийностью, и «greek dressing» против «ranch dressing» — это
// один и тот же слот блюда, а не разные ингредиенты. Пока слово было
// стоп-словом, ни одна заправка не сопоставлялась ни с чем.

/**
 * Пары, которые по словам не пересекаются, а по сути — одно и то же.
 * Список ведётся руками по итогам прогонов: см. «не сопоставлено» в выводе.
 */
const SYNONYMS: [string, string][] = [
  ["dough", "crust"],
  ["dough", "pizza"],
  ["crust", "pastry"],
  ["mozzarella", "cheese"],
  ["parmesan", "cheese"],
  ["feta", "cheese"],
  ["cheddar", "cheese"],
  ["ricotta", "cheese"],
  ["mayonnaise", "mayo"],
  ["arborio", "rice"],
  ["pasta", "noodle"],
  ["pasta", "lasagna"],
  ["pasta", "spaghetti"],
  ["pasta", "penne"],
  ["sushi", "rice"],
  ["sushi", "roll"],
  ["maki", "roll"],
  ["nigiri", "rice"],
  ["nigiri", "salmon"],
  ["nigiri", "tuna"],
  ["roe", "caviar"],
  ["ikura", "roe"],
  ["prawn", "shrimp"],
  ["scallion", "onion"],
  ["romaine", "lettuce"],
  ["arugula", "greens"],
  ["greens", "lettuce"],
  ["salad", "lettuce"],
  ["aubergine", "eggplant"],
  ["courgette", "zucchini"],
  ["garbanzo", "chickpeas"],
  ["chickpeas", "beans"],
  ["cilantro", "coriander"],
  ["broth", "stock"],
  ["stock", "soup"],
  ["bouillon", "broth"],
  ["cream", "milk"],
  ["yoghurt", "yogurt"],
  ["fondant", "cake"],
  ["ganache", "chocolate"],
  ["cocoa", "chocolate"],
  ["patty", "beef"],
  ["patty", "burger"],
  ["bun", "bread"],
  ["toast", "bread"],
  ["tortilla", "chips"],
  ["fries", "potatoes"],
  ["wedges", "potatoes"],
  ["crisps", "potatoes"],
  ["prosciutto", "ham"],
  ["bacon", "pork"],
  ["asparagus", "spears"],
  ["berries", "berry"],
  ["strawberry", "strawberries"],
  ["blueberry", "blueberries"],
  ["mango", "fruit"],
  ["oil", "olive"],
  ["butter", "spread"],
];

/**
 * Приправы и жиры, которые модели дописывают в состав чаще всего. JFB их не
 * разносит по позициям, поэтому в эталоне их нет почти никогда — а масло, в
 * отличие от соли, стоит сотню килокалорий на ложку.
 */
const CONDIMENTS =
  /\b(oil|butter|sugar|salt|pepper|mayonnaise|mayo|dressing|sauce|syrup|honey|cream|vinegar|seasoning|spice)/i;

function tokens(name: string): Set<string> {
  const parts = name
    .toLowerCase()
    .replace(/[^a-zа-яё]+/gi, " ")
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    // Грубая нормализация числа: cheeses → cheese, berries → berri.
    .map((w) => w.replace(/ies$/, "i").replace(/([^s])s$/, "$1"));
  return new Set(parts);
}

function synonymLinked(a: Set<string>, b: Set<string>): boolean {
  return SYNONYMS.some(
    ([x, y]) =>
      (a.has(x) && b.has(y)) || (a.has(y) && b.has(x)),
  );
}

function namesMatch(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  for (const t of ta) if (tb.has(t)) return true;
  // Вхождение подстрокой ловит «salmon» ↔ «salmon nigiri» после нормализации.
  for (const t of ta) for (const u of tb) if (t.length > 3 && (t.includes(u) || u.includes(t))) return true;
  return synonymLinked(ta, tb);
}

// ── Метрики одного прогона ──────────────────────────────────────────────────

interface ItemResult {
  imageId: string;
  category: string;
  title: string;
  ok: boolean;
  error: string | null;
  schemaStrict: boolean;

  refKcal: number;
  modelKcal: number | null;
  kcalErrPct: number | null;

  modelWeightG: number | null;
  /** Опорная масса, восстановленная через калорийность (см. шапку файла). */
  impliedRefG: number | null;
  kcalCoverage: number | null;
  massErrPct: number | null;

  majorTotal: number;
  majorFound: number;
  majorMissed: string[];
  /** Позиции модели с ≥15% калорий, которых нет в эталоне. */
  majorExtra: string[];
  /**
   * Доля калорий ответа, пришедшая с позициями, которых в эталоне нет вообще.
   * Отвечает на вопрос «модель ошиблась в порции или дописала масло в состав»:
   * первое чинится выбором модели, второе — промптом.
   */
  extraKcalShare: number | null;
  /** То же, но только по маслу, сахару и соусам — самой частой приписке. */
  condimentKcalShare: number | null;
  unmatchedRef: string[];
  unmatchedModel: string[];

  ingredients: number;
  latencyMs: number;
  costRub: number | null;
  names: string[];
  /**
   * Покомпонентный ответ модели как есть. Хранится ради пересчёта метрик без
   * повторного обращения к API: правка таблицы синонимов или порога MAJOR_SHARE
   * не должна стоить ещё одного прогона на сто запросов.
   */
  modelIngredients: { name_en: string; name_ru: string; weight_g: number; kcal_per_100g: number; kcal: number }[];
}

function scoreOne(item: ManifestItem, analysis: DishAnalysis): Omit<
  ItemResult,
  "imageId" | "category" | "title" | "ok" | "error" | "schemaStrict" | "latencyMs" | "costRub"
> {
  const modelIngredients = analysis.ingredients.map((i) => ({
    ...i,
    kcal: (i.weight_g * i.kcal_per_100g) / 100,
  }));
  const modelKcal = modelIngredients.reduce((s, i) => s + i.kcal, 0);
  const refKcal = item.totals.kcal;

  // Жадное сопоставление: каждый эталонный ингредиент забирает первую
  // подходящую позицию модели, повторно она уже не используется.
  const takenByModelIndex = new Set<number>();
  const pairs: { ref: ManifestIngredient; modelIndex: number }[] = [];
  for (const ref of item.ingredients) {
    const index = modelIngredients.findIndex(
      (m, i) => !takenByModelIndex.has(i) && namesMatch(ref.name, m.name_en),
    );
    if (index >= 0) {
      takenByModelIndex.add(index);
      pairs.push({ ref, modelIndex: index });
    }
  }

  const matchedRefKcal = pairs.reduce((s, p) => s + p.ref.kcal, 0);
  const kcalCoverage = refKcal > 0 ? matchedRefKcal / refKcal : 0;

  // Опорная масса: сколько граммов продукта нужно, чтобы по мнению самой
  // модели выйти на калорийность эталона. Ненайденные ингредиенты добираем
  // пропорционально их доле калорий — иначе занизили бы эталон.
  let impliedMatchedG = 0;
  let usableKcal = 0;
  for (const { ref, modelIndex } of pairs) {
    const density = modelIngredients[modelIndex].kcal_per_100g;
    if (density <= 0) continue;
    impliedMatchedG += (ref.kcal / density) * 100;
    usableKcal += ref.kcal;
  }
  const impliedRefG =
    kcalCoverage >= MIN_KCAL_COVERAGE && usableKcal > 0
      ? (impliedMatchedG * refKcal) / usableKcal
      : null;

  const major = item.ingredients.filter((i) => i.kcal / refKcal >= MAJOR_SHARE);
  const majorFound = major.filter((m) => pairs.some((p) => p.ref === m));
  const majorExtra = modelIngredients
    .filter((m, i) => !takenByModelIndex.has(i) && modelKcal > 0 && m.kcal / modelKcal >= MAJOR_SHARE)
    .map((m) => `${m.name_en} ${Math.round(m.kcal)} ккал`);

  const extras = modelIngredients.filter((_, i) => !takenByModelIndex.has(i));
  const extraKcal = extras.reduce((s, m) => s + m.kcal, 0);
  const condimentKcal = extras
    .filter((m) => CONDIMENTS.test(m.name_en))
    .reduce((s, m) => s + m.kcal, 0);

  return {
    refKcal,
    modelKcal: Math.round(modelKcal * 10) / 10,
    kcalErrPct: refKcal > 0 ? (modelKcal - refKcal) / refKcal : null,
    modelWeightG: analysis.total_weight_g,
    impliedRefG: impliedRefG === null ? null : Math.round(impliedRefG),
    kcalCoverage: Math.round(kcalCoverage * 100) / 100,
    massErrPct:
      impliedRefG && impliedRefG > 0
        ? (analysis.total_weight_g - impliedRefG) / impliedRefG
        : null,
    majorTotal: major.length,
    majorFound: majorFound.length,
    majorMissed: major
      .filter((m) => !majorFound.includes(m))
      .map((m) => `${m.name} (${Math.round((m.kcal / refKcal) * 100)}% ккал)`),
    majorExtra,
    extraKcalShare: modelKcal > 0 ? Math.round((extraKcal / modelKcal) * 1000) / 1000 : null,
    condimentKcalShare: modelKcal > 0 ? Math.round((condimentKcal / modelKcal) * 1000) / 1000 : null,
    unmatchedRef: item.ingredients.filter((r) => !pairs.some((p) => p.ref === r)).map((r) => r.name),
    unmatchedModel: modelIngredients.filter((_, i) => !takenByModelIndex.has(i)).map((m) => m.name_en),
    ingredients: modelIngredients.length,
    names: modelIngredients.map((i) => `${i.name_ru} ${Math.round(i.weight_g)}г`),
    modelIngredients: modelIngredients.map((i) => ({
      name_en: i.name_en,
      name_ru: i.name_ru,
      weight_g: i.weight_g,
      kcal_per_100g: i.kcal_per_100g,
      kcal: Math.round(i.kcal * 10) / 10,
    })),
  };
}

// ── Прогон ──────────────────────────────────────────────────────────────────

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(value: number | null, digits = 0): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  if (!process.env.POLZA_API_KEY) {
    throw new Error("POLZA_API_KEY не задан — положите ключ в .env.local");
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { items: ManifestItem[] };
  const itemsArg = arg("items");
  const items = itemsArg
    ? manifest.items.filter((i) => itemsArg.split(",").includes(i.image_id))
    : manifest.items;

  const modelsArg = arg("models");
  const models = getEnabledModels().filter(
    (m) => !modelsArg || modelsArg.split(",").includes(m.id),
  );

  const maxTokensOverride = arg("max-tokens");
  const concurrency = Number(arg("concurrency") ?? 4);

  console.log(
    `Моделей: ${models.length} (${models.map((m) => m.label).join(", ")})\n` +
      `Фото: ${items.length}\nВсего запросов: ${models.length * items.length}\n`,
  );

  const jobs = models.flatMap((model) => items.map((item) => ({ model, item })));
  const started = Date.now();

  const raw = await mapLimited(jobs, concurrency, async ({ model, item }) => {
    const effective: ModelConfig = maxTokensOverride
      ? { ...model, maxTokens: Number(maxTokensOverride) }
      : model;
    const imageBase64 = readFileSync(join(ROOT, item.file)).toString("base64");
    const response = await recognizeDish({ model: effective, imageBase64 });
    const cost = computeCost(response.usage, model.vendorPricing);

    const base = {
      imageId: item.image_id,
      category: item.category,
      title: item.title_ru,
      schemaStrict: !response.usedJsonObjectFallback,
      latencyMs: response.latencyMs,
      costRub: cost.cost_rub_actual,
    };

    let result: ItemResult;
    if (response.status === "failed" || !response.analysis) {
      result = {
        ...base,
        ok: false,
        error: response.errorText,
        refKcal: item.totals.kcal,
        modelKcal: null,
        kcalErrPct: null,
        modelWeightG: null,
        impliedRefG: null,
        kcalCoverage: null,
        massErrPct: null,
        majorTotal: item.ingredients.filter((i) => i.kcal / item.totals.kcal >= MAJOR_SHARE).length,
        majorFound: 0,
        majorMissed: [],
        majorExtra: [],
        extraKcalShare: null,
        condimentKcalShare: null,
        unmatchedRef: [],
        unmatchedModel: [],
        ingredients: 0,
        names: [],
        modelIngredients: [],
      };
    } else {
      result = { ...base, ok: true, error: null, ...scoreOne(item, response.analysis) };
    }

    process.stdout.write(
      `${result.ok ? "✓" : "✗"} ${model.label.padEnd(28)} ${item.image_id} ${item.title_ru.padEnd(34).slice(0, 34)} ` +
        (result.ok
          ? `ккал ${pct(result.kcalErrPct)}  масса ${pct(result.massErrPct)}  основные ${result.majorFound}/${result.majorTotal}\n`
          : `${result.error?.slice(0, 80)}\n`),
    );
    return { modelId: model.id, promptVersion: model.promptVersion, label: model.label, result };
  });

  console.log(`\nВсего заняло ${((Date.now() - started) / 1000).toFixed(0)} с\n`);

  // ── Сводка ────────────────────────────────────────────────────────────────
  const summary = models.map((model) => {
    const rows = raw
      .filter((r) => variantKey(r.modelId, r.promptVersion) === variantKey(model.id, model.promptVersion))
      .map((r) => r.result);
    const ok = rows.filter((r) => r.ok);
    const kcalErrs = ok.map((r) => r.kcalErrPct).filter((v): v is number => v !== null);
    const massErrs = ok.map((r) => r.massErrPct).filter((v): v is number => v !== null);
    const majorTotal = ok.reduce((s, r) => s + r.majorTotal, 0);
    const majorFound = ok.reduce((s, r) => s + r.majorFound, 0);

    return {
      label: model.label,
      modelId: model.id,
      promptVersion: model.promptVersion,
      runs: rows.length,
      failures: rows.length - ok.length,
      strictSchema: rows.every((r) => r.schemaStrict),
      kcalMedianAbs: median(kcalErrs.map(Math.abs)),
      kcalBias: median(kcalErrs),
      kcalWithin25: kcalErrs.length ? kcalErrs.filter((v) => Math.abs(v) <= 0.25).length / kcalErrs.length : null,
      massMedianAbs: median(massErrs.map(Math.abs)),
      massBias: median(massErrs),
      massSamples: massErrs.length,
      majorRecall: majorTotal ? majorFound / majorTotal : null,
      majorExtraPerDish: ok.length ? ok.reduce((s, r) => s + r.majorExtra.length, 0) / ok.length : null,
      extraKcalShare: median(ok.map((r) => r.extraKcalShare).filter((v): v is number => v !== null)),
      condimentKcalShare: median(ok.map((r) => r.condimentKcalShare).filter((v): v is number => v !== null)),
      avgIngredients: ok.length ? ok.reduce((s, r) => s + r.ingredients, 0) / ok.length : 0,
      avgLatencySec: ok.length ? ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length / 1000 : 0,
      totalCostRub: rows.reduce((s, r) => s + (r.costRub ?? 0), 0),
    };
  });

  const header = [
    "Модель".padEnd(28), "сбои", "ккал |Δ|", "ккал сдвиг", "±25%", "масса |Δ|", "масса сдвиг",
    "основные", "лишн.", "ккал вне", "из них припр.", "поз.", "сек", "₽",
  ].join("  ");
  console.log(header);
  console.log("─".repeat(header.length));
  for (const s of [...summary].sort((a, b) => (a.kcalMedianAbs ?? 9) - (b.kcalMedianAbs ?? 9))) {
    console.log(
      [
        s.label.padEnd(28),
        String(s.failures).padEnd(4),
        (s.kcalMedianAbs === null ? "—" : pct(s.kcalMedianAbs)).padEnd(8),
        pct(s.kcalBias).padEnd(10),
        (s.kcalWithin25 === null ? "—" : `${Math.round(s.kcalWithin25 * 100)}%`).padEnd(4),
        (s.massMedianAbs === null ? "—" : pct(s.massMedianAbs)).padEnd(9),
        pct(s.massBias).padEnd(11),
        (s.majorRecall === null ? "—" : `${Math.round(s.majorRecall * 100)}%`).padEnd(8),
        (s.majorExtraPerDish?.toFixed(1) ?? "—").padEnd(5),
        (s.extraKcalShare === null ? "—" : `${Math.round(s.extraKcalShare * 100)}%`).padEnd(8),
        (s.condimentKcalShare === null ? "—" : `${Math.round(s.condimentKcalShare * 100)}%`).padEnd(13),
        s.avgIngredients.toFixed(1).padEnd(4),
        s.avgLatencySec.toFixed(0).padEnd(3),
        s.totalCostRub.toFixed(1),
      ].join("  "),
    );
  }
  console.log(
    "\nккал |Δ| — медиана модуля отклонения от калорийности JFB;\n" +
      "ккал сдвиг — медиана знакового отклонения (систематически завышает или занижает);\n" +
      "±25% — доля фото, где отклонение по калориям не больше четверти;\n" +
      "масса — то же против опорной массы, восстановленной через калорийность (см. шапку скрипта);\n" +
      "основные — доля ингредиентов эталона с ≥15% калорий, которые модель назвала;\n" +
      "лишн. — сколько позиций на блюдо модель придумала и дала им ≥15% калорий;\n" +
      "ккал вне — доля калорий ответа, пришедшая с позициями, которых в эталоне нет;\n" +
      "из них припр. — та же доля, но только по маслу, сахару, соусам и приправам.",
  );

  // ── Худшие расхождения ────────────────────────────────────────────────────
  const worst = raw
    .filter((r) => r.result.ok && r.result.kcalErrPct !== null)
    .sort((a, b) => Math.abs(b.result.kcalErrPct!) - Math.abs(a.result.kcalErrPct!))
    .slice(0, 15);
  console.log("\n=== Худшие расхождения по калориям ===");
  for (const { label, result } of worst) {
    console.log(
      `  ${pct(result.kcalErrPct).padStart(7)}  ${result.imageId} ${result.title.padEnd(34).slice(0, 34)} ` +
        `${label.padEnd(28)} ${result.modelKcal} против ${result.refKcal} ккал, ${result.modelWeightG}г`,
    );
    if (result.majorMissed.length) console.log(`           не назвала: ${result.majorMissed.join(", ")}`);
    if (result.majorExtra.length) console.log(`           лишнее: ${result.majorExtra.join(", ")}`);
  }

  // ── Что осталось несопоставленным ─────────────────────────────────────────
  const refMisses = new Map<string, number>();
  const modelMisses = new Map<string, number>();
  for (const { result } of raw) {
    for (const n of result.unmatchedRef) refMisses.set(n, (refMisses.get(n) ?? 0) + 1);
    for (const n of result.unmatchedModel) modelMisses.set(n, (modelMisses.get(n) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n, c]) => `${n}×${c}`).join(", ");
  console.log("\n=== Не сопоставлено (проверьте таблицу синонимов) ===");
  console.log(`  из эталона: ${top(refMisses)}`);
  console.log(`  из ответов: ${top(modelMisses)}`);

  writeFileSync(
    OUT,
    JSON.stringify({ ranAt: new Date().toISOString(), majorShare: MAJOR_SHARE, summary, raw }, null, 1),
    "utf8",
  );
  console.log(`\nПодробности: ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
