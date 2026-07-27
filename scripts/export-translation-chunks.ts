/**
 * Выгрузка названий на перевод субагентами (§8.2 PRD, шаги 1–2).
 *
 *   npx tsx scripts/export-translation-chunks.ts [--round N] [--chunk-size 300] [--force]
 *
 * Раньше названия гонялись батчами через внешний LLM API. Теперь перевод делают
 * субагенты Claude Code: скрипт раскладывает работу по файлам-чанкам, агенты
 * пишут рядом свои `.out.json`, а scripts/merge-translations.ts собирает всё в
 * data/translations.json — формат тот же, импортёр менять не пришлось.
 *
 * Читаем CSV, а не БД: тогда перевод не требует предварительного импорта и
 * справочник заливается один раз, сразу с русскими названиями.
 *
 * Переводим только канонические записи (см. pickCanonical): одинаковые описания
 * из разных дампов должны получить один и тот же русский, а не два разных.
 *
 * Раунды аддитивны: `--round 2` вычтет всё, что уже переведено или уже разложено
 * в предыдущие раунды, и нарежет только остаток. Так добираются позиции,
 * которые агент пропустил.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  USDA_SOURCES,
  loadCategories,
  loadFoods,
  normalizeDescription,
  pickCanonical,
} from "./lib/usda";

const DATA = join(process.cwd(), "data");
const ROUNDS_DIR = join(DATA, "translations");

interface ManifestItem {
  fdc_id: string;
  /** Все fdc_id с этим же описанием — на них перевод разойдётся при сборке. */
  fdc_ids: string[];
}

interface ManifestChunk {
  chunk: string;
  in: string;
  out: string;
  count: number;
  items: ManifestItem[];
}

/** fdc_id, для которых перевод уже есть или уже заказан в прошлых раундах. */
function alreadyCovered(): Set<string> {
  const covered = new Set<string>();

  const jsonPath = join(DATA, "translations.json");
  if (existsSync(jsonPath)) {
    for (const key of Object.keys(JSON.parse(readFileSync(jsonPath, "utf8")))) {
      covered.add(key);
    }
  }

  const overridePath = join(DATA, "translations.override.csv");
  if (existsSync(overridePath)) {
    for (const line of readFileSync(overridePath, "utf8").split("\n").slice(1)) {
      const fdcId = line.split(",")[0]?.trim().replace(/^"|"$/g, "");
      if (fdcId) covered.add(fdcId);
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
          for (const key of Object.keys(parsed)) covered.add(key);
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
  const chunkSize = sizeArg >= 0 ? Number(args[sizeArg + 1]) : 300;
  const force = args.includes("--force");

  const roundDir = join(ROUNDS_DIR, `round-${round}`);
  if (existsSync(roundDir) && !force) {
    throw new Error(
      `${roundDir} уже существует — раздайте его агентам или запустите с --force ` +
        `(перезапись затрёт уже розданные чанки)`,
    );
  }

  const sources = [];
  for (const source of USDA_SOURCES) {
    sources.push({ source, foods: await loadFoods(source) });
  }
  const categories = await loadCategories(USDA_SOURCES[0].dir);

  // Все fdc_id по нормализованному описанию — чтобы перевод канонической
  // записи разошёлся и на её дубли.
  const idsByKey = new Map<string, string[]>();
  for (const { foods } of sources) {
    for (const food of foods) {
      const key = normalizeDescription(food.description);
      idsByKey.set(key, [...(idsByKey.get(key) ?? []), food.fdcId]);
    }
  }

  const { winners } = pickCanonical(sources);
  const covered = alreadyCovered();
  const pending = [...winners.entries()]
    .filter(([, { food }]) => !covered.has(food.fdcId))
    .sort(([, a], [, b]) => Number(a.food.fdcId) - Number(b.food.fdcId));

  console.log(
    `\nУникальных описаний: ${winners.size}, уже переведено: ${winners.size - pending.length}, к переводу: ${pending.length}`,
  );
  if (pending.length === 0) {
    console.log("Готово. Переводить нечего.");
    return;
  }

  mkdirSync(join(roundDir, "in"), { recursive: true });
  mkdirSync(join(roundDir, "out"), { recursive: true });

  const chunks: ManifestChunk[] = [];
  const total = Math.ceil(pending.length / chunkSize);
  for (let index = 0; index < total; index += 1) {
    const slice = pending.slice(index * chunkSize, (index + 1) * chunkSize);
    const name = `chunk-${String(index + 1).padStart(2, "0")}`;
    const inPath = join("data", "translations", `round-${round}`, "in", `${name}.json`);
    const outPath = join("data", "translations", `round-${round}`, "out", `${name}.json`);

    const items = slice.map(([, { food }]) => ({
      fdc_id: food.fdcId,
      description: food.description,
      category: food.categoryId ? categories.get(food.categoryId) ?? null : null,
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
      items: slice.map(([key, { food }]) => ({
        fdc_id: food.fdcId,
        fdc_ids: idsByKey.get(key) ?? [food.fdcId],
      })),
    });
  }

  writeFileSync(
    join(roundDir, "manifest.json"),
    JSON.stringify({ round, chunkSize, totalItems: pending.length, chunks }, null, 1),
    "utf8",
  );

  console.log(`Чанков: ${chunks.length} по ${chunkSize} → ${roundDir}`);
  console.log(
    `Дальше: раздайте in/chunk-*.json субагентам, затем\n` +
      `  npx tsx scripts/merge-translations.ts --round ${round}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
