import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/**
 * Самообучение справочника на использовании (FR-CAT-1).
 *
 * Когда человек привязывает unmatched-позицию к справочнику, его выбор
 * становится алиасом, и следующий такой промах модели чинится сам. Раньше
 * вставку делал браузер, попутно спрашивая у Supabase, кто он такой, — два
 * запроса на плохом канале ради записи, которую человек даже не ждёт.
 *
 * `created_by` берётся из сессии, а не из тела запроса: авторство алиаса — это
 * данные для разбора качества справочника, и позволить клиенту назначать его
 * значило бы разрешить приписать свой выбор кому угодно.
 *
 * Отличие от `/api/lab/catalog/[id]/aliases`: там админ заводит синонимы руками
 * и заранее (`source = 'admin'`), здесь они появляются сами из работы
 * пользователя (`source = 'user_mapping'`). Разделение источников — то, без
 * чего нельзя ответить, сколько справочник набрал сам.
 */
export const dynamic = "force-dynamic";

const NewAlias = z.object({
  ingredient_id: z.number().int().positive(),
  alias: z.string().trim().min(1).max(300),
});

export async function POST(request: Request) {
  const parsed = NewAlias.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Нужны поля ingredient_id и alias" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const { error } = await supabase.from("ingredient_aliases").insert({
    ingredient_id: parsed.data.ingredient_id,
    alias: parsed.data.alias.toLowerCase(),
    lang: "ru",
    source: "user_mapping",
    created_by: user.id,
  });

  // Конфликт по (alias, lang) — штатный исход, а не сбой: алиас уже есть, и
  // цель вызова достигнута. Так же на это смотрел и прежний код в браузере.
  if (error && error.code !== "23505") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
