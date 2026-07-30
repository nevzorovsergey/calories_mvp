/**
 * Тикет 01, шаг 2: нарезка словаря Povarenok на чанки для субагентов.
 *
 * Субагенту не отдаётся весь справочник на 8265 позиций — вместо этого для
 * каждого названия здесь заранее находятся кандидаты триграммным поиском
 * (`search_ingredients`, миграция 0007), и агент только выбирает из списка либо
 * говорит «ничего не подходит». Так задача из «вспомни справочник» превращается
 * в «сравни десять строк», а это разница между догадкой и проверяемым ответом.
 *
 * Вход:  data/povarenok/ingredient-names.json (scripts/povarenok/ingredient_names.py)
 * Выход: data/povarenok/ingredients/round-N/in/chunk-NN.json
 *
 *   PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsx \
 *     scripts/povarenok/export-ingredient-chunks.ts [--round 1]
 *
 * Node 22 обязателен: на 20 клиент Supabase падает с ошибкой про WebSocket.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CHUNK_SIZE = 120;
const CANDIDATES = 8;
const CONCURRENCY = 8;

interface NameRow {
  name: string;
  mentions: number;
  units: string[];
}

interface Candidate {
  id: number;
  name_ru: string;
  name_en: string;
  category: string | null;
}

function loadEnv() {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/**
 * Кандидаты ищутся локально по выгруженному справочнику, а не через
 * `search_ingredients`, и на то две причины, обе выясненные на первом прогоне.
 *
 * 1. **Триграммный поиск в базе не переживает ё.** Запрос «Мед» не находит
 *    ничего, «мёд» находит позицию 2748. То же ждёт свёклу, гречку и всё
 *    остальное, что Povarenok пишет через «е», а наш справочник через «ё».
 *    Локально это чинится одной строкой нормализации, в базе — переиндексацией,
 *    которая этому тикету не по адресу.
 * 2. 1114 запросов в Огайо из России — это и медленно, и ненадёжно: без ретраев
 *    отвалились «Сметана», «Картофель», «Молоко» и «Морковь». Справочник
 *    сырья — 8265 строк, он выкачивается один раз за пару секунд.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

async function fetchCatalog(db: SupabaseClient): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from("ingredients")
      .select("id,name_ru,name_en,category")
      .eq("kind", "ingredient")
      .eq("is_active", true)
      .order("id")
      .range(from, from + page - 1);
    if (error) throw new Error(`выгрузка справочника не удалась: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as Candidate[]));
    if (data.length < page) break;
  }
  return out;
}

interface IndexedCandidate extends Candidate {
  grams: Set<string>;
  tokens: Set<string>;
}

function indexCatalog(rows: Candidate[]): IndexedCandidate[] {
  return rows.map((row) => {
    const n = normalize(row.name_ru);
    return {
      ...row,
      grams: trigrams(n),
      tokens: new Set(n.split(" ")),
    };
  });
}

function findCandidates(name: string, catalog: IndexedCandidate[]): Candidate[] {
  const n = normalize(name);
  const grams = trigrams(n);
  const tokens = n.split(" ").filter(Boolean);

  const scored = catalog.map((row) => {
    let score = similarity(grams, row.grams);
    // Целое слово запроса, встреченное в названии справочника, весит больше
    // побуквенного сходства: «мед» внутри «мёд» — это попадание, а «мед»
    // внутри «медальоны» — случайность, и разделяет их именно токен.
    const hits = tokens.filter((t) => row.tokens.has(t)).length;
    if (hits) score += 0.35 * (hits / tokens.length);
    return { row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.score >= 0.2)
    .slice(0, CANDIDATES)
    .map(({ row }) => ({
      id: row.id,
      name_ru: row.name_ru,
      name_en: row.name_en,
      category: row.category,
    }));
}


async function main() {
  loadEnv();
  const round = Number(
    process.argv.includes("--round")
      ? process.argv[process.argv.indexOf("--round") + 1]
      : 1,
  );

  const names = JSON.parse(
    readFileSync("data/povarenok/ingredient-names.json", "utf8"),
  ) as NameRow[];

  // Раунды аддитивны, и переспрашивается не только оставшееся без ответа, но и
  // то, на что ответили `null`: кандидатов для этих позиций в прошлый раз могло
  // не быть по вине поиска, а не потому, что позиции нет в справочнике.
  let pending = names;
  if (round > 1) {
    let settled = new Set<string>();
    try {
      const merged = JSON.parse(
        readFileSync("data/povarenok-ingredients.json", "utf8"),
      ) as Record<string, { ingredient_id: number | null }>;
      settled = new Set(
        Object.entries(merged)
          .filter(([, v]) => v.ingredient_id !== null)
          .map(([k]) => k),
      );
    } catch {
      // предыдущего раунда нет — разбираем всё
    }
    pending = names.filter((n) => !settled.has(n.name));
  }

  console.log(`названий к разбору: ${pending.length} (раунд ${round})`);

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const catalog = indexCatalog(await fetchCatalog(db));
  console.log(`справочник сырья: ${catalog.length} позиций`);

  const enriched = pending.map((row) => ({
    ...row,
    candidates: findCandidates(row.name, catalog),
  }));

  const withoutCandidates = enriched.filter((e) => e.candidates.length === 0);
  console.log(`без единого кандидата: ${withoutCandidates.length}`);

  const base = `data/povarenok/ingredients/round-${round}`;
  const manifest: { chunk: string; count: number; out: string }[] = [];

  for (let i = 0; i < enriched.length; i += CHUNK_SIZE) {
    const slice = enriched.slice(i, i + CHUNK_SIZE);
    const nn = String(Math.floor(i / CHUNK_SIZE) + 1).padStart(2, "0");
    const inPath = join(base, "in", `chunk-${nn}.json`);
    const outPath = join(base, "out", `chunk-${nn}.json`);
    mkdirSync(dirname(inPath), { recursive: true });
    mkdirSync(join(base, "out"), { recursive: true });
    writeFileSync(
      inPath,
      JSON.stringify(
        { chunk: `chunk-${nn}`, out: outPath, count: slice.length, items: slice },
        null,
        1,
      ),
      "utf8",
    );
    manifest.push({ chunk: `chunk-${nn}`, count: slice.length, out: outPath });
  }

  writeFileSync(
    join(base, "manifest.json"),
    JSON.stringify(manifest, null, 1),
    "utf8",
  );
  console.log(`нарезано чанков: ${manifest.length} → ${base}/in/`);
}

main();
