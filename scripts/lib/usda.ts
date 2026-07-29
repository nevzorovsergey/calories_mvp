/**
 * Общее чтение дампов USDA FoodData Central (§8.1 PRD).
 *
 * Импортёр и экспортёр чанков на перевод обязаны видеть ровно один и тот же
 * набор продуктов — иначе перевод уедет на позиции, которых нет в справочнике,
 * а в справочнике окажутся позиции без перевода. Поэтому чтение `food.csv`
 * живёт здесь, а не дублируется в каждом скрипте.
 *
 * Главная ловушка дампов: `food.csv` у Foundation — это не список продуктов, а
 * вся лабораторная цепочка происхождения. На 469 реальных `foundation_food`
 * приходится 87 521 строка проб и закупок (`sub_sample_food`,
 * `market_acquisition`, `sample_food`, `agricultural_acquisition`) — у них нет
 * ни калорийности, ни осмысленного названия. Фильтр по `data_type` обязателен.
 */

import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse";

export const DATA_DIR = join(process.cwd(), "data", "usda");

export interface UsdaSource {
  dir: string;
  /** Значение `ingredients.source`. */
  source: string;
  /** Единственный `data_type`, который считается продуктом. */
  dataType: string;
  /** Сколько строк ожидаем после фильтра — растяжка на смену версии дампа. */
  expected: number;
  /** Значение `ingredients.kind`: сырьё или готовое блюдо. */
  kind: "ingredient" | "dish";
  /**
   * Какой колонкой `nutrient.csv` подписаны нутриенты в `food_nutrient.csv`.
   *
   * У SR и Foundation это `id` (1008 = энергия). В survey-дампе — `nutrient_nbr`,
   * legacy-номера времён SR (208 = энергия, 301 = кальций). Резолв по `id` там
   * не падает, а молча не находит НИ ОДНОГО нутриента: импорт отработает
   * «успешно» и оставит 5432 блюда без единой калории.
   */
  nutrientKey: "id" | "nutrient_nbr";
  /** Где лежат названия категорий: у survey это WWEIA, а не food_category. */
  category: { file: string; idColumn: string; nameColumn: string };
}

const FOOD_CATEGORY = {
  file: "food_category.csv",
  idColumn: "id",
  nameColumn: "description",
};

/**
 * Foundation первым: он свежее (лабораторные замеры 2019–2026 против
 * замороженного SR Legacy 2018), поэтому выигрывает и дедупликацию
 * пересекающихся позиций, и захват алиасов.
 *
 * Survey последним, и это важно для алиасов: родовое слово («курица», «пицца»,
 * «суп») должно достаться сырью, а не готовому блюду — см. rankAliases в
 * scripts/import-usda.ts.
 */
export const USDA_SOURCES: UsdaSource[] = [
  {
    dir: "foundation",
    source: "usda_foundation",
    dataType: "foundation_food",
    expected: 469,
    kind: "ingredient",
    nutrientKey: "id",
    category: FOOD_CATEGORY,
  },
  {
    dir: "sr_legacy",
    source: "usda_sr",
    dataType: "sr_legacy_food",
    expected: 7793,
    kind: "ingredient",
    nutrientKey: "id",
    category: FOOD_CATEGORY,
  },
  {
    dir: "survey",
    source: "usda_fndds",
    dataType: "survey_fndds_food",
    expected: 5432,
    kind: "dish",
    nutrientKey: "nutrient_nbr",
    // food.food_category_id у survey-строк — это и есть номер категории WWEIA,
    // отдельного джойна через survey_fndds_food.csv не требуется.
    category: {
      file: "wweia_food_category.csv",
      idColumn: "wweia_food_category",
      nameColumn: "wweia_food_category_description",
    },
  },
];

/** Алиасы, которые держат на себе e2e-проверки — импорту их отдавать нельзя. */
export const E2E_RESERVED = new Set([
  "масло для жарки",
  "яйцо жареное",
  "бекон жареный",
  "хлеб тостовый",
]);

export interface FoodRow {
  fdcId: string;
  description: string;
  categoryId: string | null;
  /** Дата публикации: по ней выбирается победитель среди одинаковых описаний. */
  publicationDate: string;
}

export async function readCsv<T = Record<string, string>>(path: string): Promise<T[]> {
  const rows: T[] = [];
  const parser = createReadStream(path).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_quotes: true }),
  );
  for await (const row of parser) rows.push(row as T);
  return rows;
}

export function foodCsvPath(dir: string): string {
  return join(DATA_DIR, dir, "food.csv");
}

/** Продукты одного источника: только строки нужного `data_type`. */
export async function loadFoods(source: UsdaSource): Promise<FoodRow[]> {
  const path = foodCsvPath(source.dir);
  if (!existsSync(path)) return [];

  const all = await readCsv(path);
  const foods = all
    .filter((row) => row.data_type === source.dataType)
    .map((row) => ({
      fdcId: row.fdc_id,
      description: row.description,
      categoryId: row.food_category_id || null,
      publicationDate: row.publication_date ?? "",
    }));

  const dropped = all.length - foods.length;
  if (dropped > 0) {
    console.log(
      `  ⏭ отброшено ${dropped} строк не-продуктов (data_type ≠ ${source.dataType})`,
    );
  }
  const drift = Math.abs(foods.length - source.expected) / source.expected;
  if (drift > 0.1) {
    console.warn(
      `  ⚠ ожидали ~${source.expected} позиций, получили ${foods.length} — проверьте версию дампа`,
    );
  }

  return foods;
}

/** id категории → английское название (food_category.csv или WWEIA у survey). */
export async function loadCategories(source: UsdaSource): Promise<Map<string, string>> {
  const path = join(DATA_DIR, source.dir, source.category.file);
  if (!existsSync(path)) return new Map();
  const rows = await readCsv(path);
  return new Map(
    rows.map((row) => [row[source.category.idColumn], row[source.category.nameColumn]]),
  );
}

/**
 * Ключ дедупликации позиций между источниками. Форма та же, что у
 * `normalizeName` в src/lib/catalog/match.ts — чтобы «одинаковыми» здесь и в
 * приложении считались одни и те же строки.
 */
export function normalizeDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SourceFoods {
  source: UsdaSource;
  foods: FoodRow[];
}

/**
 * Ключ, по которому позиции считаются одной и той же.
 *
 * `kind` входит в ключ, потому что сырьё и блюдо с одинаковым описанием — разные
 * записи справочника, а не дубли. Таких пересечений 111 («Brussels sprouts, raw»
 * есть и в SR, и в FNDDS), и гасить одно другим нельзя: у SR-версии полный
 * лабораторный профиль нутриентов, у FNDDS-версии — бытовые порции, и живут они
 * в разных сценариях поиска.
 */
export function dedupKey(kind: UsdaSource["kind"], description: string): string {
  return `${kind} ${normalizeDescription(description)}`;
}

export interface CanonicalFood {
  source: UsdaSource;
  food: FoodRow;
}

/**
 * Выбор канонической записи среди одинаковых описаний.
 *
 * Дубли бывают двух видов, и оба надо гасить, иначе в поиске окажутся две
 * одинаковые «брокколи сырая» с разными цифрами:
 *   1. между источниками — 100 описаний есть и в SR Legacy, и в Foundation;
 *   2. внутри Foundation — 469 строк на 400 описаний: USDA перепубликовывает
 *      продукт с новым fdc_id, когда переснимает лабораторные данные
 *      («Broccoli, raw» есть за 2019-04-01 и за 2019-12-16).
 *
 * Побеждает Foundation (свежие лабораторные замеры), внутри источника — более
 * поздняя публикация, дальше больший fdc_id ради детерминизма.
 */
export function pickCanonical(sources: SourceFoods[]): {
  winners: Map<string, CanonicalFood>;
  losers: Map<string, string[]>;
} {
  const rank = new Map(USDA_SOURCES.map((s, index) => [s.source, index]));
  const best = new Map<string, CanonicalFood>();
  const all = new Map<string, CanonicalFood[]>();

  for (const { source, foods } of sources) {
    for (const food of foods) {
      const key = dedupKey(source.kind, food.description);
      all.set(key, [...(all.get(key) ?? []), { source, food }]);
    }
  }

  const losers = new Map<string, string[]>();
  for (const [key, group] of all) {
    const sorted = [...group].sort((a, b) => {
      const bySource =
        (rank.get(a.source.source) ?? 99) - (rank.get(b.source.source) ?? 99);
      if (bySource !== 0) return bySource;
      const byDate = b.food.publicationDate.localeCompare(a.food.publicationDate);
      if (byDate !== 0) return byDate;
      return Number(b.food.fdcId) - Number(a.food.fdcId);
    });

    best.set(key, sorted[0]);
    for (const loser of sorted.slice(1)) {
      losers.set(loser.source.source, [
        ...(losers.get(loser.source.source) ?? []),
        loser.food.fdcId,
      ]);
    }
  }

  return { winners: best, losers };
}

/** Часть описания до первой запятой: «Broccoli, raw» → «Broccoli». */
export function headName(description: string): string {
  return description.split(",")[0].trim();
}

const RAW_RE = /\b(raw|unprepared|uncooked|unheated)\b/i;
const COOKED_RE =
  /\b(cooked|boiled|roasted|baked|fried|grilled|broiled|braised|steamed|toasted|canned|heated|prepared)\b/i;

/**
 * Сырое / готовое из описания (§8.5 PRD: состояние сохраняем, коэффициенты
 * уварки — вне MVP). «raw» проверяем первым: у USDA он стоит в описаниях
 * вроде «Beef, raw, cooked yield» и означает именно сырое.
 */
export function classifyState(description: string): "raw" | "cooked" | "unknown" {
  if (RAW_RE.test(description)) return "raw";
  if (COOKED_RE.test(description)) return "cooked";
  return "unknown";
}
