import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/lab/guard";

/**
 * Синонимы позиции справочника (FR-LABX-4).
 *
 * Синоним — это рабочий инструмент маппинга, а не украшение: поиск сверяет
 * запрос и с названиями, и с алиасами (0015, 0016), поэтому добавить «свёкла» к
 * «Beets, raw» значит починить конкретный промах модели раз и навсегда. Ровно
 * это делает пользователь, привязывая unmatched-позицию (FR-CAT-1) — здесь то
 * же самое, но руками и заранее.
 *
 * `source = 'admin'` отделяет ручную правку от импорта и от самообучения на
 * использовании: иначе нельзя будет ответить, сколько синонимов справочник
 * набрал сам, а сколько ему дописали.
 */
export const dynamic = "force-dynamic";

const NewAlias = z.object({
  alias: z.string().trim().min(1).max(300),
  lang: z.enum(["ru", "en"]),
});

export async function POST(
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

  const parsed = NewAlias.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Нужны поля alias и lang" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("ingredient_aliases")
    .insert({
      ingredient_id: ingredientId,
      alias: parsed.data.alias,
      lang: parsed.data.lang,
      source: "admin",
    })
    .select("id, alias, lang, source, created_at")
    .maybeSingle();

  if (error) {
    // unique (alias, lang) — синоним уже занят, возможно другой позицией. Это
    // штатный исход, и говорить о нём надо человеческим языком: «23505».
    const conflict = error.code === "23505";
    return NextResponse.json(
      {
        error: conflict
          ? "Такой синоним уже есть — возможно, у другой позиции"
          : error.message,
      },
      { status: conflict ? 409 : 500 },
    );
  }

  return NextResponse.json({ ok: true, alias: data });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ingredientId = Number(id);
  const aliasId = Number(new URL(request.url).searchParams.get("alias_id"));
  if (!Number.isInteger(ingredientId) || !Number.isInteger(aliasId)) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }

  const supabase = await createClient();
  const denied = await requireAdmin(supabase);
  if (denied) return denied;

  // Условие по ingredient_id избыточно для попадания, но не для безопасности:
  // без него опечатка в alias_id снесла бы синоним у соседней позиции.
  const { error } = await supabase
    .from("ingredient_aliases")
    .delete()
    .eq("id", aliasId)
    .eq("ingredient_id", ingredientId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
