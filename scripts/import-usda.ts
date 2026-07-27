/**
 * Импорт справочника USDA FoodData Central (§8.1–8.2 PRD).
 *
 *   npx tsx scripts/import-usda.ts [--limit N] [--dry-run]
 *
 * Ядро: SR Legacy + Foundation Foods (~8000 позиций). Public domain (CC0),
 * полные дампы для self-hosting, до 140 нутриентов.
 *
 * Дампы качаются вручную (они большие и версионируются датой), кладутся в
 * data/usda/. Ожидаемая структура — как в CSV-выгрузке FDC:
 *
 *   data/usda/sr_legacy/food.csv
 *   data/usda/sr_legacy/food_nutrient.csv
 *   data/usda/sr_legacy/nutrient.csv
 *   data/usda/foundation/…то же самое
 *
 * Русские названия берутся из data/translations.json (готовит
 * scripts/translate-ingredients.ts) с приоритетом ручной вычитки из
 * data/translations.override.csv. Позиции без перевода импортируются с
 * английским названием в name_ru — лучше неполный справочник, чем его отсутствие.
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse";
import { config as loadEnv } from "dotenv";
import { NUTRIENTS } from "../config/nutrients";
import { createAdminClient } from "../src/lib/supabase/admin";

loadEnv({ path: ".env.local" });

const DATA_DIR = join(process.cwd(), "data", "usda");
const SOURCES = [
  { dir: "sr_legacy", source: "usda_sr" },
  { dir: "foundation", source: "usda_foundation" },
];

interface Translation {
  name_ru: string;
  synonyms?: string[];
}

async function readCsv<T = Record<string, string>>(path: string): Promise<T[]> {
  const rows: T[] = [];
  const parser = createReadStream(path).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_quotes: true }),
  );
  for await (const row of parser) rows.push(row as T);
  return rows;
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
 */
function resolveNutrientIds(
  nutrientRows: Record<string, string>[],
): Map<number, string> {
  const byId = new Map<number, string>();

  for (const def of NUTRIENTS) {
    const match = nutrientRows.find(
      (row) =>
        def.usdaNames.some(
          (name) => name.toLowerCase() === (row.name ?? "").toLowerCase(),
        ) && (row.unit_name ?? "").toUpperCase() === def.usdaUnit,
    );

    if (match) {
      byId.set(Number(match.id), def.code);
    } else {
      const fallback = nutrientRows.find(
        (row) => Number(row.id) === def.usdaFallbackId,
      );
      if (fallback) {
        console.warn(
          `⚠ «${def.usdaNames[0]}» не нашёлся по имени, беру id ${def.usdaFallbackId} (${fallback.name})`,
        );
        byId.set(def.usdaFallbackId, def.code);
      } else {
        console.warn(`⚠ нутриент ${def.code} отсутствует в дампе — колонка будет пустой`);
      }
    }
  }

  return byId;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  const supabase = createAdminClient();
  const translations = loadTranslations();
  console.log(`Переводов загружено: ${translations.size}`);

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

  for (const { dir, source } of SOURCES) {
    const base = join(DATA_DIR, dir);
    if (!existsSync(join(base, "food.csv"))) {
      console.warn(`⏭ ${base}/food.csv не найден — пропускаю (см. README, этап 0.5)`);
      continue;
    }

    console.log(`\n=== ${source} ===`);
    const [foods, nutrientDefs] = await Promise.all([
      readCsv(join(base, "food.csv")),
      readCsv(join(base, "nutrient.csv")),
    ]);

    const codeByUsdaId = resolveNutrientIds(nutrientDefs);
    const wanted = new Set(codeByUsdaId.keys());

    const foodsToImport = foods.slice(0, limit === Infinity ? undefined : limit);
    const fdcIds = new Set(foodsToImport.map((f) => f.fdc_id));
    console.log(`Продуктов: ${foodsToImport.length}`);

    // food_nutrient.csv — самый большой файл (миллионы строк), читаем потоком и
    // держим в памяти только нужные нутриенты нужных продуктов.
    const amounts = new Map<string, Map<string, number>>();
    const parser = createReadStream(join(base, "food_nutrient.csv")).pipe(
      parse({ columns: true, skip_empty_lines: true, relax_quotes: true }),
    );
    for await (const row of parser) {
      const fdcId = (row as Record<string, string>).fdc_id;
      if (!fdcIds.has(fdcId)) continue;
      const nutrientId = Number((row as Record<string, string>).nutrient_id);
      if (!wanted.has(nutrientId)) continue;
      const code = codeByUsdaId.get(nutrientId)!;
      const amount = Number((row as Record<string, string>).amount);
      if (!Number.isFinite(amount)) continue;
      const map = amounts.get(fdcId) ?? new Map<string, number>();
      map.set(code, amount);
      amounts.set(fdcId, map);
    }
    console.log(`Продуктов с нутриентами: ${amounts.size}`);

    if (dryRun) {
      console.log("--dry-run: в БД ничего не пишу");
      continue;
    }

    const CHUNK = 500;
    for (let offset = 0; offset < foodsToImport.length; offset += CHUNK) {
      const chunk = foodsToImport.slice(offset, offset + CHUNK);

      const ingredientRows = chunk.map((food) => {
        const translation = translations.get(food.fdc_id);
        return {
          source,
          source_id: food.fdc_id,
          name_en: food.description,
          name_ru: translation?.name_ru ?? food.description,
          category: food.food_category_id ?? null,
          state: "unknown",
          is_active: true,
        };
      });

      const { data: inserted, error } = await supabase
        .from("ingredients")
        .upsert(ingredientRows, { onConflict: "source,source_id" })
        .select("id, source_id");
      if (error) throw new Error(`ingredients upsert: ${error.message}`);

      const idBySourceId = new Map(
        (inserted ?? []).map((row) => [row.source_id as string, row.id as number]),
      );

      const nutrientLinks: {
        ingredient_id: number;
        nutrient_id: number;
        amount_per_100g: number;
      }[] = [];
      const aliasRows: {
        ingredient_id: number;
        alias: string;
        lang: string;
        source: string;
      }[] = [];

      for (const food of chunk) {
        const ingredientId = idBySourceId.get(food.fdc_id);
        if (!ingredientId) continue;

        for (const [code, amount] of amounts.get(food.fdc_id) ?? []) {
          const nutrientId = nutrientIdByCode.get(code);
          if (nutrientId) {
            nutrientLinks.push({
              ingredient_id: ingredientId,
              nutrient_id: nutrientId,
              amount_per_100g: amount,
            });
          }
        }

        for (const synonym of translations.get(food.fdc_id)?.synonyms ?? []) {
          aliasRows.push({
            ingredient_id: ingredientId,
            alias: synonym.toLowerCase().trim(),
            lang: "ru",
            source: "import",
          });
        }
      }

      if (nutrientLinks.length > 0) {
        const { error: linkError } = await supabase
          .from("ingredient_nutrients")
          .upsert(nutrientLinks, { onConflict: "ingredient_id,nutrient_id" });
        if (linkError) throw new Error(`ingredient_nutrients: ${linkError.message}`);
      }

      if (aliasRows.length > 0) {
        // Конфликт по (alias, lang) ожидаем: одно слово может быть синонимом
        // для нескольких позиций — оставляем первую.
        await supabase
          .from("ingredient_aliases")
          .upsert(aliasRows, { onConflict: "alias,lang", ignoreDuplicates: true });
      }

      console.log(
        `  ${Math.min(offset + CHUNK, foodsToImport.length)}/${foodsToImport.length}`,
      );
    }
  }

  const { count } = await supabase
    .from("ingredients")
    .select("id", { count: "exact", head: true });
  console.log(`\nГотово. Позиций в справочнике: ${count}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
