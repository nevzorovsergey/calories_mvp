import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
