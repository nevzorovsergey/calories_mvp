import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/lab/guard";

/**
 * Точечная правка позиции справочника (FR-LABX-4).
 *
 * Правятся только те поля, которые описывают позицию, а не её содержимое:
 * название, категория и два флага. Нутриенты, порции и раскладка приезжают
 * импортом из USDA и Поварёнка — правка их вручную развела бы справочник с
 * источником, и следующий `npm run usda:import` молча вернул бы всё назад.
 *
 * Истории эксперимента правка не касается: `meal_items` хранит снимок
 * нутриентов на момент сохранения (см. комментарий в 0001), а название позиции
 * там своё. Переименование позиции не переписывает прошлое.
 */
export const dynamic = "force-dynamic";

const Payload = z
  .object({
    name_ru: z.string().trim().min(1).max(300),
    category: z.string().trim().max(200).nullable(),
    is_active: z.boolean(),
    is_service: z.boolean(),
  })
  .partial();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ingredientId = Number(id);
  if (!Number.isInteger(ingredientId)) {
    return NextResponse.json({ error: "Некорректный id позиции" }, { status: 400 });
  }

  const supabase = await createClient();
  const denied = await requireAdmin(supabase);
  if (denied) return denied;

  const parsed = Payload.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Некорректные поля: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}` },
      { status: 400 },
    );
  }

  const patch = parsed.data;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Нечего менять" }, { status: 400 });
  }
  // Пустая строка в категории — это «категории нет», а не категория с пустым
  // именем: иначе она попала бы в фильтры отдельным пунктом без названия.
  if (patch.category === "") patch.category = null;

  const { data, error } = await supabase
    .from("ingredients")
    .update(patch)
    .eq("id", ingredientId)
    .select("id, name_ru, category, is_active, is_service")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json({ error: "Позиция не найдена" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, item: data });
}
