/**
 * Тикеты 05 и 06: заливка справочника блюд Povarenok.
 *
 *   PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsx \
 *     scripts/povarenok/import-dishes.ts [--limit N] [--restart]
 *
 * Вход: data/povarenok/import/dishes.ndjson (scripts/povarenok/build_import.py)
 *
 * Объём — около 4.7 млн строк: 122 607 блюд, ~550 тысяч строк состава,
 * ~3.7 млн строк нутриентов и 368 тысяч порций. База в Огайо, ходим из России,
 * и заливка такого размера рвётся не «если», а «когда». Поэтому:
 *
 *  - прогресс пишется в state-файл после каждой пачки, перезапуск продолжает с
 *    места обрыва, а не с начала;
 *  - все вставки идемпотентны (upsert по существующим уникальным ключам), так
 *    что повтор пачки ничего не портит;
 *  - размер пачки подобран под лимит PostgREST в 1000 строк ответа.
 *
 * Прервать можно в любой момент: Ctrl-C, потом тот же запуск без --restart.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const SOURCE = "povarenok";
const INPUT = "data/povarenok/import/dishes.ndjson";
const STATE = "data/povarenok/import/state.json";

const DISH_BATCH = 400;
const CHILD_BATCH = 900;

interface Component {
  seq: number;
  ingredient_id: number | null;
  name: string;
  share: number;
}

interface Dish {
  source_id: string;
  name_ru: string;
  category: string | null;
  is_service: boolean;
  popularity_views: number;
  source_recipes: number;
  nutrition_coverage: number;
  nutrition: Record<string, number>;
  components: Component[];
  portions: { small: number; medium: number; large: number; level: number };
}

interface State {
  processedLines: number;
  dishes: number;
  components: number;
  nutrients: number;
  portions: number;
}

function loadEnv() {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function readState(): State {
  if (process.argv.includes("--restart") || !existsSync(STATE)) {
    return { processedLines: 0, dishes: 0, components: 0, nutrients: 0, portions: 0 };
  }
  return JSON.parse(readFileSync(STATE, "utf8")) as State;
}

function writeState(state: State) {
  writeFileSync(STATE, JSON.stringify(state, null, 1), "utf8");
}

/**
 * Сеть между нами и базой рвётся регулярно, и молчаливая потеря пачки хуже
 * падения: справочник окажется частично залит, а скрипт отчитается об успехе.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError = "";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 15000)));
    }
  }
  throw new Error(`${label}: не удалось за 6 попыток — ${lastError}`);
}

async function upsert(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  returning?: string,
) {
  if (!rows.length) return [];
  return withRetry(`${table} (${rows.length} строк)`, async () => {
    const query = db.from(table).upsert(rows, { onConflict });
    const res = returning ? await query.select(returning) : await query;
    if (res.error) throw new Error(res.error.message);
    return (res.data ?? []) as unknown as Record<string, unknown>[];
  });
}

async function chunked(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
) {
  for (let i = 0; i < rows.length; i += CHILD_BATCH) {
    await upsert(db, table, rows.slice(i, i + CHILD_BATCH), onConflict);
  }
}

async function loadNutrientIds(db: SupabaseClient) {
  const { data, error } = await db.from("nutrients").select("id,code");
  if (error) throw new Error(error.message);
  return new Map<string, number>(
    (data ?? []).map((n) => [n.code as string, n.id as number]),
  );
}

async function flush(
  db: SupabaseClient,
  batch: Dish[],
  nutrientIds: Map<string, number>,
  state: State,
) {
  // 1. Блюда. Возврат id обязателен: на них ссылается всё остальное, а
  //    source_id → id иначе неоткуда взять.
  const rows = batch.map((d) => ({
    source: SOURCE,
    source_id: d.source_id,
    kind: "dish",
    name_ru: d.name_ru,
    // name_en в схеме not null, а у русского рецепта его нет и не будет.
    name_en: "",
    category: d.category,
    state: "cooked",
    popularity_views: d.popularity_views,
    source_recipes: d.source_recipes,
    is_service: d.is_service,
    is_active: true,
  }));

  const inserted = (await upsert(
    db,
    "ingredients",
    rows,
    "source,source_id",
    "id,source_id",
  )) as { id: number; source_id: string }[];
  const idBySource = new Map(inserted.map((r) => [r.source_id, r.id]));

  const components: Record<string, unknown>[] = [];
  const nutrients: Record<string, unknown>[] = [];
  const portions: Record<string, unknown>[] = [];

  for (const dish of batch) {
    const dishId = idBySource.get(dish.source_id);
    if (!dishId) continue;

    // Вес компонента — доля от медианной порции. Сама доля (`share`) остаётся
    // единственным, на что можно опираться при масштабировании: у FNDDS тут та
    // же семантика, см. комментарий в миграции 0006.
    const base = dish.portions.medium;
    for (const c of dish.components) {
      components.push({
        dish_id: dishId,
        seq: c.seq,
        ingredient_id: c.ingredient_id,
        name_en_fallback: c.ingredient_id ? null : c.name,
        gram_weight: Number((c.share * base).toFixed(3)),
        share: c.share,
      });
    }

    for (const [code, amount] of Object.entries(dish.nutrition)) {
      const nutrientId = nutrientIds.get(code);
      if (nutrientId === undefined) continue;
      nutrients.push({
        ingredient_id: dishId,
        nutrient_id: nutrientId,
        amount_per_100g: amount,
      });
    }

    const { small, medium, large } = dish.portions;
    portions.push(
      { ingredient_id: dishId, seq: 1, label_en: "small portion", label_ru: "маленькая порция", gram_weight: small, is_default: false },
      { ingredient_id: dishId, seq: 2, label_en: "regular portion", label_ru: "обычная порция", gram_weight: medium, is_default: true },
      { ingredient_id: dishId, seq: 3, label_en: "large portion", label_ru: "большая порция", gram_weight: large, is_default: false },
    );
  }

  await chunked(db, "ingredient_components", components, "dish_id,seq");
  await chunked(db, "ingredient_nutrients", nutrients, "ingredient_id,nutrient_id");
  await chunked(db, "ingredient_portions", portions, "ingredient_id,seq");

  state.dishes += batch.length;
  state.components += components.length;
  state.nutrients += nutrients.length;
  state.portions += portions.length;
}

async function main() {
  loadEnv();
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const nutrientIds = await loadNutrientIds(db);
  const state = readState();
  console.log(
    state.processedLines
      ? `продолжаем со строки ${state.processedLines}`
      : "начинаем с начала",
  );

  const reader = createInterface({
    input: createReadStream(INPUT, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let line = 0;
  let batch: Dish[] = [];
  const started = Date.now();

  for await (const raw of reader) {
    line += 1;
    if (line <= state.processedLines) continue;
    if (state.dishes >= limit) break;
    if (!raw.trim()) continue;

    batch.push(JSON.parse(raw) as Dish);
    if (batch.length < DISH_BATCH) continue;

    await flush(db, batch, nutrientIds, state);
    state.processedLines = line;
    writeState(state);
    batch = [];

    const rate = state.dishes / ((Date.now() - started) / 1000);
    console.log(
      `  блюд ${state.dishes}, состав ${state.components}, ` +
        `нутриенты ${state.nutrients}, порции ${state.portions} ` +
        `(${rate.toFixed(1)} блюд/с)`,
    );
  }

  if (batch.length && state.dishes < limit) {
    await flush(db, batch, nutrientIds, state);
    state.processedLines = line;
    writeState(state);
  }

  console.log(
    `\nготово: блюд ${state.dishes}, состав ${state.components}, ` +
      `нутриенты ${state.nutrients}, порции ${state.portions}`,
  );
}

main();
