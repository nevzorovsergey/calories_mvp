/**
 * Тикет 03, шаг 1: выгрузка КБЖУ сматченных позиций справочника.
 *
 * Валидация (scripts/povarenok/validate.py) читает parquet, а parquet умеет
 * питон; в базу ходит TypeScript. Мост между ними — этот файл.
 *
 *   PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsx \
 *     scripts/povarenok/export-nutrients.ts
 *
 * Вход:  data/povarenok-ingredients.json
 * Выход: data/povarenok/nutrients-cache.json (не коммитится, воспроизводится)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Валидации (тикет 03) хватало четырёх макросов, импорту (тикет 05) нужны все
 * 30: у блюда должна быть та же нутриентная панель, что у сырья, иначе экран
 * блюда окажется беднее экрана ингредиента.
 *
 *   --macros-only — вернуться к четырём, для быстрой перепроверки 03.
 */
const MACROS = ["energy_kcal", "protein", "fat", "carbs"];

function loadEnv() {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnv();
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const map = JSON.parse(
    readFileSync("data/povarenok-ingredients.json", "utf8"),
  ) as Record<string, { ingredient_id: number | null }>;
  const ids = [
    ...new Set(
      Object.values(map)
        .map((v) => v.ingredient_id)
        .filter((v): v is number => v !== null),
    ),
  ];
  console.log(`сматченных позиций: ${ids.length}`);

  const macrosOnly = process.argv.includes("--macros-only");
  let query = db.from("nutrients").select("id,code");
  if (macrosOnly) query = query.in("code", MACROS);
  const { data: nutrients, error: nutrientError } = await query;
  if (nutrientError) throw new Error(nutrientError.message);
  const codeById = new Map<number, string>(
    (nutrients ?? []).map((n) => [n.id as number, n.code as string]),
  );
  console.log(
    `нутриентов к выгрузке: ${codeById.size}`,
  );

  const out: Record<string, Record<string, number>> = {};
  // Размер батча ограничен с двух сторон, и обе границы найдены на практике.
  //
  // Сверху: PostgREST отдаёт максимум 1000 строк и НЕ сообщает об усечении.
  // На 50 ингредиентах × 30 нутриентов = 1500 строк ответ молча обрезался, и
  // выгрузка вернула 559 позиций вместо 683 — меньше, чем когда нутриентов
  // запрашивалось четыре. Ниже стоит явная проверка на упор в лимит.
  //
  // Снизу: батч 200 обрывался с «TypeError: terminated» — база в Огайо, ходим
  // из России, длинный ответ не доезжает.
  const batch = Math.max(1, Math.floor(900 / Math.max(codeById.size, 1)));
  console.log(`батч: ${batch} позиций (${batch * codeById.size} строк)`);
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch);
    let data: { ingredient_id: number; nutrient_id: number; amount_per_100g: number }[] = [];
    let lastError = "";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const res = await db
          .from("ingredient_nutrients")
          .select("ingredient_id,nutrient_id,amount_per_100g")
          .in("ingredient_id", slice)
          .in("nutrient_id", [...codeById.keys()]);
        if (res.error) throw new Error(res.error.message);
        data = (res.data ?? []) as typeof data;
        lastError = "";
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (lastError) throw new Error(`батч с ${i}: ${lastError}`);
    if (data.length >= 1000) {
      throw new Error(
        `батч с ${i} упёрся в лимит PostgREST (${data.length} строк) — ` +
          "часть нутриентов потерялась бы молча, уменьшите batch",
      );
    }
    if (i % 200 === 0) console.log(`  ${i}/${ids.length}`);
    for (const row of data) {
      const code = codeById.get(row.nutrient_id);
      if (!code) continue;
      const key = String(row.ingredient_id);
      (out[key] ??= {})[code] = Number(row.amount_per_100g);
    }
  }

  writeFileSync(
    "data/povarenok/nutrients-cache.json",
    JSON.stringify(out, null, 1),
    "utf8",
  );
  const complete = Object.values(out).filter(
    (v) => MACROS.every((c) => v[c] !== undefined),
  ).length;
  console.log(
    `выгружено позиций с нутриентами: ${Object.keys(out).length}, ` +
      `полных по всем четырём: ${complete}`,
  );
}

main();
