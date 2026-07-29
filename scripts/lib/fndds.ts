/**
 * Чтение того, чего нет у сырья: порций и раскладки блюд FNDDS (§8.1 PRD).
 *
 * SR Legacy и Foundation — это продукты с профилем нутриентов и всё. FNDDS
 * добавляет два файла, ради которых его и берут:
 *
 *   food_portion.csv — бытовые порции с граммовкой;
 *   input_food.csv   — из чего блюдо состоит и в какой пропорции.
 *
 * Оба разбираются здесь, а не в scripts/lib/usda.ts: там общий контракт всех
 * дампов, и подмешивать в него файлы, которых у двух источников из трёх нет,
 * значило бы сделать общий код зависимым от частного случая.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, readCsv } from "./usda";

const SURVEY_DIR = "survey";

/**
 * Порция FNDDS «сколько обычно съедают за раз», когда количество не назвали.
 * В дампе это обычная строка food_portion, но по смыслу — размер по умолчанию,
 * и в интерфейсе она должна предлагаться первой.
 */
export const DEFAULT_PORTION_LABEL = "Quantity not specified";

/** Псевдо-компоненты фортификации: «Vitamin D as ingredient», «Calcium as ingredient». */
const FORTIFICANT_PREFIX = "999";

export interface PortionRow {
  fdcId: string;
  seq: number;
  labelEn: string;
  gramWeight: number;
  isDefault: boolean;
}

export interface ComponentRow {
  /** fdc_id блюда, которому принадлежит компонент. */
  dishFdcId: string;
  seq: number;
  /** Код компонента: NDB-номер SR Legacy либо восьмизначный food_code FNDDS. */
  code: string;
  descriptionEn: string;
  gramWeight: number;
  /** Доля компонента в блюде, 0..1. Считается здесь — см. комментарий ниже. */
  share: number;
  retentionCode: string | null;
}

function surveyPath(file: string): string {
  return join(DATA_DIR, SURVEY_DIR, file);
}

export function hasSurveyDump(): boolean {
  return existsSync(surveyPath("food.csv"));
}

/**
 * Порции блюд. Строки без веса отбрасываем: `gram_weight = 0` встречается у
 * «Quantity not specified» тех блюд, для которых USDA размер по умолчанию не
 * определил, и такая порция бесполезна — выбрать её пользователь не сможет.
 */
export async function loadPortions(): Promise<Map<string, PortionRow[]>> {
  const path = surveyPath("food_portion.csv");
  if (!existsSync(path)) return new Map();

  const rows = await readCsv(path);
  const byFood = new Map<string, PortionRow[]>();

  for (const row of rows) {
    const gramWeight = Number(row.gram_weight);
    if (!Number.isFinite(gramWeight) || gramWeight <= 0) continue;
    const labelEn = (row.portion_description ?? "").trim();
    if (!labelEn) continue;

    const list = byFood.get(row.fdc_id) ?? [];
    list.push({
      fdcId: row.fdc_id,
      // Нумеруем заново: seq_num в дампе разрежен, а на (ingredient_id, seq)
      // висит уникальный индекс.
      seq: Number(row.seq_num) || list.length + 1,
      labelEn,
      gramWeight,
      isDefault: labelEn === DEFAULT_PORTION_LABEL,
    });
    byFood.set(row.fdc_id, list);
  }

  for (const [fdcId, list] of byFood) {
    list.sort((a, b) => a.seq - b.seq);
    byFood.set(
      fdcId,
      list.map((portion, index) => ({ ...portion, seq: index + 1 })),
    );
  }

  return byFood;
}

/**
 * Раскладка блюд на компоненты.
 *
 * `share` считается здесь, а не при показе, потому что рецепт в дампе не
 * нормирован: сумма граммов компонентов — медианно 100.6 г, но у десятой части
 * блюд больше 600 г (рецепт дан на выход целиком, а не на 100 г готового).
 * Опираться на сами граммы при масштабировании состава на вес порции нельзя,
 * опираться можно только на долю.
 *
 * Компоненты-фортификанты (`999xxx`) выбрасываем до расчёта долей: это не еда, а
 * добавленные витамины, у них нулевой вес, и в составе блюда им не место.
 */
export async function loadComponents(): Promise<Map<string, ComponentRow[]>> {
  const path = surveyPath("input_food.csv");
  if (!existsSync(path)) return new Map();

  const rows = await readCsv(path);
  const byDish = new Map<string, Omit<ComponentRow, "share">[]>();
  let fortificants = 0;

  for (const row of rows) {
    const code = (row.sr_code ?? "").trim();
    if (!code) continue;
    if (code.startsWith(FORTIFICANT_PREFIX)) {
      fortificants += 1;
      continue;
    }
    const gramWeight = Number(row.gram_weight);
    if (!Number.isFinite(gramWeight) || gramWeight <= 0) continue;

    const list = byDish.get(row.fdc_id) ?? [];
    list.push({
      dishFdcId: row.fdc_id,
      seq: Number(row.seq_num) || list.length + 1,
      code,
      descriptionEn: (row.sr_description ?? "").trim(),
      gramWeight,
      retentionCode: row.retention_code && row.retention_code !== "0"
        ? row.retention_code
        : null,
    });
    byDish.set(row.fdc_id, list);
  }

  if (fortificants > 0) {
    console.log(`  ⏭ пропущено ${fortificants} компонентов-фортификантов (999xxx)`);
  }

  const result = new Map<string, ComponentRow[]>();
  for (const [dishFdcId, list] of byDish) {
    const total = list.reduce((sum, item) => sum + item.gramWeight, 0);
    if (total <= 0) continue;
    result.set(
      dishFdcId,
      [...list]
        .sort((a, b) => a.seq - b.seq)
        .map((item, index) => ({
          ...item,
          seq: index + 1,
          share: item.gramWeight / total,
        })),
    );
  }

  return result;
}

/**
 * Мост «код компонента → fdc_id».
 *
 * `input_food.sr_code` — единственная колонка, но кодов в ней два разных вида, и
 * это не задокументировано нигде, кроме самих данных:
 *
 *   14 079 строк — NDB-номера SR Legacy (`sr_legacy_food.csv`, колонка NDB_number);
 *    4 214 строк — восьмизначные food_code самого FNDDS, то есть БЛЮДО ВНУТРИ
 *                  БЛЮДА (608 уникальных). Резолвятся через survey_fndds_food.csv.
 *
 * Коллизий между видами нет: NDB-номера до пяти знаков, food_code ровно восемь.
 * SR кладём первым — так задокументирован смысл колонки.
 */
export async function loadComponentBridge(): Promise<Map<string, string>> {
  const bridge = new Map<string, string>();

  const srPath = join(DATA_DIR, "sr_legacy", "sr_legacy_food.csv");
  if (existsSync(srPath)) {
    for (const row of await readCsv(srPath)) {
      if (row.NDB_number) bridge.set(row.NDB_number, row.fdc_id);
    }
  } else {
    console.warn(
      `  ⚠ ${srPath} не найден — компоненты из SR Legacy не привяжутся.\n` +
        `    Файл лежит в дампе FoodData_Central_sr_legacy_food_csv_2018-04.zip.`,
    );
  }

  const surveyPathFile = surveyPath("survey_fndds_food.csv");
  if (existsSync(surveyPathFile)) {
    for (const row of await readCsv(surveyPathFile)) {
      if (row.food_code && !bridge.has(row.food_code)) {
        bridge.set(row.food_code, row.fdc_id);
      }
    }
  }

  return bridge;
}
