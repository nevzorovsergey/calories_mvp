/**
 * Добивка `ingredients.portion_source_level` (миграция 0010).
 *
 *   PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsx \
 *     scripts/povarenok/backfill-portion-level.ts
 *
 * Уровень считается в build_import.py и лежит в dishes.ndjson, но в первый
 * заход импорта в базу не поехал. Отдельный скрипт, а не повторный полный
 * импорт: заливать заново 4.9 млн строк ради одной колонки незачем.
 */
import { createClient } from "@supabase/supabase-js";
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const BATCH = 500;

async function main() {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const reader = createInterface({
    input: createReadStream("data/povarenok/import/dishes.ndjson", { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  // UPDATE, а не upsert: строки уже существуют, а upsert в PostgREST — это
  // INSERT ... ON CONFLICT, и он требует все NOT NULL колонки, которых у нас
  // здесь нет. Уровней всего три, поэтому группируем по значению и обновляем
  // пачками ключей — 245 запросов вместо 122 607.
  const byLevel = new Map<number, string[]>();
  for await (const line of reader) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      source_id: string;
      portions: { level: number };
    };
    const bucket = byLevel.get(row.portions.level) ?? [];
    bucket.push(row.source_id);
    byLevel.set(row.portions.level, bucket);
  }

  // Ключ канонизации — длинная русская строка, и 500 таких в URL Cloudflare
  // отбивает как слишком длинный запрос. Поэтому сначала выкачиваем
  // соответствие source_id → числовой id: числа в фильтре короткие, и пачка
  // из 500 укладывается в лимит.
  const idBySource = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("ingredients")
      .select("id, source_id")
      .eq("source", "povarenok")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const row of data) {
      idBySource.set(row.source_id as string, row.id as number);
    }
    if (data.length < 1000) break;
  }
  console.log(`соответствий source_id → id: ${idBySource.size}`);

  let done = 0;
  for (const [level, sourceIds] of byLevel) {
    const ids = sourceIds
      .map((s) => idBySource.get(s))
      .filter((v): v is number => v !== undefined);
    console.log(`уровень ${level}: ${ids.length} блюд`);
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const { error } = await db
          .from("ingredients")
          .update({ portion_source_level: level })
          .in("id", slice);
        if (!error) break;
        if (attempt === 6) throw new Error(error.message);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
      done += slice.length;
      if (done % 20000 === 0) console.log(`  ${done}`);
    }
  }
  console.log(`уровень проставлен у ${done} блюд`);
}

main();
