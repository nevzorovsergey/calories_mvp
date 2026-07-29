import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCatalogNutrition, type NutrientMap } from "@/lib/nutrition/calc";

/**
 * Карточка позиции справочника для добавления без фотографии (§8.1).
 *
 * Одна позиция — это либо сырьё (`kind = 'ingredient'`), либо готовое блюдо
 * FNDDS (`kind = 'dish'`). Разница для этого экрана только в том, что у блюда
 * есть бытовые порции и раскладка на компоненты; всё остальное — общее.
 *
 * Нутриенты берутся у самой позиции, а не суммированием состава. У блюда FNDDS
 * собственный лабораторный профиль точнее суммы компонентов: он учитывает
 * уварку и потери при готовке, которых в раскладке нет. Состав здесь нужен,
 * чтобы человек увидел, из чего блюдо, и мог его поправить.
 */

export interface CatalogPortion {
  seq: number;
  /** Русская подпись, если перевод доехал; иначе английская из дампа. */
  label: string;
  gramWeight: number;
  /** Официальный размер порции FNDDS — предлагаем первым. */
  isDefault: boolean;
}

export interface CatalogComponent {
  seq: number;
  name: string;
  /** Доля в блюде, 0..1. Умножается на выбранный вес — см. миграцию 0006. */
  share: number;
  /** null — компонент, который не удалось привязать к справочнику (83 строки). */
  ingredientId: number | null;
}

export interface CatalogEntry {
  id: number;
  nameRu: string;
  nameEn: string;
  kind: "ingredient" | "dish";
  category: string | null;
  per100g: NutrientMap;
  portions: CatalogPortion[];
  components: CatalogComponent[];
}

/** Вес по умолчанию, когда у позиции нет ни одной порции (всё сырьё и 37 блюд). */
export const FALLBACK_WEIGHT_G = 100;

export async function loadCatalogEntry(
  supabase: SupabaseClient,
  id: number,
): Promise<CatalogEntry | null> {
  const { data: row, error } = await supabase
    .from("ingredients")
    .select("id, name_ru, name_en, kind, category")
    .eq("id", id)
    .eq("is_active", true)
    .single();
  if (error || !row) return null;

  const [{ data: portionRows }, { data: componentRows }, nutrition] = await Promise.all([
    supabase
      .from("ingredient_portions")
      .select("seq, label_en, label_ru, gram_weight, is_default")
      .eq("ingredient_id", id)
      .order("seq"),
    // Две ссылки на ingredients в одной таблице (dish_id и ingredient_id), и без
    // явного имени внешнего ключа PostgREST не знает, по какой из них джойнить.
    supabase
      .from("ingredient_components")
      // Строка запроса — единый литерал, а не склейка: типы PostgREST выводятся
      // из неё разбором на уровне типа, и конкатенация превращает результат в
      // GenericStringError.
      .select(
        "seq, share, ingredient_id, name_en_fallback, ingredients!ingredient_components_ingredient_id_fkey(name_ru)",
      )
      .eq("dish_id", id)
      .order("seq"),
    loadCatalogNutrition(supabase, [id]),
  ]);

  const portions: CatalogPortion[] = (portionRows ?? []).map((p) => ({
    seq: p.seq as number,
    label: ((p.label_ru as string | null) ?? (p.label_en as string)).trim(),
    gramWeight: Number(p.gram_weight),
    isDefault: Boolean(p.is_default),
  }));

  const components: CatalogComponent[] = (componentRows ?? []).map((c) => {
    const linked = c.ingredients as unknown as { name_ru: string } | null;
    return {
      seq: c.seq as number,
      name: linked?.name_ru ?? (c.name_en_fallback as string | null) ?? "без названия",
      share: Number(c.share),
      ingredientId: (c.ingredient_id as number | null) ?? null,
    };
  });

  return {
    id: row.id as number,
    nameRu: row.name_ru as string,
    nameEn: row.name_en as string,
    kind: row.kind as "ingredient" | "dish",
    category: (row.category as string | null) ?? null,
    per100g: nutrition.byIngredient.get(id) ?? {},
    // Порция по умолчанию первой: у 5325 блюд это готовый ответ на «сколько
    // обычно съедают за раз», и человеку почти никогда не надо выбирать дальше.
    portions: [...portions].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
    components,
  };
}

/** Стартовый вес: официальная порция, иначе первая доступная, иначе 100 г. */
export function defaultWeight(entry: CatalogEntry): number {
  return entry.portions[0]?.gramWeight ?? FALLBACK_WEIGHT_G;
}
