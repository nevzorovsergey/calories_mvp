/**
 * Переменные окружения Supabase.
 *
 * Supabase перевёл ключи на новую систему: панель Connect выдаёт
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`), а прежний
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` (JWT) объявлен legacy и будет выключен к
 * концу 2026 года. Понимаем оба имени, чтобы копипаста из дашборда работала
 * как есть и не ломалась при переходе на новые ключи.
 *
 * Обращения к process.env написаны литералами намеренно: Next подставляет
 * значения NEXT_PUBLIC_* на этапе сборки только при статическом обращении, и
 * вычисляемое имя переменной в браузере дало бы undefined.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

export const SUPABASE_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

export function assertSupabaseEnv(): void {
  if (!SUPABASE_URL) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL не задан. Скопируйте .env.local.example в .env.local и заполните значения из дашборда Supabase (кнопка Connect → App Frameworks → Next.js).",
    );
  }
  if (!SUPABASE_PUBLIC_KEY) {
    throw new Error(
      "Не задан публичный ключ Supabase: положите его в NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (новый ключ sb_publishable_…) или в NEXT_PUBLIC_SUPABASE_ANON_KEY (legacy).",
    );
  }
}
