import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Модалка «Откуда вес?» (§11.5).
 *
 * Любой вопрос можно пропустить — тогда приходит null и это не блокирует
 * сохранение (FR-WE-4). Предзаполнение вопроса 2 тем, что нашла модель в
 * `scale_references`, даёт бесплатную разметку «модель увидела эталон / эталон
 * реально был», то есть точность самой детекции эталонов.
 */
export const dynamic = "force-dynamic";

export async function POST(
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

  const body = (await request.json()) as {
    method?: string | null;
    self_confidence?: number | null;
    reference_objects?: string[] | null;
    comment?: string | null;
  };

  const referenceObjects = body.reference_objects ?? [];
  const hadReference = referenceObjects.some((o) => o !== "none");

  const { error } = await supabase.from("weight_evidence").upsert(
    {
      meal_id: mealId,
      method: body.method ?? null,
      self_confidence: body.self_confidence ?? null,
      reference_objects: referenceObjects,
      had_reference: hadReference,
      comment: body.comment ?? null,
    },
    { onConflict: "meal_id" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
