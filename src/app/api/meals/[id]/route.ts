import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isoDateDiffDays } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Статус приёма пищи — используется для опроса, пока status = 'processing'. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("meals")
    .select("id, status, dish_name_ru, primary_recognition_id")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Приём пищи не найден" }, { status: 404 });
  }
  return NextResponse.json(data);
}

/**
 * FR-DET-7: перенести приём пищи на другую дату.
 *
 * `meal_date` — единственное, что решает, в чей дневной итог попадёт еда
 * (§10.1), поэтому ошибка в дате портит статистику сразу двух дней, а состав
 * при этом верный. Перенос правит только дату, ничего не пересчитывая.
 *
 * Вместе с датой едет `eaten_at`: лента дня сортируется по нему, и приём пищи
 * с меткой времени из другого дня встал бы в начало или конец списка мимо
 * своего времени. Сдвигаем на целое число суток — время дня сохраняется.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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

  const mealDate = payload.meal_date ?? "";
  // Формата мало: «2026-02-31» ему соответствует, а такого дня нет — Date.parse
  // на ISO-дате проверяет и это.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate) || Number.isNaN(Date.parse(mealDate))) {
    return NextResponse.json({ error: "Некорректная дата" }, { status: 400 });
  }

  const { data: meal } = await supabase
    .from("meals")
    .select("meal_date, eaten_at")
    .eq("id", id)
    .single();
  if (!meal) {
    return NextResponse.json({ error: "Приём пищи не найден" }, { status: 404 });
  }

  const shiftDays = isoDateDiffDays(meal.meal_date as string, mealDate);
  const eatenAt = new Date(
    new Date(meal.eaten_at as string).getTime() + shiftDays * 86_400_000,
  ).toISOString();

  // `select` здесь не за данными, а за проверкой: RLS на update пускает только
  // владельца (админ, в отличие от чтения, чужое не правит), и без строки в
  // ответе отказ выглядел бы как успешный перенос.
  const { data: updated, error } = await supabase
    .from("meals")
    .update({ meal_date: mealDate, eaten_at: eatenAt })
    .eq("id", id)
    .select("id, meal_date")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "Это не ваш приём пищи" }, { status: 403 });
  }

  return NextResponse.json({ ok: true, meal_date: mealDate });
}

/** FR-DET-5: удалить приём пищи вместе с фотографиями. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const { data: meal } = await supabase
    .from("meals")
    .select("photo_sent_path, photo_original_path")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("meals").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Строки БД уходят каскадом, файлы — руками.
  const paths = [meal?.photo_sent_path, meal?.photo_original_path].filter(
    (p): p is string => !!p,
  );
  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from("meals")
      .remove(paths);
    if (storageError) console.error("storage remove failed", storageError);
  }

  return NextResponse.json({ ok: true });
}
