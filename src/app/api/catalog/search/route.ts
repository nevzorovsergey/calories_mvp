import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/**
 * Поиск по справочнику (FR-EDIT-3, FR-EDIT-4) — через наш сервер.
 *
 * Раньше браузер звал RPC `search_ingredients` напрямую, и поиск жил на том же
 * канале до us-east-2, на котором виснет логин: набранное слово могло не
 * получить ответа вовсе. Здесь тот же вызов делает функция Vercel, у которой до
 * Supabase короткий и стабильный хоп.
 *
 * Проверки сессии тут намеренно нет. Границей доступа остаётся RLS: серверный
 * клиент ходит от имени пользователя, и без сессии выборка просто пуста. Лишний
 * `getUser()` — это ещё один поход в Supabase на каждое нажатие клавиши, а
 * поиск и так дёргается по мере набора текста.
 */
export const dynamic = "force-dynamic";

const Query = z.object({
  q: z.string().trim().min(2).max(200),
  kinds: z.array(z.enum(["ingredient", "dish"])).min(1),
  limit: z.number().int().min(1).max(50),
});

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = Query.safeParse({
    q: params.get("q") ?? "",
    kinds: (params.get("kinds") ?? "").split(",").filter(Boolean),
    limit: Number(params.get("limit") ?? 20),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Некорректный запрос поиска" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_ingredients", {
    q: parsed.data.q,
    max_results: parsed.data.limit,
    kinds: parsed.data.kinds,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ options: data ?? [] });
}
