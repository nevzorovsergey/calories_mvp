/**
 * Сверка config/models.ts с живым каталогом polza.ai (§6 PRD, риск §16).
 *
 *   npx tsx scripts/sync-models-catalog.ts [--all]
 *
 * Печатает мультимодальные модели каталога с ценами в рублях и ругается на
 * каждый id из конфига, которого в каталоге нет: id меняются, модели
 * отключают, и узнать об этом лучше до, а не во время сбора данных.
 */

import { config as loadEnv } from "dotenv";
import { MODELS_CONFIG } from "../config/models";
import { catalogPricing, fetchCatalog } from "../src/lib/llm/polza";

loadEnv({ path: ".env.local" });

async function main() {
  if (!process.env.POLZA_API_KEY) {
    throw new Error("POLZA_API_KEY не задан — положите ключ в .env.local");
  }

  const showAll = process.argv.includes("--all");
  const catalog = await fetchCatalog();
  console.log(`В каталоге мультимодальных моделей: ${catalog.length}\n`);

  const configured = new Set(MODELS_CONFIG.models.map((m) => m.id));
  const rows = showAll ? catalog : catalog.slice(0, 40);

  for (const model of rows) {
    const mark = configured.has(model.id) ? "✔" : " ";
    const { promptRub, completionRub } = catalogPricing(model);
    const price =
      promptRub !== null && completionRub !== null
        ? `${promptRub.toFixed(2)} / ${completionRub.toFixed(2)} ₽ за 1M`
        : "цена не указана";
    console.log(`${mark} ${model.id.padEnd(46)} ${price}`);
  }
  if (!showAll && catalog.length > rows.length) {
    console.log(`… ещё ${catalog.length - rows.length}, покажет --all`);
  }

  const missing = [...configured].filter(
    (id) => !catalog.some((m) => m.id === id),
  );
  if (missing.length > 0) {
    console.log("\n⚠ В config/models.ts есть id, которых нет в каталоге:");
    for (const id of missing) console.log(`   ${id}`);
    console.log(
      "   Замените их на реальные id из списка выше, иначе распознавание\n" +
        "   будет падать с 404, а расходы на неудачные попытки всё равно\n" +
        "   попадут в статистику.",
    );
    process.exitCode = 1;
  } else {
    console.log("\n✔ Все модели из конфига есть в каталоге.");
  }

  const withoutPricing = MODELS_CONFIG.models.filter((m) => !m.vendorPricing);
  if (withoutPricing.length > 0) {
    console.log(
      "\nℹ Без сверенных цен вендора (cost_direct_usd останется пустым):",
    );
    for (const model of withoutPricing) console.log(`   ${model.id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
