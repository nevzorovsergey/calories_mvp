import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { REFERENCE_PRESETS } from "@config/reference-objects";

/**
 * «Мои эталоны» (§7.5.4, FR-SCALE-4) — добавление и снятие отметки.
 *
 * Клиент присылает только ключ пресета, а размеры берутся из реестра на
 * сервере. Раньше браузер писал `true_size_mm` в таблицу сам, и это была не
 * просто лишняя работа на плохом канале: этот размер — знаменатель
 * `scale_size_error`, то есть измерительный эталон. Позволять клиенту
 * назначать его значит разрешить подкрутить метрику качества модели.
 *
 * `user_id` тоже берётся из сессии, а не из тела запроса. RLS и так не дала бы
 * записать чужую строку, но полагаться на неё как на единственную проверку
 * значит узнать об ошибке в виде пустого ответа вместо внятного отказа.
 */
export const dynamic = "force-dynamic";

const Toggle = z.object({ key: z.string().trim().min(1) });

export async function POST(request: Request) {
  const parsed = Toggle.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Нужен ключ эталона" }, { status: 400 });
  }

  const preset = REFERENCE_PRESETS.find((p) => p.key === parsed.data.key);
  if (!preset) {
    return NextResponse.json({ error: "Неизвестный эталон" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("user_reference_objects")
    .insert({
      user_id: user.id,
      type: preset.type,
      label: preset.label,
      true_size_mm: preset.trueSizeMm,
      size_axis: preset.sizeAxis,
    })
    .select("id, type, label, true_size_mm, size_axis")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Не удалось сохранить эталон" },
      { status: 500 },
    );
  }

  return NextResponse.json({ object: data });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Нужен id эталона" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  // Условие по user_id избыточно при работающей RLS, но оно и есть та причина,
  // по которой чужую строку не снесёт опечатка в id.
  const { error } = await supabase
    .from("user_reference_objects")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
