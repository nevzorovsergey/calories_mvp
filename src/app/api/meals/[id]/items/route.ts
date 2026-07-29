import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadCatalogNutrition } from "@/lib/nutrition/calc";

/**
 * Сохранение пользовательской версии состава (FR-EDIT-10).
 *
 * Пишет ТОЛЬКО `meal_items` и `meal_removed_items`. `recognitions` и
 * `recognition_items` не трогает ни при каких обстоятельствах: предложение
 * модели и правка человека — две независимые версии, которые сохраняются
 * навсегда и никогда не перезаписывают друг друга (§1.3).
 *
 * `origin` вычисляется на сервере сравнением с `recognition_items`, а не
 * приходит с клиента: это ключевое поле для аналитики (H1, H2), и доверять
 * его вычисление интерфейсу нельзя.
 */
export const dynamic = "force-dynamic";

interface IncomingItem {
  /** id строки recognition_items, если позиция пришла от модели. */
  source_item_id?: string | null;
  ingredient_id?: number | null;
  name_ru: string;
  weight_g: number;
}

interface Payload {
  dish_name_ru?: string | null;
  items: IncomingItem[];
  /** id строк recognition_items, которые пользователь удалил. */
  removed_source_item_ids?: string[];
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: mealId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const payload = (await request.json()) as Payload;
  if (!Array.isArray(payload.items)) {
    return NextResponse.json({ error: "Ожидается поле items" }, { status: 400 });
  }

  const { data: meal, error: mealError } = await supabase
    .from("meals")
    .select("id, status, primary_recognition_id")
    .eq("id", mealId)
    .single();
  if (mealError || !meal) {
    return NextResponse.json({ error: "Приём пищи не найден" }, { status: 404 });
  }

  // Что предлагала модель — источник истины для origin и original_weight_g.
  // Если распознавания не было (ручной ввод после неудачи), запрос не шлём:
  // пустая строка вместо uuid — это ошибка Postgres, а не пустой результат.
  const { data: modelItems } = meal.primary_recognition_id
    ? await supabase
        .from("recognition_items")
        .select(
          "id, name_ru, weight_g, ingredient_id, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g",
        )
        .eq("recognition_id", meal.primary_recognition_id)
    : { data: [] };

  const modelById = new Map(
    (modelItems ?? []).map((item) => [item.id as string, item]),
  );

  const catalog = await loadCatalogNutrition(
    supabase,
    payload.items
      .map((item) => item.ingredient_id ?? null)
      .filter((id): id is number => id !== null),
  );

  const rows = payload.items.map((item, position) => {
    const source = item.source_item_id ? modelById.get(item.source_item_id) : null;
    const catalogMap =
      item.ingredient_id !== null && item.ingredient_id !== undefined
        ? catalog.byIngredient.get(item.ingredient_id)
        : undefined;
    const hasCatalog = !!catalogMap && Object.keys(catalogMap).length > 0;

    let origin: "model_kept" | "model_edited" | "user_added";
    if (!source) {
      origin = "user_added";
    } else {
      const weightChanged =
        Math.abs(Number(source.weight_g) - Number(item.weight_g)) > 0.001;
      const ingredientChanged =
        (source.ingredient_id ?? null) !== (item.ingredient_id ?? null);
      origin = weightChanged || ingredientChanged ? "model_edited" : "model_kept";
    }

    return {
      meal_id: mealId,
      position,
      ingredient_id: item.ingredient_id ?? null,
      name_ru: item.name_ru,
      weight_g: item.weight_g,
      nutrition_source: hasCatalog ? "catalog" : "model",
      origin,
      source_item_id: item.source_item_id ?? null,
      original_weight_g:
        origin === "model_edited" && source ? Number(source.weight_g) : null,
      kcal_per_100g: hasCatalog
        ? (catalogMap!.energy_kcal ?? null)
        : (source?.kcal_per_100g ?? null),
      protein_per_100g: hasCatalog
        ? (catalogMap!.protein ?? null)
        : (source?.protein_per_100g ?? null),
      fat_per_100g: hasCatalog
        ? (catalogMap!.fat ?? null)
        : (source?.fat_per_100g ?? null),
      carbs_per_100g: hasCatalog
        ? (catalogMap!.carbs ?? null)
        : (source?.carbs_per_100g ?? null),
    };
  });

  // Пользовательская версия целиком переписывается: позиции нумеруются заново,
  // порядок в интерфейсе совпадает с порядком в БД.
  const { error: deleteError } = await supabase
    .from("meal_items")
    .delete()
    .eq("meal_id", mealId);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  if (rows.length > 0) {
    const { error: insertError } = await supabase.from("meal_items").insert(rows);
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  // Удалённые позиции модели фиксируем отдельно, а не теряем (§10.1).
  const removed = payload.removed_source_item_ids ?? [];
  if (removed.length > 0) {
    const { error } = await supabase.from("meal_removed_items").upsert(
      removed.map((sourceItemId) => ({
        meal_id: mealId,
        source_item_id: sourceItemId,
      })),
      { onConflict: "meal_id,source_item_id" },
    );
    if (error) console.error("meal_removed_items upsert failed", error);
  }

  if (payload.dish_name_ru !== undefined) {
    await supabase
      .from("meals")
      .update({
        dish_name_ru: payload.dish_name_ru,
        // 'manual' переживает сохранение состава: это метка происхождения приёма
        // пищи (добавлен по справочнику, модель не участвовала), а не стадия
        // обработки. Затерев её на 'ready', мы бы подмешали ручные приёмы пищи в
        // выборки H1–H6, где они не значат ничего.
        status: meal.status === "manual" ? "manual" : "ready",
      })
      .eq("id", mealId);
  }

  const edited = rows.filter((r) => r.origin !== "model_kept").length;
  return NextResponse.json({
    ok: true,
    items: rows.length,
    edited,
    removed: removed.length,
    /** Показывать ли модалку «Откуда вес?» — только если что-то менялось (FR-EDIT-8). */
    should_ask_weight_evidence: edited > 0 || removed.length > 0,
  });
}
