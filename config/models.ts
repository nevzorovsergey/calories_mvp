/**
 * Конфигурация моделей (§6 PRD).
 *
 * Живёт в репозитории и дублируется в таблицу `model_configs` при деплое —
 * так конфиг видно из SQL при анализе.
 *
 * Состав подобран не на глаз: `scripts/bench-models.ts` прогнал шесть
 * кандидатов по пяти реальным фотографиям блюд (fixtures/) и сравнил их по
 * проверяемым признакам. Результаты прогона от 2026-07-26, промпт v2-scale:
 *
 *   Модель                     сбои  состав  вес   эталон  цепочка  сек  ₽/шт
 *   GPT-5.1                     0     100%   80%    100%    100%     25  1.30
 *   Grok 4.5                    0     100%  100%    100%     60%     27  1.59
 *   Gemini 3 Flash (preview)    0     100%   80%    100%     40%     15  0.63
 *   Gemini 3.6 Flash            0     100%   80%    100%     60%     14  2.27
 *   Claude Sonnet 5             1     100%  100%    100%     25%     24  3.79
 *   Qwen3-VL 235B               0      96%   80%     50%      0%     27  0.21
 *
 * «цепочка» — доля ответов, где числа scale_chain сходятся между собой
 * (§7.5.2). Это и есть та самая метрика «модель считает или имитирует
 * расчёт», которой нет в публичных бенчмарках, и разброс по ней оказался
 * самым большим: от 100% у GPT-5.1 до 0% у Qwen.
 *
 * Свежий прогон: npx tsx scripts/bench-models.ts
 * Сверка id с живым каталогом: npx tsx scripts/sync-models-catalog.ts
 */

export type PromptVersion = "v1-plain" | "v2-scale" | "v3-dish";

export interface VendorPricing {
  currency: "USD";
  promptPerMillion: number;
  completionPerMillion: number;
  /** Цена закэшированного промпта; если вендор не публикует — равна обычной. */
  cachedPromptPerMillion: number;
  source: string;
  /** Дата ручной сверки цены, YYYY-MM-DD. */
  checkedAt: string;
}

export interface ModelConfig {
  /** id в каталоге polza.ai */
  id: string;
  label: string;
  vendor: string;
  enabled: boolean;
  /** low | high | auto — влияет на цену */
  imageDetail: "low" | "high" | "auto";
  maxTokens: number;
  temperature: number;
  promptVersion: PromptVersion;
  /**
   * Официальные цены вендора для расчёта «сколько было бы напрямую» (§9.2).
   * null — цена не сверена; тогда `cost_direct_usd` останется NULL, а
   * фактическая стоимость в рублях (из `usage.cost_rub`) всё равно пишется.
   * Не выдумывайте числа: пустая колонка честнее неверной.
   */
  vendorPricing: VendorPricing | null;
}

export const MODELS_CONFIG = {
  /**
   * Что вызывается автоматически в момент фотографирования: модель отвечает
   * названием блюда, состав приходит из справочника после выбора человека.
   *
   * Выбрана прогоном scripts/bench-dish.ts от 2026-07-30: ноль сбоев, три
   * различимых варианта и верное название первым на всех пяти фото, 7 секунд
   * и 1.50 ₽ за пятёрку.
   *
   * Версия промпта здесь обязательна, а не для красоты: одна и та же модель
   * стоит в списке дважды под разными промптами (A/B), и поиск по одному лишь
   * `id` вернул бы ту, что раньше лежит в массиве, — то есть выбор зависел бы
   * от порядка строк ниже.
   */
  defaultModelId: "google/gemini-3-flash-preview",
  defaultPromptVersion: "v3-dish" as PromptVersion,

  /**
   * Запасной путь: «распознать состав нейросетью», когда среди трёх названий
   * нужного не оказалось. Разбор на ингредиенты — то, чем распознавание было
   * до справочника блюд, и v2-scale здесь ровно та же связка, что раньше
   * работала первой.
   */
  ingredientsModelId: "google/gemini-3-flash-preview",
  ingredientsPromptVersion: "v2-scale" as PromptVersion,

  models: [
    {
      id: "openai/gpt-5.1",
      label: "GPT-5.1",
      vendor: "openai",
      enabled: true,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v2-scale",
      vendorPricing: {
        currency: "USD",
        promptPerMillion: 1.25,
        completionPerMillion: 10.0,
        cachedPromptPerMillion: 0.125,
        // Сверено по агрегатору, а не по openai.com — перепроверьте перед
        // тем, как опираться на колонку «напрямую, $» в выводах.
        source: "benchlm.ai/openai/api-pricing",
        checkedAt: "2026-07-26",
      },
    },
    {
      // A/B-пара к основной модели: тот же GPT-5.1, промпт без масштабной
      // цепочки. Ровно этим проверяется H6 (§7.5.5) — помогает ли принуждение
      // к явной цепочке или, наоборот, мешает.
      id: "openai/gpt-5.1",
      label: "GPT-5.1 (промпт без масштаба)",
      vendor: "openai",
      enabled: true,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v1-plain",
      vendorPricing: {
        currency: "USD",
        promptPerMillion: 1.25,
        completionPerMillion: 10.0,
        cachedPromptPerMillion: 0.125,
        source: "benchlm.ai/openai/api-pricing",
        checkedAt: "2026-07-26",
      },
    },
    {
      // Второй вендор для H3. В замере — единственный вместе с Claude, кто на
      // всех фото попал в здравый диапазон массы. Сейчас выключен (FR-CONF-3):
      // в списке «проверить другой моделью» не появится, а прошлые прогоны
      // остаются в сравнении.
      id: "x-ai/grok-4.5",
      label: "Grok 4.5",
      vendor: "xai",
      enabled: false,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v2-scale",
      // TODO: сверить с x.ai/api и проставить checkedAt.
      vendorPricing: null,
    },
    {
      // Дешёвый и быстрый край: 0.63 ₽ и 15 с за распознавание при полном
      // попадании по составу. Осторожно: id с суффиксом -preview у Google
      // живёт недолго, проверяйте sync-models-catalog перед длинным прогоном.
      id: "google/gemini-3-flash-preview",
      label: "Gemini 3 Flash (preview)",
      vendor: "google",
      enabled: true,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v2-scale",
      vendorPricing: {
        currency: "USD",
        promptPerMillion: 0.25,
        completionPerMillion: 1.5,
        cachedPromptPerMillion: 0.25,
        source: "pricepertoken.com/google-gemini-3-flash-preview",
        checkedAt: "2026-07-26",
      },
    },
    {
      // A/B-пара по другой оси, чем H6: не «как считать вес», а «что вообще
      // спрашивать у модели». v3-dish просит три названия блюда вместо разбора
      // на ингредиенты, состав и вес приходят из справочника (H7, H8).
      //
      // Модель выбрана прогоном scripts/bench-dish.ts от 2026-07-30 по
      // одиннадцати кандидатам: ноль сбоев, схема принята на всех пяти фото,
      // три различимых варианта везде, нужное название первым вариантом везде,
      // 7 секунд и 1.50 ₽ за пять фотографий — лучшее сочетание из всех.
      id: "google/gemini-3-flash-preview",
      label: "Gemini 3 Flash (по названию блюда)",
      vendor: "google",
      enabled: true,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v3-dish",
      vendorPricing: {
        currency: "USD",
        promptPerMillion: 0.25,
        completionPerMillion: 1.5,
        cachedPromptPerMillion: 0.25,
        source: "pricepertoken.com/google-gemini-3-flash-preview",
        checkedAt: "2026-07-26",
      },
    },
    {
      // Самая дешёвая из надёжных на том же прогоне: 0.47 ₽ за пять фото при
      // нуле сбоев и верном названии первым вариантом. Вторая точка v3-dish —
      // чтобы H7 не оказалась замером одной модели.
      id: "qwen/qwen3-vl-235b-a22b-instruct",
      label: "Qwen3-VL 235B (по названию блюда)",
      vendor: "alibaba",
      enabled: true,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v3-dish",
      vendorPricing: null,
    },
    {
      // Стабильный (не preview) вариант Google на случай, если id выше отключат.
      id: "google/gemini-3.6-flash",
      label: "Gemini 3.6 Flash",
      vendor: "google",
      enabled: true,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v2-scale",
      vendorPricing: null,
    },
    {
      // Самая дорогая и единственная, кто в замере отдал пустой ответ (49 с и
      // 6 ₽ впустую — похоже, размышления съели весь лимит). Выключена
      // (FR-CONF-3): из списка перепрогона убрана, прошлые результаты
      // сохраняются. maxTokens оставлен увеличенным — на случай возврата.
      id: "anthropic/claude-sonnet-5",
      label: "Claude Sonnet 5",
      vendor: "anthropic",
      enabled: false,
      imageDetail: "high",
      maxTokens: 8000,
      temperature: 0.2,
      promptVersion: "v2-scale",
      vendorPricing: {
        currency: "USD",
        promptPerMillion: 3.0,
        completionPerMillion: 15.0,
        cachedPromptPerMillion: 0.3,
        source: "anthropic.com/pricing",
        checkedAt: "2026-07-26",
      },
    },
    {
      // Дешёвый край списка: 0.21 ₽ за распознавание, в разы дешевле всех
      // остальных. По качеству в замере заметно слабее — пропустила фарш в
      // болоньезе, нашла эталон в половине случаев, ни разу не свела цепочку.
      // Включена именно для ручного сравнения: видно, чем платишь за дешевизну.
      id: "qwen/qwen3-vl-235b-a22b-instruct",
      label: "Qwen3-VL 235B",
      vendor: "alibaba",
      enabled: true,
      imageDetail: "high",
      maxTokens: 4000,
      temperature: 0.2,
      promptVersion: "v2-scale",
      vendorPricing: null,
    },
  ] satisfies ModelConfig[] as ModelConfig[],
};

/**
 * Ключ варианта = модель + версия промпта. Одна и та же модель может быть в
 * конфиге дважды с разными промптами (A/B для H6, §7.5.5), поэтому искать
 * только по `id` нельзя.
 */
export function variantKey(modelId: string, promptVersion: string): string {
  return `${modelId}@${promptVersion}`;
}

export function getModel(
  modelId: string,
  promptVersion?: string,
): ModelConfig | undefined {
  return MODELS_CONFIG.models.find(
    (m) =>
      m.id === modelId &&
      (promptVersion === undefined || m.promptVersion === promptVersion),
  );
}

function requireModel(
  modelId: string,
  promptVersion: PromptVersion,
  field: string,
): ModelConfig {
  const model = MODELS_CONFIG.models.find(
    (m) => m.id === modelId && m.promptVersion === promptVersion && m.enabled,
  );
  if (!model) {
    throw new Error(
      `${field}=${variantKey(modelId, promptVersion)} отсутствует в MODELS_CONFIG.models или выключен`,
    );
  }
  return model;
}

/** Распознавание при съёмке: три названия блюда (v3-dish). */
export function getDefaultModel(): ModelConfig {
  return requireModel(
    MODELS_CONFIG.defaultModelId,
    MODELS_CONFIG.defaultPromptVersion,
    "defaultModelId",
  );
}

/** Запасной путь: разбор фотографии на ингредиенты. */
export function getIngredientsModel(): ModelConfig {
  return requireModel(
    MODELS_CONFIG.ingredientsModelId,
    MODELS_CONFIG.ingredientsPromptVersion,
    "ingredientsModelId",
  );
}

/** Модели, доступные для ручного перепрогона (FR-CONF-3). */
export function getEnabledModels(): ModelConfig[] {
  return MODELS_CONFIG.models.filter((m) => m.enabled);
}
