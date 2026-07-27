/**
 * Применение миграций через Management API Supabase.
 *
 *   npx tsx scripts/apply-migrations.ts [--only 0001] [--check]
 *
 * Альтернатива ручной вставке в SQL Editor: те же файлы, тот же порядок, но
 * повторяемо и с проверкой результата. Нужен personal access token в
 * SUPABASE_ACCESS_TOKEN (создаётся на supabase.com/dashboard/account/tokens).
 *
 * ВНИМАНИЕ: personal access token — аккаунтный, а не проектный: он даёт права
 * на все проекты владельца, включая их удаление. Держите его только в
 * .env.local и отзывайте, когда он больше не нужен.
 *
 * Ссылка на проект берётся из NEXT_PUBLIC_SUPABASE_URL, отдельно указывать не надо.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const API = "https://api.supabase.com";

function projectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL не задан");
  return new URL(url).hostname.split(".")[0];
}

function token(): string {
  const value = process.env.SUPABASE_ACCESS_TOKEN;
  if (!value) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN не задан.\n" +
        "Создайте токен на https://supabase.com/dashboard/account/tokens\n" +
        "и положите его в .env.local строкой SUPABASE_ACCESS_TOKEN=sbp_…",
    );
  }
  return value;
}

async function runSql(query: string): Promise<unknown> {
  const response = await fetch(
    `${API}/v1/projects/${projectRef()}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );

  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* оставляем как текст */
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String((payload as { message: unknown }).message)
        : String(text).slice(0, 500);
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.indexOf("--only");
  const only = onlyArg >= 0 ? args[onlyArg + 1] : null;

  console.log(`Проект: ${projectRef()}`);

  if (args.includes("--check")) {
    const rows = (await runSql(`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name;
    `)) as { table_name: string }[];
    console.log(
      rows.length > 0
        ? `Таблицы и вьюхи в public (${rows.length}): ${rows.map((r) => r.table_name).join(", ")}`
        : "В схеме public пусто — миграции ещё не применялись.",
    );
    return;
  }

  // all_in_one.sql — это склейка 0001–0004 для ручной вставки; при
  // автоматическом применении берём исходные файлы, иначе всё выполнится дважды.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => (only ? f.startsWith(only) : true));

  if (files.length === 0) throw new Error("Не нашёл файлов миграций");

  for (const file of files) {
    process.stdout.write(`${file} … `);
    try {
      await runSql(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      console.log("применена");
    } catch (error) {
      console.log("ОШИБКА");
      console.error(`  ${error instanceof Error ? error.message : error}`);
      console.error(
        "\nМиграции не идемпотентны: если часть объектов уже создана, сначала\n" +
          "очистите схему или примените оставшиеся файлы флагом --only.",
      );
      process.exit(1);
    }
  }

  const rows = (await runSql(`
    select
      (select count(*) from information_schema.tables where table_schema='public') as tables,
      (select count(*) from nutrients) as nutrients,
      (select count(*) from storage.buckets where id='meals') as bucket;
  `)) as { tables: number; nutrients: number; bucket: number }[];
  const stats = rows[0];
  console.log(
    `\nГотово. Объектов в public: ${stats.tables}, нутриентов: ${stats.nutrients}, бакет meals: ${stats.bucket === 1 ? "создан" : "НЕТ"}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
