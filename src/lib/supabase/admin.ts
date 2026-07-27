import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Клиент с сервисным ключом — обходит RLS.
 *
 * Только для того, у чего нет пользовательской сессии: cron-задачи и скрипты
 * импорта справочника. В обычных запросах приложения используйте
 * `@/lib/supabase/server`, иначе RLS перестанет быть границей доступа.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Новое имя ключа в дашборде — secret key (sb_secret_…); legacy — service_role.
  const serviceKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (или SUPABASE_SECRET_KEY) — см. .env.local.example",
    );
  }
  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
