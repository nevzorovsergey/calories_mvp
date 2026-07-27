/**
 * Дым-тест связки с polza.ai — до всякого UI и БД.
 *
 *   npx tsx scripts/smoke-recognize.ts ./fixtures/plate.jpg [--model ID] [--prompt v1-plain]
 *
 * Вызывает модель реальным запросом и печатает: разобранный JSON, usage,
 * посчитанную стоимость в рублях и долларах и результат трёх проверок
 * согласованности масштабной цепочки. Отвечает на вопрос «работает ли связка»
 * одним запуском, не требуя ни Supabase, ни фронтенда.
 */

import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { MODELS_CONFIG, getDefaultModel, getModel } from "../config/models";
import { computeCost, recognizeDish } from "../src/lib/llm/polza";
import { runScaleChecks } from "../src/lib/llm/scale-check";

loadEnv({ path: ".env.local" });

async function main() {
  const [imagePath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!imagePath) {
    console.error(
      "Использование: npx tsx scripts/smoke-recognize.ts ./photo.jpg [--model ID] [--prompt v1-plain|v2-scale]",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const modelArg = args.indexOf("--model");
  const promptArg = args.indexOf("--prompt");
  const promptVersion = promptArg >= 0 ? args[promptArg + 1] : undefined;

  const model =
    modelArg >= 0
      ? (getModel(args[modelArg + 1], promptVersion) ??
        (() => {
          throw new Error(
            `Модель ${args[modelArg + 1]} не найдена в config/models.ts. Доступны:\n` +
              MODELS_CONFIG.models
                .map((m) => `  ${m.id} (${m.promptVersion})`)
                .join("\n"),
          );
        })())
      : getDefaultModel();

  console.log(`Модель: ${model.label} (${model.id}), промпт ${model.promptVersion}`);

  const imageBase64 = readFileSync(imagePath).toString("base64");
  console.log(`Изображение: ${imagePath}, ${Math.round(imageBase64.length / 1365)} КБ\n`);

  const result = await recognizeDish({ model, imageBase64 });

  console.log(`Статус: ${result.status}`);
  console.log(`Латентность: ${(result.latencyMs / 1000).toFixed(1)} с`);
  if (result.retried) console.log("⚠ была повторная попытка (5xx/таймаут)");
  if (result.usedJsonObjectFallback) {
    console.log("⚠ модель не приняла strict json_schema — фолбэк на json_object");
  }

  if (result.status === "failed" || !result.analysis) {
    console.error(`\nОшибка: ${result.errorText}`);
    console.error(JSON.stringify(result.raw, null, 2)?.slice(0, 2000));
    process.exit(1);
  }

  const analysis = result.analysis;
  console.log(`\nБлюдо: ${analysis.dish_name_ru} (${analysis.cuisine})`);
  console.log(`Общий вес: ${analysis.total_weight_g} г, уверенность ${analysis.overall_confidence}`);
  console.log("\nИнгредиенты:");
  for (const ingredient of analysis.ingredients) {
    console.log(
      `  ${ingredient.name_ru.padEnd(28)} ${String(ingredient.weight_g).padStart(6)} г  ` +
        `${ingredient.kcal_per_100g} ккал/100г${ingredient.visible ? "" : "  (выведено логически)"}`,
    );
  }

  console.log("\nЭталоны в кадре:");
  if (analysis.scale_references.length === 0) console.log("  не найдены");
  for (const reference of analysis.scale_references) {
    console.log(
      `  ${reference.type} — ${reference.assumed_size_mm} мм, доля кадра ${reference.apparent_fraction}, ` +
        `ведущий: ${reference.used_for_scale}`,
    );
  }

  // Эталоны пользователя здесь неизвестны, поэтому scale_size_error не считается —
  // проверяется только внутренняя согласованность цепочки (§7.5.2).
  const scale = runScaleChecks(analysis, []);
  console.log("\nМасштабная цепочка:");
  if (!analysis.scale_chain) {
    console.log("  промпт v1-plain — цепочка не запрашивалась");
  } else {
    console.log(`  режим: ${analysis.scale_chain.scale_mode}`);
    for (const check of scale.consistency_checks) {
      const verdict = check.deviation > check.threshold ? "✗" : "✓";
      console.log(
        `  ${verdict} ${check.flag}: ожидалось ${check.expected.toFixed(1)}, ` +
          `получено ${check.reported.toFixed(1)} (расхождение ${(check.deviation * 100).toFixed(0)}%, порог ${check.threshold * 100}%)`,
      );
    }
    console.log(
      scale.consistency_flags.length === 0
        ? "  → числа сходятся между собой"
        : `  → цепочка не согласована: ${scale.consistency_flags.join(", ")}`,
    );
  }

  const cost = computeCost(result.usage, model.vendorPricing);
  console.log("\nСтоимость и токены:");
  console.log(`  prompt: ${cost.prompt_tokens}, completion: ${cost.completion_tokens}`);
  console.log(`  факт: ${cost.cost_rub_actual ?? "—"} ₽`);
  console.log(
    `  напрямую у вендора: ${cost.cost_direct_usd !== null ? `$${cost.cost_direct_usd.toFixed(5)}` : "— (цена вендора не сверена)"}`,
  );

  if (!result.usage) {
    console.log(
      "\n⚠ polza.ai не вернул usage — стоимость и токены писать будет неоткуда.\n" +
        "  Проверьте формат ответа в raw и при необходимости поправьте computeCost().",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
