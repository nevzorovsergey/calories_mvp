/**
 * Импорт справочника USDA FoodData Central (§8.1–8.2 PRD).
 *
 *   npx tsx scripts/import-usda.ts [--limit N] [--dry-run] [--source foundation]
 *                                  [--chunk N]
 *
 * Ядро: SR Legacy + Foundation Foods (~8200 позиций). Public domain (CC0),
 * полные дампы для self-hosting, до 140 нутриентов.
 *
 * Дампы качаются вручную (они большие и версионируются датой), кладутся в
 * data/usda/. Ожидаемая структура — как в CSV-выгрузке FDC:
 *
 *   data/usda/sr_legacy/{food,food_nutrient,nutrient,food_category}.csv
 *   data/usda/foundation/…то же самое
 *
 * Русские названия берутся из data/translations.json (готовит
 * scripts/export-translation-chunks.ts + субагенты + scripts/merge-translations.ts)
 * с приоритетом ручной вычитки из data/translations.override.csv. Позиции без
 * перевода импортируются с английским названием в name_ru — лучше неполный
 * справочник, чем его отсутствие.
 *
 * `--dry-run` не пишет в БД ничего и печатает всю статистику, по которой импорт
 * можно проверить заранее: сколько позиций, покрытие энергией, перекрытие
 * источников, коллизии алиасов.
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { config as loadEnv } from "dotenv";
import { NUTRIENTS } from "../config/nutrients";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  type ComponentRow,
  loadComponentBridge,
  loadComponents,
  loadPortions,
} from "./lib/fndds";
import {
  DATA_DIR,
  E2E_RESERVED,
  type FoodRow,
  type UsdaSource,
  USDA_SOURCES,
  classifyState,
  dedupKey,
  foodCsvPath,
  loadCategories,
  loadFoods,
  normalizeDescription,
  pickCanonical,
  readCsv,
} from "./lib/usda";

loadEnv({ path: ".env.local" });

/**
 * Размер пачки записи. Меняется флагом `--chunk N`.
 *
 * 500 — то, на чём заливались SR и Foundation. На блюдах FNDDS запрос такого
 * размера стабильно отваливается с «TypeError: fetch failed», хотя чтение той же
 * тысячи строк в тот же момент проходит за полторы секунды: проект в Огайо,
 * заливка идёт из России, и деградирует именно объём запроса, а не связь. Ретрай
 * тут не помогает — повторяется тот же слишком большой запрос.
 */
let CHUNK = 500;

interface Translation {
  name_ru: string;
  synonyms?: string[];
}

/** Кандидат в `ingredient_aliases` до разрешения глобальных коллизий. */
interface AliasCandidate {
  alias: string;
  ingredientId: number;
  source: string;
  nameEn: string;
  fdcId: string;
}

/**
 * Повтор сетевого шага импорта.
 *
 * Проект в Огайо, заливка идёт из России, а полный прогон — это порядка 400 000
 * строк за сотни запросов. На такой длине отдельные запросы отваливаются по
 * сети, а не по данным («TypeError: fetch failed»), и падать из-за одного такого
 * значит переливать всё заново. Ошибки данных не ретраятся: они воспроизведутся
 * и на четвёртой попытке, поэтому после исчерпания задержек бросаем как раньше.
 */
async function withRetry<T>(
  label: string,
  run: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  const delays = [1_000, 3_000, 8_000];
  for (let attempt = 0; ; attempt += 1) {
    const { data, error } = await run();
    if (!error) return data;
    if (attempt >= delays.length) throw new Error(`${label}: ${error.message}`);
    console.warn(
      `  ⚠ ${label}: ${error.message} — повтор через ${delays[attempt] / 1000} с`,
    );
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}

function loadTranslations(): Map<string, Translation> {
  const map = new Map<string, Translation>();

  const jsonPath = join(process.cwd(), "data", "translations.json");
  if (existsSync(jsonPath)) {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<
      string,
      Translation
    >;
    for (const [key, value] of Object.entries(parsed)) map.set(key, value);
  }

  // Ручная вычитка топ-500 имеет приоритет над машинным переводом (§8.2, шаг 3).
  const overridePath = join(process.cwd(), "data", "translations.override.csv");
  if (existsSync(overridePath)) {
    const lines = readFileSync(overridePath, "utf8").split("\n").slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const [fdcId, nameRu, synonyms] = splitCsvLine(line);
      if (!fdcId || !nameRu) continue;
      map.set(fdcId, {
        name_ru: nameRu,
        synonyms: synonyms ? synonyms.split(";").map((s) => s.trim()).filter(Boolean) : [],
      });
    }
  }

  return map;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else current += char;
  }
  result.push(current.trim());
  return result;
}

/**
 * Резолвим id нутриентов по имени и единице измерения, а не по хардкоженным
 * номерам: номера в дампах стабильны, но сверка по имени ловит смену версии
 * дампа сразу, а не через месяц кривых расчётов.
 *
 * Одному коду может соответствовать несколько id: у калорийности в Foundation
 * это «Energy» (1008) и два варианта факторов Атуотера (2047, 2048), и у одного
 * продукта они встречаются вместе. Поэтому возвращаем не «id → код», а
 * «id → код + приоритет», где приоритет — позиция имени в `usdaNames`.
 */
function resolveNutrientIds(
  nutrientRows: Record<string, string>[],
  nutrientKey: UsdaSource["nutrientKey"],
): Map<number, { code: string; priority: number }> {
  const byId = new Map<number, { code: string; priority: number }>();
  /** Чем подписан нутриент в food_nutrient.csv этого дампа (см. UsdaSource). */
  const linkId = (row: Record<string, string>) => Number(row[nutrientKey]);

  for (const def of NUTRIENTS) {
    let found = false;

    def.usdaNames.forEach((name, priority) => {
      const match = nutrientRows.find(
        (row) =>
          name.toLowerCase() === (row.name ?? "").toLowerCase() &&
          (row.unit_name ?? "").toUpperCase() === def.usdaUnit,
      );
      if (match && Number.isFinite(linkId(match))) {
        byId.set(linkId(match), { code: def.code, priority });
        found = true;
      }
    });

    if (found) continue;

    const fallback = nutrientRows.find((row) => Number(row.id) === def.usdaFallbackId);
    if (fallback && Number.isFinite(linkId(fallback))) {
      console.warn(
        `  ⚠ «${def.usdaNames[0]}» не нашёлся по имени, беру id ${def.usdaFallbackId} (${fallback.name})`,
      );
      byId.set(linkId(fallback), { code: def.code, priority: def.usdaNames.length });
    } else {
      console.warn(`  ⚠ нутриент ${def.code} отсутствует в дампе — колонка будет пустой`);
    }
  }

  return byId;
}

interface SourceData {
  source: UsdaSource;
  foods: FoodRow[];
  categories: Map<string, string>;
  /** fdc_id → код нутриента → значение на 100 г (уже разрешённое по приоритету). */
  amounts: Map<string, Map<string, number>>;
}

/**
 * Читает один источник целиком: продукты, категории и нутриенты. Ничего не
 * пишет — так `--dry-run` остаётся честным.
 */
async function readSource(source: UsdaSource, limit: number): Promise<SourceData | null> {
  if (!existsSync(foodCsvPath(source.dir))) {
    console.warn(`⏭ ${source.dir}/food.csv не найден — пропускаю (см. data/README.md)`);
    return null;
  }

  console.log(`\n=== ${source.source} ===`);
  const [allFoods, categories, nutrientDefs] = await Promise.all([
    loadFoods(source),
    loadCategories(source),
    readCsv(join(DATA_DIR, source.dir, "nutrient.csv")),
  ]);

  const codeByUsdaId = resolveNutrientIds(nutrientDefs, source.nutrientKey);
  const foods = limit === Infinity ? allFoods : allFoods.slice(0, limit);
  const fdcIds = new Set(foods.map((f) => f.fdcId));
  console.log(`  продуктов: ${foods.length}`);

  // food_nutrient.csv — самый большой файл (миллионы строк), читаем потоком и
  // держим в памяти только нужные нутриенты нужных продуктов.
  const withPriority = new Map<string, Map<string, { amount: number; priority: number }>>();
  const energyByUsdaId = new Map<number, Set<string>>();

  const parser = createReadStream(join(DATA_DIR, source.dir, "food_nutrient.csv")).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_quotes: true }),
  );
  for await (const row of parser) {
    const r = row as Record<string, string>;
    if (!fdcIds.has(r.fdc_id)) continue;
    const nutrientId = Number(r.nutrient_id);
    const resolved = codeByUsdaId.get(nutrientId);
    if (!resolved) continue;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount)) continue;

    if (resolved.code === "energy_kcal") {
      const seen = energyByUsdaId.get(nutrientId) ?? new Set<string>();
      seen.add(r.fdc_id);
      energyByUsdaId.set(nutrientId, seen);
    }

    const map = withPriority.get(r.fdc_id) ?? new Map();
    const prev = map.get(resolved.code);
    // Приоритет ниже номером — лучше. Иначе порядок строк в CSV решал бы,
    // какая из трёх калорийностей попадёт в справочник.
    if (prev && prev.priority <= resolved.priority) continue;
    map.set(resolved.code, { amount, priority: resolved.priority });
    withPriority.set(r.fdc_id, map);
  }

  const amounts = new Map<string, Map<string, number>>();
  for (const [fdcId, byCode] of withPriority) {
    amounts.set(
      fdcId,
      new Map([...byCode].map(([code, value]) => [code, value.amount])),
    );
  }

  const withEnergy = [...amounts.values()].filter((m) => m.has("energy_kcal")).length;
  const breakdown = [...energyByUsdaId]
    .sort(([a], [b]) => a - b)
    .map(([id, set]) => `${id}: ${set.size}`)
    .join(", ");
  console.log(
    `  с нутриентами: ${amounts.size}, с энергией: ${withEnergy}/${foods.length}` +
      (breakdown ? ` (${breakdown})` : ""),
  );

  return { source, foods, categories, amounts };
}

/**
 * Разрешение глобальных коллизий алиасов.
 *
 * Уникальность `ingredient_aliases (alias, lang)` — общая на весь справочник:
 * одна строка-алиас указывает ровно на один ингредиент. Синонимов же приходит
 * ~20 000 на 8000 позиций, и «молоко» претендуют десятки записей. Отдавать это
 * на волю порядка строк в CSV нельзя: алиас даёт exact-совпадение со score 1.0,
 * то есть привязал бы распознанное «молоко» к произвольной сухой смеси.
 *
 * Правило: побеждает самая «родовая» запись — Foundation важнее SR, меньше
 * уточнений в name_en важнее большего, дальше короче и по возрастанию fdc_id
 * ради детерминизма.
 */
function rankAliases(
  candidates: AliasCandidate[],
  nameRuOwners: Map<string, number>,
): { rows: AliasCandidate[]; dropped: number; reserved: number; shadowed: number } {
  const commas = (value: string) => value.split(",").length - 1;
  // Порядок источников — тот же, что в USDA_SOURCES: Foundation, SR, FNDDS.
  // Блюда идут последними намеренно: родовое «курица» должно достаться сырью,
  // а не позиции «Chicken breast, fried, coated, skin eaten, from pre-cooked».
  const sourceRank = new Map(USDA_SOURCES.map((s, index) => [s.source, index]));
  const sorted = [...candidates].sort((a, b) => {
    const bySource =
      (sourceRank.get(a.source) ?? 99) - (sourceRank.get(b.source) ?? 99);
    if (bySource !== 0) return bySource;
    const byCommas = commas(a.nameEn) - commas(b.nameEn);
    if (byCommas !== 0) return byCommas;
    const byLength = a.nameEn.length - b.nameEn.length;
    if (byLength !== 0) return byLength;
    return Number(a.fdcId) - Number(b.fdcId);
  });

  const rows: AliasCandidate[] = [];
  const taken = new Set<string>();
  let dropped = 0;
  let reserved = 0;
  let shadowed = 0;

  for (const candidate of sorted) {
    if (E2E_RESERVED.has(candidate.alias)) {
      reserved += 1;
      continue;
    }
    // Алиас, совпадающий с основным именем другой позиции, перекрыл бы её
    // собственное точное совпадение.
    const owner = nameRuOwners.get(normalizeDescription(candidate.alias));
    if (owner !== undefined && owner !== candidate.ingredientId) {
      shadowed += 1;
      continue;
    }
    if (taken.has(candidate.alias)) {
      dropped += 1;
      continue;
    }
    taken.add(candidate.alias);
    rows.push(candidate);
  }

  return { rows, dropped, reserved, shadowed };
}

async function writeSource(
  supabase: SupabaseClient,
  data: SourceData,
  translations: Map<string, Translation>,
  nutrientIdByCode: Map<string, number>,
  aliasCandidates: AliasCandidate[],
  nameRuOwners: Map<string, number>,
  idByFdcId: Map<string, number>,
): Promise<void> {
  const { source, foods, categories, amounts } = data;

  for (let offset = 0; offset < foods.length; offset += CHUNK) {
    const chunk = foods.slice(offset, offset + CHUNK);

    const ingredientRows = chunk.map((food) => {
      const translation = translations.get(food.fdcId);
      return {
        source: source.source,
        source_id: food.fdcId,
        name_en: food.description,
        name_ru: translation?.name_ru ?? food.description,
        category: food.categoryId ? categories.get(food.categoryId) ?? null : null,
        kind: source.kind,
        state: classifyState(food.description),
        // Каждый прогон восстанавливает полную картину: гашение дублей идёт
        // последним шагом и опирается на актуальные дампы, а не на прошлый запуск.
        is_active: true,
      };
    });

    const inserted = await withRetry("ingredients upsert", () =>
      supabase
        .from("ingredients")
        .upsert(ingredientRows, { onConflict: "source,source_id" })
        .select("id, source_id"),
    );

    const idBySourceId = new Map(
      (inserted ?? []).map((row) => [row.source_id as string, row.id as number]),
    );
    // fdc_id уникален на весь FoodData Central, поэтому карта общая на все
    // источники: по ней потом резолвятся компоненты блюд и порции.
    for (const [fdcId, id] of idBySourceId) idByFdcId.set(fdcId, id);
    const ingredientIds = [...idBySourceId.values()];

    // Нутриент, исчезнувший между версиями дампа, иначе сохранил бы старое
    // значение навсегда: upsert его не трогает.
    if (ingredientIds.length > 0) {
      await withRetry("ingredient_nutrients cleanup", () =>
        supabase.from("ingredient_nutrients").delete().in("ingredient_id", ingredientIds),
      );
    }

    const nutrientLinks: {
      ingredient_id: number;
      nutrient_id: number;
      amount_per_100g: number;
    }[] = [];

    for (const food of chunk) {
      const ingredientId = idBySourceId.get(food.fdcId);
      if (!ingredientId) continue;

      const translation = translations.get(food.fdcId);
      nameRuOwners.set(
        normalizeDescription(translation?.name_ru ?? food.description),
        ingredientId,
      );

      for (const [code, amount] of amounts.get(food.fdcId) ?? []) {
        const nutrientId = nutrientIdByCode.get(code);
        if (nutrientId) {
          nutrientLinks.push({
            ingredient_id: ingredientId,
            nutrient_id: nutrientId,
            amount_per_100g: amount,
          });
        }
      }

      for (const synonym of translation?.synonyms ?? []) {
        const alias = synonym.toLowerCase().trim();
        if (!alias) continue;
        aliasCandidates.push({
          alias,
          ingredientId,
          source: source.source,
          nameEn: food.description,
          fdcId: food.fdcId,
        });
      }
    }

    if (nutrientLinks.length > 0) {
      await withRetry("ingredient_nutrients", () =>
        supabase
          .from("ingredient_nutrients")
          .upsert(nutrientLinks, { onConflict: "ingredient_id,nutrient_id" }),
      );
    }

    console.log(`  ${Math.min(offset + CHUNK, foods.length)}/${foods.length}`);
  }
}

/**
 * Резолвер компонента блюда: код из input_food → id позиции справочника.
 *
 * Три перехода, и каждый может не сработать:
 *   код → fdc_id            — мост NDB/food_code (scripts/lib/fndds.ts);
 *   fdc_id → канонический   — компонент может ссылаться на запись, которую
 *                             дедупликация погасила; ведём на победителя, иначе
 *                             состав блюда указывал бы на is_active = false;
 *   канонический → id       — позиции может не быть в импорте (например, при
 *                             --limit).
 */
function makeComponentResolver(
  bridge: Map<string, string>,
  idByFdcId: Map<string, number>,
  canonicalFdcId: Map<string, string>,
): (code: string) => number | null {
  return (code) => {
    const fdcId = bridge.get(code);
    if (!fdcId) return null;
    return idByFdcId.get(canonicalFdcId.get(fdcId) ?? fdcId) ?? null;
  };
}

/**
 * Порции и раскладка блюд. Отдельным проходом после записи всех источников:
 * компонент блюда часто ссылается на позицию другого источника (мясо из SR
 * внутри блюда FNDDS), и до того, как записаны все три дампа, его просто некуда
 * привязывать.
 */
async function writeDishExtras(
  supabase: SupabaseClient,
  dishes: FoodRow[],
  idByFdcId: Map<string, number>,
  canonicalFdcId: Map<string, string>,
): Promise<void> {
  console.log("\n=== порции и раскладка ===");

  const [portionsByFood, componentsByDish, bridge] = await Promise.all([
    loadPortions(),
    loadComponents(),
    loadComponentBridge(),
  ]);

  // Компоненты блюд ссылаются в основном на сырьё из SR, а при частичном
  // прогоне (`--source survey`) сырьё в этот раз не писалось и его id в памяти
  // нет. Добираем недостающее из БД — иначе состав блюд оказался бы непривязан
  // ровно там, где перезаливаются только блюда.
  const needed = new Set<string>();
  for (const components of componentsByDish.values()) {
    for (const component of components) {
      const fdcId = bridge.get(component.code);
      if (fdcId && !idByFdcId.has(fdcId)) needed.add(fdcId);
    }
  }
  if (needed.size > 0) {
    const missing = [...needed];
    for (let offset = 0; offset < missing.length; offset += CHUNK) {
      const rows = await withRetry("подтягивание id компонентов", () =>
        supabase
          .from("ingredients")
          .select("id, source_id")
          .in("source_id", missing.slice(offset, offset + CHUNK)),
      );
      for (const row of rows ?? []) {
        idByFdcId.set(row.source_id as string, row.id as number);
      }
    }
    console.log(`  подтянуто из БД id компонентов: ${needed.size}`);
  }

  const resolve = makeComponentResolver(bridge, idByFdcId, canonicalFdcId);

  const dishIds = dishes
    .map((dish) => idByFdcId.get(dish.fdcId))
    .filter((id): id is number => id !== undefined);

  // Порция или компонент, исчезнувшие между версиями дампа, иначе остались бы
  // в справочнике навсегда: вставка их не трогает (та же логика, что у
  // ingredient_nutrients в writeSource).
  for (let offset = 0; offset < dishIds.length; offset += CHUNK) {
    const chunk = dishIds.slice(offset, offset + CHUNK);
    await withRetry("очистка порций", () =>
      supabase.from("ingredient_portions").delete().in("ingredient_id", chunk),
    );
    await withRetry("очистка раскладки", () =>
      supabase.from("ingredient_components").delete().in("dish_id", chunk),
    );
  }

  const portionRows: Record<string, unknown>[] = [];
  const componentRows: Record<string, unknown>[] = [];
  let withPortions = 0;
  let withDefault = 0;
  let fullyResolved = 0;
  let unresolvedComponents = 0;
  const withoutComponents: string[] = [];

  for (const dish of dishes) {
    const dishId = idByFdcId.get(dish.fdcId);
    if (!dishId) continue;

    const portions = portionsByFood.get(dish.fdcId) ?? [];
    if (portions.length > 0) withPortions += 1;
    if (portions.some((portion) => portion.isDefault)) withDefault += 1;
    for (const portion of portions) {
      portionRows.push({
        ingredient_id: dishId,
        seq: portion.seq,
        label_en: portion.labelEn,
        gram_weight: portion.gramWeight,
        is_default: portion.isDefault,
      });
    }

    const components: ComponentRow[] = componentsByDish.get(dish.fdcId) ?? [];
    if (components.length === 0) {
      withoutComponents.push(dish.description);
      continue;
    }
    let resolvedAll = true;
    for (const component of components) {
      const ingredientId = resolve(component.code);
      if (ingredientId === null) {
        resolvedAll = false;
        unresolvedComponents += 1;
      }
      componentRows.push({
        dish_id: dishId,
        seq: component.seq,
        ingredient_id: ingredientId,
        // Название из дампа держим всегда, а не только для непривязанных: по
        // нему видно, что именно USDA считала этим компонентом, даже если
        // привязка потом уедет на другую позицию справочника.
        name_en_fallback: component.descriptionEn || null,
        gram_weight: component.gramWeight,
        share: component.share,
        retention_code: component.retentionCode,
      });
    }
    if (resolvedAll) fullyResolved += 1;
  }

  for (let offset = 0; offset < portionRows.length; offset += CHUNK) {
    const chunk = portionRows.slice(offset, offset + CHUNK);
    await withRetry("ingredient_portions", () =>
      supabase.from("ingredient_portions").insert(chunk),
    );
  }
  for (let offset = 0; offset < componentRows.length; offset += CHUNK) {
    const chunk = componentRows.slice(offset, offset + CHUNK);
    await withRetry("ingredient_components", () =>
      supabase.from("ingredient_components").insert(chunk),
    );
  }

  const total = dishIds.length;
  console.log(
    `  порций: ${portionRows.length} у ${withPortions}/${total} блюд ` +
      `(с порцией по умолчанию: ${withDefault})`,
  );
  console.log(
    `  компонентов: ${componentRows.length}, блюд с полностью привязанным ` +
      `составом: ${fullyResolved}/${total}, непривязанных компонентов: ${unresolvedComponents}`,
  );
  if (withoutComponents.length > 0) {
    console.warn(
      `  ⚠ без раскладки осталось ${withoutComponents.length} блюд: ` +
        `${withoutComponents.slice(0, 3).join("; ")}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
  const sourceArg = args.indexOf("--source");
  const onlySource = sourceArg >= 0 ? args[sourceArg + 1] : null;
  const chunkArg = args.indexOf("--chunk");
  if (chunkArg >= 0) {
    const value = Number(args[chunkArg + 1]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--chunk ${args[chunkArg + 1]}: ожидается целое число ≥ 1`);
    }
    CHUNK = value;
    console.log(`Размер пачки записи: ${CHUNK}`);
  }

  const sourcesToRead = onlySource
    ? USDA_SOURCES.filter((s) => s.dir === onlySource)
    : USDA_SOURCES;
  if (sourcesToRead.length === 0) {
    throw new Error(`--source ${onlySource}: такого источника нет`);
  }

  const translations = loadTranslations();
  console.log(`Переводов загружено: ${translations.size}`);

  const sources: SourceData[] = [];
  for (const source of sourcesToRead) {
    const data = await readSource(source, limit);
    if (data) sources.push(data);
  }

  const { winners, losers } = pickCanonical(sources);
  const losersTotal = [...losers.values()].reduce((n, ids) => n + ids.length, 0);
  console.log(
    `\nДубли: ${winners.size} уникальных описаний, ${losersTotal} записей гасим ` +
      `(${[...losers].map(([src, ids]) => `${src}: ${ids.length}`).join(", ") || "нет"})`,
  );

  // Компонент блюда может ссылаться на позицию, которую дедупликация погасила.
  // Ведём такую ссылку на победителя, иначе состав указывал бы на is_active =
  // false и в интерфейсе выглядел бы как пропавший ингредиент.
  const canonicalFdcId = new Map<string, string>();
  for (const { source, foods } of sources) {
    for (const food of foods) {
      const winner = winners.get(dedupKey(source.kind, food.description));
      if (winner) canonicalFdcId.set(food.fdcId, winner.food.fdcId);
    }
  }

  if (dryRun) {
    reportAliasCollisions(sources, translations);
    await reportDishExtras(sources);
    console.log("\n--dry-run: в БД ничего не пишу");
    return;
  }

  const supabase = createAdminClient();

  // Справочник нутриентов — тот же upsert, что в миграции 0004.
  const { error: nutrientsError } = await supabase.from("nutrients").upsert(
    NUTRIENTS.map((n) => ({
      code: n.code,
      name_ru: n.nameRu,
      unit: n.unit,
      group_code: n.group,
      rdi_default: n.rdi,
      sort_order: n.sortOrder,
    })),
    { onConflict: "code" },
  );
  if (nutrientsError) throw new Error(`nutrients upsert: ${nutrientsError.message}`);

  const { data: nutrientRows } = await supabase.from("nutrients").select("id, code");
  const nutrientIdByCode = new Map(
    (nutrientRows ?? []).map((n) => [n.code as string, n.id as number]),
  );

  const aliasCandidates: AliasCandidate[] = [];
  const nameRuOwners = new Map<string, number>();
  const idByFdcId = new Map<string, number>();

  for (const data of sources) {
    console.log(`\n=== запись ${data.source.source} ===`);
    await writeSource(
      supabase,
      data,
      translations,
      nutrientIdByCode,
      aliasCandidates,
      nameRuOwners,
      idByFdcId,
    );
  }

  // Алиасы пишем один раз и глобально: коллизии разрешаются рангом, а не
  // порядком чтения файлов.
  const { rows: aliasRows, dropped, reserved, shadowed } = rankAliases(
    aliasCandidates,
    nameRuOwners,
  );
  for (let offset = 0; offset < aliasRows.length; offset += CHUNK) {
    const chunk = aliasRows.slice(offset, offset + CHUNK).map((row) => ({
      ingredient_id: row.ingredientId,
      alias: row.alias,
      lang: "ru",
      source: "import",
    }));
    // ignoreDuplicates защищает ручной маппинг пользователя (source =
    // 'user_mapping'): он всегда старше импорта.
    await withRetry("ingredient_aliases", () =>
      supabase
        .from("ingredient_aliases")
        .upsert(chunk, { onConflict: "alias,lang", ignoreDuplicates: true }),
    );
  }
  console.log(
    `\nАлиасов: ${aliasRows.length} записано, ${dropped} отброшено как коллизии, ` +
      `${shadowed} перекрывали чужое имя, ${reserved} зарезервированы за e2e`,
  );

  for (const [sourceName, fdcIds] of losers) {
    for (let offset = 0; offset < fdcIds.length; offset += CHUNK) {
      const chunk = fdcIds.slice(offset, offset + CHUNK);
      await withRetry("деактивация дублей", () =>
        supabase
          .from("ingredients")
          .update({ is_active: false })
          .eq("source", sourceName)
          .in("source_id", chunk),
      );
    }
    console.log(`✔ погашено дублей ${sourceName}: ${fdcIds.length}`);
  }

  // Порции и раскладка — только у блюд, и только после того, как записаны все
  // источники: компонент блюда обычно ссылается на сырьё из SR.
  const dishes = sources
    .filter((data) => data.source.kind === "dish")
    .flatMap((data) => data.foods);
  if (dishes.length > 0) {
    await writeDishExtras(supabase, dishes, idByFdcId, canonicalFdcId);
  }

  const { count } = await supabase
    .from("ingredients")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  const { count: dishCount } = await supabase
    .from("ingredients")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .eq("kind", "dish");
  console.log(
    `\nГотово. Активных позиций в справочнике: ${count} (из них блюд: ${dishCount})`,
  );
}

/** Что получится с порциями и раскладкой — считаем без похода в БД. */
async function reportDishExtras(sources: SourceData[]): Promise<void> {
  const dishes = sources
    .filter((data) => data.source.kind === "dish")
    .flatMap((data) => data.foods);
  if (dishes.length === 0) return;

  const [portionsByFood, componentsByDish, bridge] = await Promise.all([
    loadPortions(),
    loadComponents(),
    loadComponentBridge(),
  ]);

  // Без записи в БД id позиций неизвестны, поэтому привязку проверяем на уровне
  // fdc_id: мост либо знает код компонента, либо нет.
  let withPortions = 0;
  let withDefault = 0;
  let components = 0;
  let unresolved = 0;
  let fullyResolved = 0;

  for (const dish of dishes) {
    const portions = portionsByFood.get(dish.fdcId) ?? [];
    if (portions.length > 0) withPortions += 1;
    if (portions.some((portion) => portion.isDefault)) withDefault += 1;

    const list = componentsByDish.get(dish.fdcId) ?? [];
    components += list.length;
    const bad = list.filter((component) => !bridge.has(component.code)).length;
    unresolved += bad;
    if (list.length > 0 && bad === 0) fullyResolved += 1;
  }

  console.log(
    `\nБлюд: ${dishes.length}, с порциями: ${withPortions} ` +
      `(с порцией по умолчанию: ${withDefault})`,
  );
  console.log(
    `Компонентов: ${components}, не резолвятся: ${unresolved}, ` +
      `блюд с полностью привязанным составом: ${fullyResolved}`,
  );
}

/** Что стало бы с алиасами при записи — считаем без похода в БД. */
function reportAliasCollisions(
  sources: SourceData[],
  translations: Map<string, Translation>,
): void {
  const claims = new Map<string, number>();
  for (const data of sources) {
    for (const food of data.foods) {
      for (const synonym of translations.get(food.fdcId)?.synonyms ?? []) {
        const alias = synonym.toLowerCase().trim();
        if (!alias) continue;
        claims.set(alias, (claims.get(alias) ?? 0) + 1);
      }
    }
  }
  const collisions = [...claims.entries()].filter(([, n]) => n > 1);
  console.log(
    `Алиасов-кандидатов: ${claims.size}, из них с несколькими претендентами: ${collisions.length}`,
  );
  const top = collisions.sort(([, a], [, b]) => b - a).slice(0, 10);
  if (top.length > 0) {
    console.log(`  топ: ${top.map(([alias, n]) => `${alias} (${n})`).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
