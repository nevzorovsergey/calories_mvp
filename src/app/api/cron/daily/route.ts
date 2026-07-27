import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { catalogPricing, fetchCatalog } from "@/lib/llm/polza";
import { MODELS_CONFIG } from "@config/models";

/**
 * Ежедневная служебная задача (vercel.json).
 *
 * 1. Пинг БД — Supabase Free засыпает после 7 дней без запросов (§4.3, риск №1).
 *    Vercel Hobby разрешает запускать cron раз в сутки, чего с запасом хватает.
 * 2. Снапшот цен polza.ai в `model_pricing_snapshots` (FR-COST-3) — защита от
 *    того, что тарифы поменяют и старые расчёты «поедут».
 * 3. Синхронизация config/models.ts в таблицу `model_configs` (§6), чтобы
 *    конфиг был виден из SQL при анализе.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Vercel Cron присылает Authorization: Bearer $CRON_SECRET.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Запрещено" }, { status: 401 });
    }
  }

  const supabase = createAdminClient();
  const report: Record<string, unknown> = {};

  const { count, error: pingError } = await supabase
    .from("nutrients")
    .select("id", { count: "exact", head: true });
  report.db_ping = pingError ? `ошибка: ${pingError.message}` : `ok (${count})`;

  await supabase.from("model_configs").upsert(
    MODELS_CONFIG.models.map((m) => ({
      model_id: m.id,
      label: m.label,
      vendor: m.vendor,
      enabled: m.enabled,
      prompt_version: m.promptVersion,
      config: m as never,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "model_id,prompt_version" },
  );
  report.model_configs = MODELS_CONFIG.models.length;

  try {
    const catalog = await fetchCatalog();
    const configured = new Set(MODELS_CONFIG.models.map((m) => m.id));
    const rows = catalog
      .filter((m) => configured.has(m.id))
      .map((m) => {
        const pricing = catalogPricing(m);
        return {
          model_id: m.id,
          provider: m.top_provider?.name ?? null,
          prompt_per_million_rub: pricing.promptRub,
          completion_per_million_rub: pricing.completionRub,
          raw: m as never,
        };
      });
    if (rows.length > 0) {
      await supabase.from("model_pricing_snapshots").insert(rows);
    }
    report.pricing_snapshots = rows.length;
    const missing = [...configured].filter(
      (id) => !catalog.some((m) => m.id === id),
    );
    if (missing.length > 0) {
      // Риск §16: ID моделей на polza.ai меняются / модель отключают.
      report.missing_from_catalog = missing;
    }
  } catch (error) {
    report.pricing_snapshots = `ошибка: ${error instanceof Error ? error.message : String(error)}`;
  }

  return NextResponse.json(report);
}
