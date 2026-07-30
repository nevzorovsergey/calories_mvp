import { z } from "zod";
import type { PromptVersion } from "@config/models";

/**
 * Контракт с моделью (§7.3 PRD).
 *
 * Две сущности на одну схему:
 *  1. `buildResponseSchema()` — JSON Schema, которая уходит в запрос как
 *     `response_format: { type: "json_schema", strict: true }`.
 *  2. `dishAnalysisSchema` — зеркало на zod, которым мы валидируем ответ уже у
 *     себя. Нужно даже при strict: не все модели каталога его поддерживают,
 *     для них включается фолбэк на `json_object` (риск §16).
 *
 * A/B по §7.5.5:
 *  - `v2-scale` — полная схема с `scale_chain`;
 *  - `v1-plain` — без `scale_chain` (и без блока про масштаб в промпте).
 *    `scale_references` остаётся в обоих вариантах: это пассивное наблюдение
 *    «что модель увидела в кадре», оно нужно для H4 и для предзаполнения
 *    модалки «Откуда вес?» (FR-WE-2), и его отсутствие сломало бы сравнение по
 *    другой оси, чем та, которую проверяет H6.
 */

export const COOKING_METHODS = [
  "raw",
  "boiled",
  "steamed",
  "fried",
  "deep_fried",
  "baked",
  "grilled",
  "stewed",
  "smoked",
  "pickled",
  "unknown",
] as const;

export const REFERENCE_TYPES = [
  "coin",
  "bank_card",
  "ruler",
  "cutlery",
  "smartphone",
  "wristwatch",
  "fitness_tracker",
  "hand",
  "standard_plate",
  "standard_glass",
  "bottle",
  "other",
] as const;

export const CONTAINER_TYPES = [
  "plate",
  "deep_plate",
  "bowl",
  "cup",
  "glass",
  "box",
  "board",
  "pan",
  "paper",
  "none",
  "unknown",
] as const;

export const SCALE_MODES = ["reference", "container", "prior"] as const;

// ── zod-зеркало ─────────────────────────────────────────────────────────────

export const ingredientSchema = z.object({
  name_ru: z.string(),
  name_en: z.string(),
  weight_g: z.number(),
  weight_confidence: z.number().min(0).max(1),
  cooking_method: z.enum(COOKING_METHODS),
  state: z.enum(["raw", "cooked", "unknown"]),
  visible: z.boolean(),
  kcal_per_100g: z.number(),
  protein_per_100g: z.number(),
  fat_per_100g: z.number(),
  carbs_per_100g: z.number(),
});

export const scaleReferenceSchema = z.object({
  type: z.enum(REFERENCE_TYPES),
  description: z.string(),
  assumed_size_mm: z.number(),
  bbox: z.array(z.number()).length(4),
  apparent_fraction: z.number(),
  used_for_scale: z.boolean(),
  confidence: z.number(),
});

export const scaleChainSchema = z.object({
  scale_mode: z.enum(SCALE_MODES),
  anchor_type: z.string(),
  anchor_real_mm: z.number(),
  anchor_apparent_fraction: z.number(),
  mm_per_frame_width: z.number(),
  container_size_mm: z.number(),
  food_footprint_mm: z.number(),
  food_mean_height_mm: z.number(),
  estimated_volume_ml: z.number(),
  assumed_density_g_per_ml: z.number(),
});

export const containerSchema = z.object({
  type: z.enum(CONTAINER_TYPES),
  estimated_size_cm: z.number(),
  confidence: z.number(),
});

export const imageQualitySchema = z.object({
  angle: z.enum(["top_down", "45_degrees", "side", "unknown"]),
  lighting: z.enum(["good", "dim", "harsh", "mixed"]),
  occlusion: z.enum(["none", "partial", "heavy"]),
  blur: z.enum(["none", "slight", "heavy"]),
});

export const PORTION_SIZES = ["small", "medium", "large"] as const;

/**
 * `confidence` принимается терпимо, и это осознанно.
 *
 * Границы `minimum`/`maximum` вырезаются из JSON Schema перед отправкой (их не
 * принимает часть вендоров, см. UNSUPPORTED_KEYWORDS), поэтому модель узнаёт про
 * диапазон только из текста описания — и часть моделей его игнорирует. На
 * прогоне bench-dish Inkling вернул 95 вместо 0.95, и весь ответ упал по
 * `Too big`, хотя названия блюд в нём были верные.
 *
 * Ронять распознавание из-за косметического поля нельзя: `confidence` влияет
 * только на порядок вариантов, который и так задан позицией в массиве. Проценты
 * приводим к долям, остальное зажимаем в диапазон.
 */
const confidenceSchema = z
  .number()
  .transform((value) => (value > 1 ? value / 100 : value))
  .transform((value) => Math.min(Math.max(value, 0), 1));

export const dishCandidateSchema = z.object({
  name_ru: z.string(),
  confidence: confidenceSchema,
  why: z.string(),
});

/**
 * Ответ v3-dish. Единица распознавания — блюдо, а не ингредиент: состав и
 * типовой вес приходят из справочника, модель только называет блюдо и
 * оценивает размер порции относительно типичной.
 *
 * `scale_references` сохранён из v1/v2 намеренно: на нём стоит H4, и его
 * пропажа сломала бы сравнение по оси, которую v3 не проверяет.
 */
export const dishGuessSchema = z.object({
  dish_candidates: z.array(dishCandidateSchema),
  portion_size: z.enum(PORTION_SIZES),
  portion_reasoning: z.string(),
  scale_references: z.array(scaleReferenceSchema),
  container: containerSchema,
  image_quality: imageQualitySchema,
});

export type DishGuess = z.infer<typeof dishGuessSchema>;
export type DishCandidate = z.infer<typeof dishCandidateSchema>;

export const dishAnalysisSchema = z.object({
  dish_name_ru: z.string(),
  dish_name_en: z.string(),
  cuisine: z.string(),
  total_weight_g: z.number(),
  overall_confidence: z.number(),
  ingredients: z.array(ingredientSchema),
  scale_references: z.array(scaleReferenceSchema),
  scale_chain: scaleChainSchema.optional(),
  container: containerSchema,
  image_quality: imageQualitySchema,
  assumptions: z.array(z.string()),
});

export type DishAnalysis = z.infer<typeof dishAnalysisSchema>;
export type AnalysisIngredient = z.infer<typeof ingredientSchema>;
export type ScaleReference = z.infer<typeof scaleReferenceSchema>;
export type ScaleChain = z.infer<typeof scaleChainSchema>;

// ── JSON Schema для запроса ─────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

const ingredientsJsonSchema: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "name_ru",
      "name_en",
      "weight_g",
      "weight_confidence",
      "cooking_method",
      "state",
      "visible",
      "kcal_per_100g",
      "protein_per_100g",
      "fat_per_100g",
      "carbs_per_100g",
    ],
    properties: {
      name_ru: { type: "string" },
      name_en: { type: "string" },
      weight_g: { type: "number" },
      weight_confidence: {
        type: "number",
        description: "Уверенность в оценке массы, число от 0 до 1",
      },
      cooking_method: { type: "string", enum: COOKING_METHODS },
      state: {
        type: "string",
        enum: ["raw", "cooked", "unknown"],
        description: "Масса указана для сырого или готового продукта",
      },
      visible: {
        type: "boolean",
        description: "false — ингредиент выведен логически, не виден на фото",
      },
      kcal_per_100g: { type: "number" },
      protein_per_100g: { type: "number" },
      fat_per_100g: { type: "number" },
      carbs_per_100g: { type: "number" },
    },
  },
};

const scaleReferencesJsonSchema: JsonSchema = {
  type: "array",
  description:
    "Объекты в кадре, по которым можно оценить масштаб. Пустой массив, если таких нет.",
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "type",
      "description",
      "assumed_size_mm",
      "bbox",
      "apparent_fraction",
      "used_for_scale",
      "confidence",
    ],
    properties: {
      type: { type: "string", enum: REFERENCE_TYPES },
      description: { type: "string" },
      assumed_size_mm: {
        type: "number",
        description:
          "Реальный характерный размер объекта в мм, который ты принял",
      },
      bbox: {
        type: "array",
        description:
          "Рамка объекта: ровно 4 числа [x0, y0, x1, y1], каждое от 0 до 1 (доли ширины и высоты кадра)",
        items: { type: "number" },
      },
      apparent_fraction: {
        type: "number",
        description:
          "Видимый характерный размер объекта как доля ширины кадра, число от 0 до 1",
      },
      used_for_scale: {
        type: "boolean",
        description:
          "Использован ли этот объект как ведущий при построении scale_chain",
      },
      confidence: {
        type: "number",
        description: "Уверенность, что объект опознан верно, число от 0 до 1",
      },
    },
  },
};

const scaleChainJsonSchema: JsonSchema = {
  type: "object",
  description:
    "Как именно получен масштаб. Числа должны быть согласованы между собой.",
  additionalProperties: false,
  required: [
    "scale_mode",
    "anchor_type",
    "anchor_real_mm",
    "anchor_apparent_fraction",
    "mm_per_frame_width",
    "container_size_mm",
    "food_footprint_mm",
    "food_mean_height_mm",
    "estimated_volume_ml",
    "assumed_density_g_per_ml",
  ],
  properties: {
    scale_mode: {
      type: "string",
      enum: SCALE_MODES,
      description:
        "reference — по эталонному объекту; container — по типовому размеру посуды; prior — по общему представлению о порции",
    },
    anchor_type: {
      type: "string",
      description: "Тип объекта-якоря, либо 'none' при scale_mode=prior",
    },
    anchor_real_mm: {
      type: "number",
      description: "Реальный размер якоря в мм, 0 если якоря нет",
    },
    anchor_apparent_fraction: {
      type: "number",
      description:
        "Его видимый размер как доля ширины кадра, 0 если якоря нет",
    },
    mm_per_frame_width: {
      type: "number",
      description:
        "Сколько мм укладывается в полную ширину кадра = anchor_real_mm / anchor_apparent_fraction",
    },
    container_size_mm: {
      type: "number",
      description:
        "Полученный размер посуды (диаметр или наибольший габарит), мм",
    },
    food_footprint_mm: {
      type: "number",
      description: "Характерный размер пятна еды, мм",
    },
    food_mean_height_mm: {
      type: "number",
      description: "Средняя высота слоя еды, мм",
    },
    estimated_volume_ml: { type: "number" },
    assumed_density_g_per_ml: {
      type: "number",
      description: "Средняя принятая плотность блюда",
    },
  },
};

// Общие для всех версий промпта: и разбор на ингредиенты, и угадывание блюда
// одинаково описывают посуду и качество кадра.
const containerJsonSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "estimated_size_cm", "confidence"],
  properties: {
    type: { type: "string", enum: CONTAINER_TYPES },
    estimated_size_cm: {
      type: "number",
      description: "Диаметр или наибольший размер, см",
    },
    confidence: {
      type: "number",
      description: "Уверенность в оценке посуды, число от 0 до 1",
    },
  },
};

const imageQualityJsonSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["angle", "lighting", "occlusion", "blur"],
  properties: {
    angle: {
      type: "string",
      enum: ["top_down", "45_degrees", "side", "unknown"],
    },
    lighting: { type: "string", enum: ["good", "dim", "harsh", "mixed"] },
    occlusion: { type: "string", enum: ["none", "partial", "heavy"] },
    blur: { type: "string", enum: ["none", "slight", "heavy"] },
  },
};

/**
 * Ключевые слова JSON Schema, которые поддерживают не все вендоры: Anthropic,
 * например, отвечает `400 For 'number' type, properties maximum, minimum are
 * not supported`. Убираем их из схемы, которая уходит в модель, — диапазоны
 * всё равно описаны словами в `description`, а настоящая проверка границ
 * происходит у нас в zod после ответа.
 */
const UNSUPPORTED_KEYWORDS = ["minimum", "maximum", "minItems", "maxItems"];

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (node === null || typeof node !== "object") return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;
    result[key] = stripUnsupportedKeywords(value);
  }
  return result;
}

const dishCandidatesJsonSchema: JsonSchema = {
  type: "array",
  description:
    "Ровно три варианта названия блюда, от самого вероятного к наименее вероятному. Три РАЗНЫЕ гипотезы, а не одно блюдо с уточнениями.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name_ru", "confidence", "why"],
    properties: {
      name_ru: {
        type: "string",
        description:
          "Название по-русски, как его скажет человек дома. Строчными, без кавычек, не длиннее 60 символов",
      },
      confidence: {
        type: "number",
        description: "Уверенность в этом варианте, число от 0 до 1",
      },
      why: {
        type: "string",
        description:
          "Короткая зацепка из кадра, по которой сделан вывод. Одна фраза, показывается пользователю",
      },
    },
  },
};

function buildDishGuessSchema(): JsonSchema {
  return {
    name: "dish_guess",
    strict: true,
    schema: stripUnsupportedKeywords({
      type: "object",
      additionalProperties: false,
      required: [
        "dish_candidates",
        "portion_size",
        "portion_reasoning",
        "scale_references",
        "container",
        "image_quality",
      ],
      properties: {
        dish_candidates: dishCandidatesJsonSchema,
        portion_size: {
          type: "string",
          enum: PORTION_SIZES,
          description:
            "Размер порции ОТНОСИТЕЛЬНО типичной порции этого блюда: small — заметно меньше обычной, medium — обычная, large — заметно больше",
        },
        portion_reasoning: {
          type: "string",
          description:
            "На чём основана оценка размера: посуда, её заполненность. Коротко, по-русски",
        },
        scale_references: scaleReferencesJsonSchema,
        container: containerJsonSchema,
        image_quality: imageQualityJsonSchema,
      },
    }) as JsonSchema,
  };
}

export function buildResponseSchema(promptVersion: PromptVersion): JsonSchema {
  if (promptVersion === "v3-dish") return buildDishGuessSchema();

  const withScaleChain = promptVersion === "v2-scale";

  const required = [
    "dish_name_ru",
    "dish_name_en",
    "cuisine",
    "total_weight_g",
    "ingredients",
    "scale_references",
    ...(withScaleChain ? ["scale_chain"] : []),
    "container",
    "image_quality",
    "overall_confidence",
    "assumptions",
  ];

  const properties: JsonSchema = {
    dish_name_ru: { type: "string" },
    dish_name_en: { type: "string" },
    cuisine: {
      type: "string",
      description: "Кухня: русская, итальянская, японская и т.д.",
    },
    total_weight_g: {
      type: "number",
      description: "Суммарная масса съедобной части, г",
    },
    overall_confidence: {
      type: "number",
      description: "Общая уверенность в разборе блюда, число от 0 до 1",
    },
    ingredients: ingredientsJsonSchema,
    scale_references: scaleReferencesJsonSchema,
    ...(withScaleChain ? { scale_chain: scaleChainJsonSchema } : {}),
    container: containerJsonSchema,
    image_quality: imageQualityJsonSchema,
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "Ключевые допущения при оценке, коротко, по-русски",
    },
  };

  return {
    name: "dish_analysis",
    strict: true,
    schema: stripUnsupportedKeywords({
      type: "object",
      additionalProperties: false,
      required,
      properties,
    }) as JsonSchema,
  };
}
