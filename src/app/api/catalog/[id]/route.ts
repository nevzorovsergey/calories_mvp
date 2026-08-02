import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadCatalogEntry } from "@/lib/catalog/entry";

/**
 * Позиция справочника целиком: название, КБЖУ на 100 г, порции, состав.
 *
 * Один маршрут на двух потребителей. Экрану добавления по справочнику нужна вся
 * позиция, экрану правки — только `per100g` при привязке ингредиента. Заводить
 * под второго отдельный `/nutrients` значило бы держать два маршрута об одной
 * сущности ради экономии трёх запросов на действие, которое человек делает
 * руками и редко; `loadCatalogEntry` уже собирает всё это параллельно.
 *
 * Функция принимает любой клиент Supabase, поэтому здесь она работает ровно
 * так же, как раньше работала в браузере, — сменился только тот, кто её зовёт.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ingredientId = Number(id);
  if (!Number.isInteger(ingredientId)) {
    return NextResponse.json({ error: "Некорректный id позиции" }, { status: 400 });
  }

  const supabase = await createClient();
  const entry = await loadCatalogEntry(supabase, ingredientId);

  if (!entry) {
    return NextResponse.json({ error: "Позиция не найдена" }, { status: 404 });
  }

  return NextResponse.json({ entry });
}
