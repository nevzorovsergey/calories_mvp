import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL } from "./env";

/** Клиент Supabase для браузера (логин, поиск по справочнику, привязка алиасов). */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY);
}
