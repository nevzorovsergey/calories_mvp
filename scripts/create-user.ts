/**
 * Завести пользователя (FR-AUTH-2: регистрации нет, аккаунты создаёт владелец).
 *
 *   npx tsx scripts/create-user.ts ivan@example.com --name "Иван" --admin
 *   npx tsx scripts/create-user.ts ivan@example.com --password "своя-строка"
 *
 * Без --password генерирует случайный и печатает его один раз. Профиль
 * создаётся триггером на auth.users; здесь только проставляются display_name и
 * is_admin.
 */

import { randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { createAdminClient } from "../src/lib/supabase/admin";

loadEnv({ path: ".env.local" });

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main() {
  const email = process.argv.slice(2).find((a) => a.includes("@"));
  if (!email) {
    console.error(
      'Использование: npx tsx scripts/create-user.ts email@example.com [--name "Имя"] [--admin] [--password "..."]',
    );
    process.exit(1);
  }

  const isAdmin = process.argv.includes("--admin");
  const displayName = flag("name") ?? email.split("@")[0];
  // 12 байт base64url — достаточно случайно, но ещё можно продиктовать голосом.
  const password = flag("password") ?? randomBytes(12).toString("base64url");

  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });

  if (error) {
    console.error(`Не удалось создать пользователя: ${error.message}`);
    process.exit(1);
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({ display_name: displayName, is_admin: isAdmin })
    .eq("id", data.user!.id);
  if (profileError) {
    console.error(`Пользователь создан, но профиль не обновился: ${profileError.message}`);
  }

  console.log(
    `Готово.\n  email:  ${email}\n  пароль: ${password}\n  имя:    ${displayName}` +
      `\n  роль:   ${isAdmin ? "владелец (видит «Лабораторию»)" : "тестировщик"}` +
      `\n\nПароль показан один раз — сохраните его. Сменить можно в дашборде\nSupabase: Authentication → Users → … → Reset password.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
