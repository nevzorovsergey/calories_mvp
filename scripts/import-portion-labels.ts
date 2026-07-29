/**
 * Сборка словаря подписей порций и заливка `label_ru` в БД (§8.2 PRD).
 *
 *   npx tsx scripts/import-portion-labels.ts [--round N] [--dry-run] [--chunk N]
 *
 * Читает out/chunk-*.json раунда (готовит scripts/export-portion-labels.ts +
 * субагенты), проверяет их, сливает в data/portion-labels.json и проставляет
 * `ingredient_portions.label_ru` по этому словарю.
 *
 * Ключ словаря — сам английский текст, а не id строки: подпись «1 cup» стоит у
 * трёх тысяч порций разных блюд, и перевод у неё один. Поэтому скрипт
 * идемпотентен и не зависит от того, перезаливался ли между делом импорт
 * справочника — id строк меняются, тексты нет.
 *
 * `--dry-run` не пишет ни словарь, ни БД, но печатает весь отчёт.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { createAdminClient } from "../src/lib/supabase/admin";
import { DEFAULT_PORTION_LABEL } from "./lib/fndds";

loadEnv({ path: ".env.local" });

const DATA = join(process.cwd(), "data");
const ROUNDS_DIR = join(DATA, "portions");
const DICT_PATH = join(DATA, "portion-labels.json");

/**
 * Русское имя порции по умолчанию.
 *
 * В дампе «Quantity not specified» — рядовая строка food_portion, но по смыслу
 * это официальный размер FNDDS «сколько обычно съедают за раз» (5325 блюд,
 * `is_default = true`). Переводить её буквально нельзя: «количество не указано»
 * в списке порций читается как ошибка данных, а не как готовый ответ. Поэтому
 * подпись задана здесь, а не отдаётся на перевод.
 */
const DEFAULT_PORTION_LABEL_RU = "обычная порция";

/** Размер пачки записи: проект в Огайо, заливка из России (см. import-usda.ts). */
let CHUNK = 100;

const NAME_LIMIT = 80;
const hasCyrillic = (value: string) => /[а-яёА-ЯЁ]/.test(value);
/** Дюймы и унции — то, ради чего подписи и переводились. */
const IMPERIAL = /\b(inch|inches|oz|ounce|ounces|lb|pound|pounds|fl\s*oz)\b|["″]/i;

interface ManifestChunk {
  chunk: string;
  in: string;
  out: string;
  count: number;
  labels: string[];
}

interface Manifest {
  round: number;
  chunkSize: number;
  totalItems: number;
  chunks: ManifestChunk[];
}

interface PortionRow {
  id: number;
  label_en: string;
  label_ru: string | null;
}

/**
 * Повтор сетевого шага.
 *
 * Задержки длиннее, чем в import-usda.ts, и их больше: проект в Огайо, заливка
 * идёт из России, и связь проваливается не по одному запросу, а окном на минуту
 * с лишним — в такое окно три попытки за 12 секунд укладываются целиком и
 * роняют прогон. Ошибки данных так не лечатся, но они и не «fetch failed»:
 * после исчерпания задержек бросаем, как раньше.
 */
async function withRetry<T>(
  label: string,
  run: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  const delays = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000];
  for (let attempt = 0; ; attempt += 1) {
    const { data, error } = await run();
    if (!error) return data;
    if (attempt >= delays.length) throw new Error(`${label}: ${error.message}`);
    console.warn(`  ⚠ ${label}: ${error.message} — повтор через ${delays[attempt] / 1000} с`);
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}

function latestRound(): number {
  if (!existsSync(ROUNDS_DIR)) throw new Error("data/portions/ нет — сначала usda:portions");
  const numbers = readdirSync(ROUNDS_DIR)
    .map((name) => Number(name.replace("round-", "")))
    .filter((n) => Number.isFinite(n));
  if (numbers.length === 0) throw new Error("раундов не найдено — сначала usda:portions");
  return Math.max(...numbers);
}

/** Словарь из всех раундов сразу: раунды аддитивны, поздний перевод важнее раннего. */
function collectDictionary(round: number): {
  dictionary: Map<string, string>;
  missing: string[];
  problems: { brokenChunks: string[]; notRussian: number; tooLong: number; imperial: number };
} {
  const dictionary = new Map<string, string>();
  const problems = { brokenChunks: [] as string[], notRussian: 0, tooLong: 0, imperial: 0 };

  const manifestPath = join(ROUNDS_DIR, `round-${round}`, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} не найден`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  const missing: string[] = [];
  for (const chunk of manifest.chunks) {
    const outPath = join(process.cwd(), chunk.out);
    let parsed: Record<string, unknown> = {};
    if (!existsSync(outPath)) {
      problems.brokenChunks.push(`${chunk.chunk} (файла нет)`);
      missing.push(...chunk.labels);
      continue;
    }
    try {
      parsed = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      problems.brokenChunks.push(`${chunk.chunk} (битый JSON)`);
      missing.push(...chunk.labels);
      continue;
    }

    for (const label of chunk.labels) {
      const value = typeof parsed[label] === "string" ? (parsed[label] as string).trim() : "";
      if (!value || !hasCyrillic(value)) {
        if (value) problems.notRussian += 1;
        missing.push(label);
        continue;
      }
      if (value.length > NAME_LIMIT) {
        problems.tooLong += 1;
        missing.push(label);
        continue;
      }
      // Дюйм, доживший до русской подписи, — это невыполненная работа, а не
      // мелочь оформления: ради него подписи и переводились.
      if (IMPERIAL.test(value)) problems.imperial += 1;
      dictionary.set(label, value);
    }
  }

  return { dictionary, missing, problems };
}

/** Все строки порций: id нужны, чтобы обновлять по ключу, а не по тексту с кавычками. */
async function loadPortionRows(supabase: SupabaseClient): Promise<PortionRow[]> {
  const rows: PortionRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const batch = await withRetry("ingredient_portions select", () =>
      supabase
        .from("ingredient_portions")
        .select("id, label_en, label_ru")
        .order("id")
        .range(from, from + page - 1),
    );
    rows.push(...((batch ?? []) as PortionRow[]));
    if (!batch || batch.length < page) break;
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const roundArg = args.indexOf("--round");
  const round = roundArg >= 0 ? Number(args[roundArg + 1]) : latestRound();
  const chunkArg = args.indexOf("--chunk");
  if (chunkArg >= 0) {
    const size = Number(args[chunkArg + 1]);
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`--chunk ${args[chunkArg + 1]}: ожидается целое число ≥ 1`);
    }
    CHUNK = size;
  }

  const { dictionary, missing, problems } = collectDictionary(round);
  // Порция по умолчанию не переводится агентами — см. DEFAULT_PORTION_LABEL_RU.
  dictionary.set(DEFAULT_PORTION_LABEL, DEFAULT_PORTION_LABEL_RU);

  const existing: Record<string, string> = existsSync(DICT_PATH)
    ? JSON.parse(readFileSync(DICT_PATH, "utf8"))
    : {};
  for (const [label, value] of dictionary) existing[label] = value;

  console.log(`\nПодписей в раунде ${round}: ${dictionary.size - 1} переведено, ${missing.length} нет`);
  if (problems.brokenChunks.length > 0) {
    console.log(`⚠ проблемные чанки: ${problems.brokenChunks.join(", ")}`);
  }
  if (problems.notRussian > 0) console.log(`⚠ без кириллицы: ${problems.notRussian}`);
  if (problems.tooLong > 0) console.log(`⚠ длиннее ${NAME_LIMIT} символов: ${problems.tooLong}`);
  if (problems.imperial > 0) {
    console.log(`⚠ остались дюймы или унции: ${problems.imperial} — их надо было пересчитать`);
  }
  if (missing.length > 0) {
    console.log(`  первые непереведённые: ${missing.slice(0, 10).map((l) => `«${l}»`).join(", ")}`);
  }

  if (!dryRun) {
    mkdirSync(DATA, { recursive: true });
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(existing).sort()) sorted[key] = existing[key];
    writeFileSync(DICT_PATH, JSON.stringify(sorted, null, 1), "utf8");
    console.log(`Словарь: ${Object.keys(sorted).length} подписей → data/portion-labels.json`);
  }

  const supabase = createAdminClient();
  const rows = await loadPortionRows(supabase);
  console.log(`Строк порций в БД: ${rows.length}`);

  // Группируем по русской подписи: обновление идёт одним PATCH на группу id, а не
  // фильтром по label_en — в тексте подписи есть и кавычки, и запятые, и скобки.
  const idsByLabelRu = new Map<string, number[]>();
  let untouched = 0;
  const unknown = new Map<string, number>();
  for (const row of rows) {
    const labelRu = existing[row.label_en];
    if (!labelRu) {
      unknown.set(row.label_en, (unknown.get(row.label_en) ?? 0) + 1);
      continue;
    }
    if (row.label_ru === labelRu) {
      untouched += 1;
      continue;
    }
    idsByLabelRu.set(labelRu, [...(idsByLabelRu.get(labelRu) ?? []), row.id]);
  }

  const toUpdate = [...idsByLabelRu.values()].reduce((sum, ids) => sum + ids.length, 0);
  const unknownRows = [...unknown.values()].reduce((sum, n) => sum + n, 0);
  console.log(
    `  обновить: ${toUpdate}, уже стоит верное: ${untouched}, ` +
      `без перевода: ${unknownRows} строк (${unknown.size} подписей)`,
  );
  if (unknown.size > 0) {
    const top = [...unknown].sort(([, a], [, b]) => b - a).slice(0, 10);
    console.log(`  топ без перевода: ${top.map(([l, n]) => `«${l}» (${n})`).join(", ")}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: в БД ничего не пишу");
    return;
  }

  let written = 0;
  let reported = 0;
  for (const [labelRu, ids] of idsByLabelRu) {
    for (let offset = 0; offset < ids.length; offset += CHUNK) {
      const slice = ids.slice(offset, offset + CHUNK);
      await withRetry("ingredient_portions update", () =>
        supabase.from("ingredient_portions").update({ label_ru: labelRu }).in("id", slice),
      );
      written += slice.length;
      // Шаг прогресса считаем от порога, а не по остатку от `written`: групп с
      // одной строкой сотни, и остаток попадал бы в окно на каждой второй.
      if (written - reported >= 2000) {
        reported = written;
        console.log(`  ${written}/${toUpdate}`);
      }
    }
  }

  const after = await loadPortionRows(supabase);
  const filled = after.filter((row) => row.label_ru).length;
  const defaults = after.filter((row) => row.label_ru === DEFAULT_PORTION_LABEL_RU).length;
  console.log(
    `\nГотово. label_ru заполнен у ${filled}/${after.length} строк ` +
      `(${((filled / after.length) * 100).toFixed(1)}%), ` +
      `из них «${DEFAULT_PORTION_LABEL_RU}»: ${defaults}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
