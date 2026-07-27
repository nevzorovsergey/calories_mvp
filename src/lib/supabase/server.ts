import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL, assertSupabaseEnv } from "./env";

/**
 * Клиент Supabase для серверных компонентов и route handlers.
 *
 * Ходим от имени пользователя (публичный ключ + cookie-сессия), а не сервисным
 * ключом — RLS из миграции 0002 остаётся настоящей границей доступа.
 */
export async function createClient() {
  assertSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Вызов из серверного компонента: куки там менять нельзя.
          // Обновление сессии делает proxy, так что это безопасно.
        }
      },
    },
  });
}
