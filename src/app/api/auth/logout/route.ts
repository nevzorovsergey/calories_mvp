import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Выход — парный маршрут к `/api/auth/login`.
 *
 * Вынесен на сервер по той же причине, что и вход, но с важным отличием в
 * последствиях отказа: незавершившийся выход оставляет сессию живой, а человек
 * при этом уверен, что вышел. Поэтому cookie здесь чистятся в любом случае —
 * даже если Supabase не ответил и отозвать refresh-токен на его стороне не
 * удалось. Локальный выход всегда честнее, чем зависшая кнопка «Выйти».
 */
export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();

  // `scope: 'local'` — гасим только эту сессию. Глобальный выход разлогинил бы
  // человека и на других его устройствах, чего кнопка «Выйти» не обещает.
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    return NextResponse.json({ ok: true, warning: error.message });
  }

  return NextResponse.json({ ok: true });
}
