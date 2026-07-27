import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMealItems, signPhoto } from "@/lib/data/meals";
import { loadCatalogNutrition } from "@/lib/nutrition/calc";
import MealEditor, { type EditorItem, type NutrientMap } from "@/components/MealEditor";

export const dynamic = "force-dynamic";

export default async function EditMealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: meal } = await supabase
    .from("meals")
    .select("id, dish_name_ru, photo_sent_path, primary_recognition_id, status")
    .eq("id", id)
    .single();
  if (!meal) notFound();

  const items = await getMealItems(supabase, id);

  // Что предлагала модель: нужно, чтобы показать зачёркнутое исходное значение
  // и пометку «выведено логически» (FR-EDIT-6).
  const { data: modelItems } = meal.primary_recognition_id
    ? await supabase
        .from("recognition_items")
        .select("id, weight_g, visible")
        .eq("recognition_id", meal.primary_recognition_id)
    : { data: [] };
  const modelById = new Map(
    (modelItems ?? []).map((row) => [
      row.id as string,
      { weight: Number(row.weight_g), visible: row.visible as boolean },
    ]),
  );

  const catalog = await loadCatalogNutrition(
    supabase,
    items.map((i) => i.ingredient_id).filter((x): x is number => x !== null),
  );

  const editorItems: EditorItem[] = items.map((item) => {
    const model = item.source_item_id ? modelById.get(item.source_item_id) : undefined;
    const catalogMap =
      item.ingredient_id !== null
        ? catalog.byIngredient.get(item.ingredient_id)
        : undefined;

    const per100g: NutrientMap = catalogMap
      ? { ...catalogMap }
      : {
          ...(item.kcal_per_100g !== null
            ? { energy_kcal: Number(item.kcal_per_100g) }
            : {}),
          ...(item.protein_per_100g !== null
            ? { protein: Number(item.protein_per_100g) }
            : {}),
          ...(item.fat_per_100g !== null ? { fat: Number(item.fat_per_100g) } : {}),
          ...(item.carbs_per_100g !== null
            ? { carbs: Number(item.carbs_per_100g) }
            : {}),
        };

    return {
      key: item.id,
      source_item_id: item.source_item_id,
      ingredient_id: item.ingredient_id,
      name_ru: item.name_ru,
      weight_g: Number(item.weight_g),
      modelWeight: model?.weight ?? null,
      visible: model?.visible ?? true,
      nutrition_source: catalogMap ? "catalog" : "model",
      per100g,
    };
  });

  // Предзаполнение вопроса 2 модалки «Откуда вес?» (FR-WE-2).
  const { data: recognition } = meal.primary_recognition_id
    ? await supabase
        .from("recognitions")
        .select("parsed")
        .eq("id", meal.primary_recognition_id)
        .maybeSingle()
    : { data: null };
  const detectedReferences = [
    ...new Set(
      (
        (recognition?.parsed as { scale_references?: { type: string }[] } | null)
          ?.scale_references ?? []
      ).map((r) => r.type),
    ),
  ];

  const { data: evidence } = await supabase
    .from("weight_evidence")
    .select("id")
    .eq("meal_id", id)
    .maybeSingle();

  const photoUrl = await signPhoto(supabase, meal.photo_sent_path);

  return (
    <MealEditor
      mealId={id}
      photoUrl={photoUrl}
      initialDishName={meal.dish_name_ru ?? ""}
      initialItems={editorItems}
      detectedReferences={detectedReferences}
      hasEvidence={!!evidence}
    />
  );
}
