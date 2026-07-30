import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Выгрузка датасета (FR-LAB-4): meals + recognitions + items + evidence.
 *
 * Это, по сути, продукт всего прототипа — именно на этих данных считаются
 * гипотезы. Доступ только админу; RLS всё равно не отдал бы чужие строки, но
 * проверка явная, чтобы обычный пользователь не получил пустой файл вместо
 * честного «403».
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();
  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Только для админа" }, { status: 403 });
  }

  const format = new URL(request.url).searchParams.get("format") ?? "json";

  const [
    meals,
    recognitions,
    recognitionItems,
    mealItems,
    removed,
    evidence,
    dishCandidates,
  ] =
    await Promise.all([
      supabase.from("meals").select("*"),
      supabase.from("recognitions").select("*"),
      supabase.from("recognition_items").select("*"),
      supabase.from("meal_items").select("*"),
      supabase.from("meal_removed_items").select("*"),
      supabase.from("weight_evidence").select("*"),
      // H7 и H8 (тикеты спеки .scratch/russian-dish-catalog): что предложила
      // модель тремя вариантами и во что это сматчилось. Что ВЫБРАЛ человек —
      // в meals (selected_dish_id, selected_candidate_position,
      // selected_portion_size), они приезжают сюда через select("*").
      //
      // Уровень происхождения веса порции (ingredients.portion_source_level)
      // здесь не выгружается: справочник — не пользовательские данные, он
      // одинаков для всех и джойнится при анализе по selected_dish_id.
      // Без него H8 посчитается по смеси уровней и измерит не то.
      supabase.from("recognition_dish_candidates").select("*"),
    ]);

  const dataset = {
    exported_at: new Date().toISOString(),
    meals: meals.data ?? [],
    recognitions: recognitions.data ?? [],
    recognition_items: recognitionItems.data ?? [],
    meal_items: mealItems.data ?? [],
    meal_removed_items: removed.data ?? [],
    weight_evidence: evidence.data ?? [],
    recognition_dish_candidates: dishCandidates.data ?? [],
  };

  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    // Один плоский CSV склеил бы шесть разных сущностей — вместо этого отдаём
    // архив из шести файлов, по одному на таблицу.
    const parts = Object.entries(dataset)
      .filter(([, value]) => Array.isArray(value))
      .map(([name, rows]) => `### ${name}\n${toCsv(rows as Record<string, unknown>[])}`)
      .join("\n\n");
    return new NextResponse(parts, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dataset-${stamp}.csv"`,
      },
    });
  }

  return new NextResponse(JSON.stringify(dataset, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="dataset-${stamp}.json"`,
    },
  });
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((c) => escape(row[c])).join(",")),
  ].join("\n");
}
