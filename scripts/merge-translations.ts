/**
 * Сборка переводов от субагентов в data/translations.json (§8.2 PRD, шаг 4).
 *
 *   npx tsx scripts/merge-translations.ts [--round N] [--strict] [--sample 30]
 *
 * Читает манифест раунда и все out/chunk-*.json, проверяет их и сливает поверх
 * существующего data/translations.json. Формат тот же, что читает
 * loadTranslations() в scripts/import-usda.ts: { "<fdc_id>": {name_ru, synonyms} }.
 *
 * Перевод канонической записи разворачивается на все fdc_id с тем же описанием
 * (в дампах один продукт бывает опубликован дважды) — иначе дубль остался бы
 * с английским названием.
 *
 * Отдельного внимания стоят коллизии синонимов: уникальность
 * `ingredient_aliases (alias, lang)` — общая на весь справочник, поэтому синоним,
 * на который претендуют несколько продуктов, ведёт на произвольный из них.
 * Совсем родовые (8+ претендентов) выбрасываем здесь, остальные разрешает
 * ранжирование в импортёре.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_RESERVED } from "./lib/usda";

const DATA = join(process.cwd(), "data");
const OUT_PATH = join(DATA, "translations.json");
const MAX_CLAIMANTS = 8;
const NAME_HARD_LIMIT = 80;
const NAME_SOFT_LIMIT = 60;

interface Translation {
  name_ru: string;
  synonyms: string[];
}

interface ManifestChunk {
  chunk: string;
  in: string;
  out: string;
  count: number;
  items: { fdc_id: string; fdc_ids: string[] }[];
}

interface Manifest {
  round: number;
  chunkSize: number;
  totalItems: number;
  chunks: ManifestChunk[];
}

const hasCyrillic = (value: string) => /[а-яёА-ЯЁ]/.test(value);

function latestRound(): number {
  const dir = join(DATA, "translations");
  if (!existsSync(dir)) throw new Error("data/translations/ нет — сначала usda:chunks");
  const numbers = readdirSync(dir)
    .map((name) => Number(name.replace("round-", "")))
    .filter((n) => Number.isFinite(n));
  if (numbers.length === 0) throw new Error("раундов не найдено — сначала usda:chunks");
  return Math.max(...numbers);
}

async function main() {
  const args = process.argv.slice(2);
  const roundArg = args.indexOf("--round");
  const round = roundArg >= 0 ? Number(args[roundArg + 1]) : latestRound();
  const strict = args.includes("--strict");
  const sampleArg = args.indexOf("--sample");
  const sampleSize = sampleArg >= 0 ? Number(args[sampleArg + 1]) : 0;

  const roundDir = join(DATA, "translations", `round-${round}`);
  const manifestPath = join(roundDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} не найден`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  const collected = new Map<string, Translation>();
  const missing: { chunk: string; fdcId: string }[] = [];
  const problems = {
    brokenChunks: [] as string[],
    hallucinated: 0,
    notRussian: 0,
    tooLong: 0,
    softLong: 0,
    badSynonyms: 0,
  };

  for (const chunk of manifest.chunks) {
    const outPath = join(process.cwd(), chunk.out);
    let parsed: Record<string, Partial<Translation>> = {};
    if (!existsSync(outPath)) {
      problems.brokenChunks.push(`${chunk.chunk} (файла нет)`);
      for (const item of chunk.items) missing.push({ chunk: chunk.chunk, fdcId: item.fdc_id });
      continue;
    }
    try {
      parsed = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      problems.brokenChunks.push(`${chunk.chunk} (битый JSON)`);
      for (const item of chunk.items) missing.push({ chunk: chunk.chunk, fdcId: item.fdc_id });
      continue;
    }

    const expected = new Map(chunk.items.map((item) => [item.fdc_id, item.fdc_ids]));
    for (const key of Object.keys(parsed)) {
      if (!expected.has(key)) problems.hallucinated += 1;
    }

    for (const item of chunk.items) {
      const value = parsed[item.fdc_id];
      const nameRu = value?.name_ru?.trim();

      if (!nameRu || !hasCyrillic(nameRu)) {
        if (nameRu) problems.notRussian += 1;
        missing.push({ chunk: chunk.chunk, fdcId: item.fdc_id });
        continue;
      }
      if (nameRu.length > NAME_HARD_LIMIT) {
        problems.tooLong += 1;
        missing.push({ chunk: chunk.chunk, fdcId: item.fdc_id });
        continue;
      }
      if (nameRu.length > NAME_SOFT_LIMIT) problems.softLong += 1;

      const raw = Array.isArray(value?.synonyms) ? value.synonyms : [];
      if (!Array.isArray(value?.synonyms)) problems.badSynonyms += 1;
      const synonyms: string[] = [];
      for (const synonym of raw) {
        if (typeof synonym !== "string") continue;
        const clean = synonym.toLowerCase().trim();
        if (clean.length < 2 || clean.length > NAME_SOFT_LIMIT) continue;
        if (!hasCyrillic(clean)) continue;
        if (clean === nameRu.toLowerCase()) continue;
        if (E2E_RESERVED.has(clean)) continue;
        if (synonyms.includes(clean)) continue;
        synonyms.push(clean);
      }

      // Перевод канонической записи достаётся всем её дублям.
      for (const fdcId of expected.get(item.fdc_id) ?? [item.fdc_id]) {
        collected.set(fdcId, { name_ru: nameRu, synonyms: synonyms.slice(0, 4) });
      }
    }
  }

  // Коллизии синонимов считаем по каноническим позициям, а не по строкам:
  // дубли одного продукта не должны выглядеть как спор двух разных.
  const claimants = new Map<string, Set<string>>();
  for (const chunk of manifest.chunks) {
    for (const item of chunk.items) {
      for (const synonym of collected.get(item.fdc_id)?.synonyms ?? []) {
        const set = claimants.get(synonym) ?? new Set<string>();
        set.add(item.fdc_id);
        claimants.set(synonym, set);
      }
    }
  }
  const generic = new Set(
    [...claimants].filter(([, owners]) => owners.size >= MAX_CLAIMANTS).map(([alias]) => alias),
  );
  if (generic.size > 0) {
    for (const [fdcId, value] of collected) {
      collected.set(fdcId, {
        ...value,
        synonyms: value.synonyms.filter((s) => !generic.has(s)),
      });
    }
  }

  const existing: Record<string, Translation> = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, "utf8"))
    : {};
  for (const [fdcId, value] of collected) existing[fdcId] = value;

  const sorted: Record<string, Translation> = {};
  for (const key of Object.keys(existing).sort((a, b) => Number(a) - Number(b))) {
    sorted[key] = existing[key];
  }
  mkdirSync(DATA, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 1), "utf8");

  // ── Отчёт ────────────────────────────────────────────────────────────────
  const done = manifest.totalItems - missing.length;
  console.log(`\nПокрытие раунда: ${done}/${manifest.totalItems}`);
  console.log(`Всего в translations.json: ${Object.keys(sorted).length}`);

  if (problems.brokenChunks.length > 0) {
    console.log(`⚠ проблемные чанки: ${problems.brokenChunks.join(", ")}`);
  }
  if (missing.length > 0) {
    const byChunk = new Map<string, number>();
    for (const item of missing) byChunk.set(item.chunk, (byChunk.get(item.chunk) ?? 0) + 1);
    console.log(
      `⚠ не переведено: ${missing.length} — ` +
        [...byChunk].map(([chunk, n]) => `${chunk}: ${n}`).join(", "),
    );
    console.log(`  первые: ${missing.slice(0, 20).map((m) => m.fdcId).join(", ")}`);
  }
  if (problems.hallucinated > 0) console.log(`⚠ лишних fdc_id в ответах: ${problems.hallucinated}`);
  if (problems.notRussian > 0) console.log(`⚠ без кириллицы: ${problems.notRussian}`);
  if (problems.tooLong > 0) console.log(`⚠ длиннее ${NAME_HARD_LIMIT} символов: ${problems.tooLong}`);
  if (problems.softLong > 0) console.log(`  длиннее ${NAME_SOFT_LIMIT} символов: ${problems.softLong}`);
  if (problems.badSynonyms > 0) console.log(`  synonyms не массив: ${problems.badSynonyms}`);

  const collisions = [...claimants]
    .filter(([, owners]) => owners.size > 1)
    .sort(([, a], [, b]) => b.size - a.size);
  console.log(
    `Синонимов: ${claimants.size}, спорных: ${collisions.length}, ` +
      `выброшено как родовые (${MAX_CLAIMANTS}+ претендентов): ${generic.size}`,
  );
  if (collisions.length > 0) {
    console.log(
      `  топ: ${collisions.slice(0, 10).map(([alias, owners]) => `${alias} (${owners.size})`).join(", ")}`,
    );
  }

  if (sampleSize > 0) {
    console.log(`\nВыборка на глаз:`);
    const keys = [...collected.keys()];
    const step = Math.max(1, Math.floor(keys.length / sampleSize));
    for (let i = 0; i < keys.length && i / step < sampleSize; i += step) {
      const value = collected.get(keys[i])!;
      console.log(`  ${value.name_ru}  [${value.synonyms.join(", ")}]`);
    }
  }

  console.log(`\nГотово. Дальше: npx tsx scripts/import-usda.ts --dry-run`);

  const failed =
    missing.length + problems.brokenChunks.length + problems.hallucinated + problems.tooLong;
  if (strict && failed > 0) {
    console.error(`\n--strict: ${failed} проблем, выхожу с ошибкой`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
