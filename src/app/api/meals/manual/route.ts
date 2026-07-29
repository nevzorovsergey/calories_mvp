import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Приём пищи без фотографии — добавление по справочнику (§8.1, FR-CAT).
 *
 * Отдельный маршрут, а не ветка в POST /api/meals: там multipart с двумя
 * кадрами, Storage и фоновое распознавание, и ни одно из этого здесь не нужно.
 * Общего у них ровно одна строка вставки, и склеивать их значило бы получить
 * обработчик, половина которого не выполняется.
 *
 * `status = 'manual'` — не косметика. Это метка, по которой такие приёмы пищи
 * исключаются из выборок гипотез H1–H6: они не проходили через модель, и
 * «доля ингредиентов, оставленных без изменений» на них не определена.
 * Состав пишется дальше обычным PUT /api/meals/[id]/items, который умеет
 * работать без распознавания.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  let payload: { meal_date?: string };
  try {
    payload = (await request.json()) as { meal_date?: string };
  } catch {
    payload = {};
  }

  // Локальная дата пользователя приходит с клиента: считать её на сервере по UTC
  // значило бы записать поздний ужин во «вчера» (§10.1, meal_date).
  const mealDate = payload.meal_date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) {
    return NextResponse.json({ error: "Некорректная дата" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("meals")
    .insert({
      user_id: user.id,
      meal_date: mealDate,
      status: "manual",
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: `Не удалось создать приём пищи: ${error?.message ?? "нет ответа"}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ meal_id: data.id, status: "manual" });
}
