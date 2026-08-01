import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Проверка админства для маршрутов лаборатории.
 *
 * RLS всё равно не дал бы записать чужое, но без явной проверки не-админ
 * получил бы «изменено 0 строк» и решил, что позиции не существует. Ответ
 * должен называть настоящую причину — как в выгрузке датасета (api/lab/export).
 *
 * Возвращает готовый ответ, если доступ закрыт, и null, если можно продолжать.
 */
export async function requireAdmin(
  supabase: SupabaseClient,
): Promise<NextResponse | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Только для админа" }, { status: 403 });
  }

  return null;
}
