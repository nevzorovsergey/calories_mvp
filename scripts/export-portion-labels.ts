/**
 * Выгрузка подписей порций на перевод субагентами (§8.2 PRD, порции блюд).
 *
 *   npx tsx scripts/export-portion-labels.ts [--round N] [--chunk-size 600] [--force]
 *
 * `ingredient_portions.label_en` — это текст из дампа как есть: «1 cup»,
 * «1 piece (1/6 of 8" square, approx 2-1/2" x 4")». Показывать его пользователю
 * нельзя — он получит дюймы и унции, — а перевести каждую из 22 045 строк
 * отдельно незачем: уникальных подписей всего 1134, и 411 из них покрывают 95%
 * строк. Поэтому переводится словарь подписей, а не строки таблицы.
 *
 * Читаем CSV, а не БД: перевод тогда не зависит от того, залит ли импорт, — та же
 * логика, что у scripts/export-translation-chunks.ts.
 *
 * Раунды аддитивны: `--round 2` вычтет всё, что уже переведено или уже разложено
 * в предыдущие раунды, и нарежет только остаток.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORTION_LABEL, loadPortions } from "./lib/fndds";

const DATA = join(process.cwd(), "data");
const ROUNDS_DIR = join(DATA, "portions");
const DICT_PATH = join(DATA, "portion-labels.json");

interface ManifestChunk {
  chunk: string;
  in: string;
  out: string;
  count: number;
  labels: string[];
}

/** Подписи, для которых перевод уже есть или уже заказан в прошлых раундах. */
function alreadyCovered(): Set<string> {
  const covered = new Set<string>();

  // Порция по умолчанию агентам не отдаётся: её русское имя задано в импортёре
  // (см. scripts/import-portion-labels.ts) и не обсуждается.
  covered.add(DEFAULT_PORTION_LABEL);

  if (existsSync(DICT_PATH)) {
    for (const key of Object.keys(JSON.parse(readFileSync(DICT_PATH, "utf8")))) {
      covered.add(key);
    }
  }

  if (existsSync(ROUNDS_DIR)) {
    for (const round of readdirSync(ROUNDS_DIR)) {
      const outDir = join(ROUNDS_DIR, round, "out");
      if (!existsSync(outDir)) continue;
      for (const file of readdirSync(outDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(readFileSync(join(outDir, file), "utf8"));
          // Считаем переведённым только то, что примет импортёр. Иначе подпись,
          // которую агент оставил латиницей, разом и не попадает в словарь, и не
          // возвращается в следующий раунд — и чинить её нечем, кроме рук.
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string" && /[а-яёА-ЯЁ]/.test(value)) covered.add(key);
          }
        } catch {
          console.warn(`  ⚠ ${round}/out/${file} не читается как JSON — не считаю переведённым`);
        }
      }
    }
  }

  return covered;
}

function nextRound(): number {
  if (!existsSync(ROUNDS_DIR)) return 1;
  const numbers = readdirSync(ROUNDS_DIR)
    .map((name) => Number(name.replace("round-", "")))
    .filter((n) => Number.isFinite(n));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

async function main() {
  const args = process.argv.slice(2);
  const roundArg = args.indexOf("--round");
  const round = roundArg >= 0 ? Number(args[roundArg + 1]) : nextRound();
  const sizeArg = args.indexOf("--chunk-size");
  const chunkSize = sizeArg >= 0 ? Number(args[sizeArg + 1]) : 600;
  const force = args.includes("--force");

  const roundDir = join(ROUNDS_DIR, `round-${round}`);
  if (existsSync(roundDir) && !force) {
    throw new Error(
      `${roundDir} уже существует — раздайте его агентам или запустите с --force ` +
        `(перезапись затрёт уже розданные чанки)`,
    );
  }

  const byFood = await loadPortions();
  /** Сколько строк таблицы стоит за подписью и с каким весом она встречается. */
  const stats = new Map<string, { count: number; grams: number[] }>();
  let rows = 0;
  for (const list of byFood.values()) {
    for (const portion of list) {
      rows += 1;
      const entry = stats.get(portion.labelEn) ?? { count: 0, grams: [] };
      entry.count += 1;
      entry.grams.push(portion.gramWeight);
      stats.set(portion.labelEn, entry);
    }
  }

  const covered = alreadyCovered();
  // Порядок по частоте: если раунд придётся оборвать, непереведённым останется
  // хвост из редких подписей, а не «1 cup».
  const pending = [...stats.entries()]
    .filter(([label]) => !covered.has(label))
    .sort(([, a], [, b]) => b.count - a.count);

  const pendingRows = pending.reduce((sum, [, entry]) => sum + entry.count, 0);
  console.log(
    `\nСтрок порций: ${rows}, уникальных подписей: ${stats.size}, ` +
      `уже переведено: ${stats.size - pending.length}, к переводу: ${pending.length} ` +
      `(за ними ${pendingRows} строк, ${((pendingRows / rows) * 100).toFixed(1)}%)`,
  );
  if (pending.length === 0) {
    console.log("Готово. Переводить нечего.");
    return;
  }

  mkdirSync(join(roundDir, "in"), { recursive: true });
  mkdirSync(join(roundDir, "out"), { recursive: true });

  const chunks: ManifestChunk[] = [];
  for (let offset = 0; offset < pending.length; offset += chunkSize) {
    const slice = pending.slice(offset, offset + chunkSize);
    const name = `chunk-${String(chunks.length + 1).padStart(2, "0")}-portion`;
    const inPath = join("data", "portions", `round-${round}`, "in", `${name}.json`);
    const outPath = join("data", "portions", `round-${round}`, "out", `${name}.json`);

    const items = slice.map(([label, entry]) => ({
      label_en: label,
      /** Сколько порций в справочнике подписаны так — приоритет для вычитки. */
      count: entry.count,
      /** Медианный вес: по нему видно, что «1 cup» здесь про еду, а не про объём. */
      grams: Number(
        [...entry.grams].sort((a, b) => a - b)[Math.floor(entry.grams.length / 2)].toFixed(1),
      ),
    }));

    writeFileSync(
      join(process.cwd(), inPath),
      JSON.stringify({ chunk: name, out: outPath, count: items.length, items }, null, 1),
      "utf8",
    );

    chunks.push({
      chunk: name,
      in: inPath,
      out: outPath,
      count: items.length,
      labels: slice.map(([label]) => label),
    });
  }

  writeFileSync(
    join(roundDir, "manifest.json"),
    JSON.stringify({ round, chunkSize, totalItems: pending.length, chunks }, null, 1),
    "utf8",
  );

  console.log(`Чанков: ${chunks.length} по ${chunkSize} → ${roundDir}`);
  console.log(
    `Дальше: раздайте in/chunk-*.json субагентам (промпт — data/README.md,\n` +
      `«Промпт для подписей порций»), затем\n` +
      `  npx tsx scripts/import-portion-labels.ts --round ${round}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
