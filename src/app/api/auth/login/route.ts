import { NextResponse } from "next/server";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Вход через наш сервер, а не напрямую из браузера в Supabase.
 *
 * Канал браузер → Supabase (us-east-2, Огайо) деградировал: часть соединений
 * встаёт наглухо после TLS-хендшейка, и запрос висит без ответа и без ошибки.
 * Канал браузер → Vercel и канал Vercel → Supabase при этом живые — на них
 * держится всё остальное приложение, потому что страницы `(app)/*` ходят в
 * Supabase серверным клиентом. Логин оставался единственным шагом, который
 * упирался в сломанный канал, и этот маршрут убирает исключение: снаружи
 * меняется только адрес, сессия по-прежнему живёт в тех же cookie, которые
 * ставит `@supabase/ssr`, и proxy читает её без изменений.
 *
 * Плата за это — пароль теперь проходит через нашу функцию. Он не пишется ни в
 * логи, ни в ответ, но в память функции попадает, и это надо помнить при любой
 * будущей отладке этого маршрута.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let payload: { email?: unknown; password?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    payload = {};
  }

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "Нужны email и пароль" }, { status: 400 });
  }

  const supabase = await createClient();
  // Сессию в cookie кладёт сам клиент через setAll: здесь это route handler,
  // и запись в cookie-хранилище уезжает в Set-Cookie ответа.
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (!error) {
    return NextResponse.json({ ok: true });
  }

  // Молчание сети отделяем от отказа в доступе: в первом случае форме надо
  // предложить повтор, во втором — сказать про пароль. Свести их в один ответ
  // значило бы обвинять человека в неверном пароле при обрыве связи.
  if (isAuthRetryableFetchError(error)) {
    return NextResponse.json(
      { error: "Supabase не ответил", retryable: true },
      { status: 502 },
    );
  }

  return NextResponse.json({ error: error.message }, { status: 401 });
}
