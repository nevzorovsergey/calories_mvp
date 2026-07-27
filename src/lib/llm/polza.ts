import type { ModelConfig, VendorPricing } from "@config/models";
import { buildResponseSchema, dishAnalysisSchema, type DishAnalysis } from "./schema";
import { buildSystemPrompt, buildUserText } from "./prompt";

/**
 * Клиент polza.ai — OpenAI-совместимый API (§4.1, §9.1 PRD).
 *
 * Ключ живёт только в переменных окружения сервера и никогда не попадает на
 * клиент (§10.2), поэтому модуль импортируется исключительно из route handlers
 * и скриптов.
 *
 * Изображение уходит base64 внутри запроса: это надёжнее signed URL — не
 * зависит ни от доступности Supabase Storage снаружи, ни от срока жизни ссылки
 * (§5.2).
 */

const BASE_URL = process.env.POLZA_BASE_URL ?? "https://polza.ai/api/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.POLZA_TIMEOUT_MS ?? 180_000);

function apiKey(): string {
  const key = process.env.POLZA_API_KEY;
  if (!key) {
    throw new Error(
      "POLZA_API_KEY не задан. Положите ключ в .env.local (локально) и в переменные окружения Vercel.",
    );
  }
  return key;
}

export interface PolzaUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost_rub?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: PolzaUsage;
  [key: string]: unknown;
}

export class PolzaError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "PolzaError";
  }
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw_text: text };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

export interface RecognizeParams {
  model: ModelConfig;
  /** Ровно те байты, которые должны уйти в модель (§5.2). */
  imageBase64: string;
  imageMimeType?: string;
  userHint?: string | null;
  referenceHint?: string | null;
}

export interface RecognizeResult {
  status: "ok" | "failed";
  /** Разобранный ответ по схеме §7.3; null при ошибке. */
  analysis: DishAnalysis | null;
  /** Полный ответ API как есть — пишем в recognitions.raw_response. */
  raw: unknown;
  usage: PolzaUsage | null;
  latencyMs: number;
  errorText: string | null;
  /** Пришлось ли откатиться с json_schema на json_object. */
  usedJsonObjectFallback: boolean;
  /** Была ли повторная попытка (FR-LLM-2). */
  retried: boolean;
}

function buildRequestBody(
  params: RecognizeParams,
  mode: "json_schema" | "json_object",
) {
  const { model } = params;
  const responseFormat =
    mode === "json_schema"
      ? {
          type: "json_schema" as const,
          json_schema: buildResponseSchema(model.promptVersion),
        }
      : { type: "json_object" as const };

  const system = buildSystemPrompt(model.promptVersion);
  const userText = buildUserText(params);

  return {
    model: model.id,
    temperature: model.temperature,
    max_tokens: model.maxTokens,
    response_format: responseFormat,
    messages: [
      {
        role: "system",
        content:
          mode === "json_object"
            ? // При фолбэке схему приходится описывать текстом: сервер её не
              // валидирует, поэтому валидируем ответ zod'ом у себя.
              `${system}\n\nВерни строго один JSON-объект по схеме dish_analysis без markdown-обёртки.`
            : system,
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${params.imageMimeType ?? "image/jpeg"};base64,${params.imageBase64}`,
              detail: model.imageDetail,
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  };
}

function extractContent(json: unknown): string | null {
  const response = json as ChatCompletionResponse | null;
  const content = response?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

/** Модели любят обернуть JSON в ```json … ``` — снимаем обёртку перед разбором. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
}

function looksLikeUnsupportedSchema(status: number, json: unknown): boolean {
  if (status !== 400 && status !== 422 && status !== 501) return false;
  const message = JSON.stringify(json ?? "").toLowerCase();
  return (
    message.includes("response_format") ||
    message.includes("json_schema") ||
    message.includes("structured output") ||
    message.includes("not supported")
  );
}

/**
 * Один вызов модели. Ретрай ровно один и только при 5xx/таймауте: больше —
 * исказит статистику по стоимости (FR-LLM-2). Неудачные попытки всё равно
 * возвращаются наверх, чтобы их записали в recognitions (FR-LLM-3).
 */
export async function recognizeDish(
  params: RecognizeParams,
): Promise<RecognizeResult> {
  const startedAt = Date.now();
  let retried = false;
  let usedJsonObjectFallback = false;
  let mode: "json_schema" | "json_object" = "json_schema";
  let lastRaw: unknown = null;
  let lastUsage: PolzaUsage | null = null;
  let lastError = "Неизвестная ошибка";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let status: number;
    let json: unknown;
    try {
      ({ status, json } = await post(
        "/chat/completions",
        buildRequestBody(params, mode),
      ));
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      lastError = isAbort
        ? `Таймаут ${REQUEST_TIMEOUT_MS} мс`
        : `Сетевая ошибка: ${String(error)}`;
      if (!retried) {
        retried = true;
        continue; // одна повторная попытка при таймауте
      }
      break;
    }

    lastRaw = json;
    const usage = (json as ChatCompletionResponse)?.usage ?? null;
    if (usage) lastUsage = usage;

    if (status >= 500) {
      lastError = `HTTP ${status}: ${JSON.stringify(json).slice(0, 500)}`;
      if (!retried) {
        retried = true;
        continue; // одна повторная попытка при 5xx
      }
      break;
    }

    if (status >= 400) {
      lastError = `HTTP ${status}: ${JSON.stringify(json).slice(0, 500)}`;
      // Модель не умеет strict json_schema — откатываемся на json_object.
      // Это не «ретрай» в смысле FR-LLM-2, а другой формат запроса.
      if (mode === "json_schema" && looksLikeUnsupportedSchema(status, json)) {
        mode = "json_object";
        usedJsonObjectFallback = true;
        continue;
      }
      break;
    }

    const content = extractContent(json);
    if (!content) {
      lastError = "Модель вернула пустой ответ";
      break;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFence(content));
    } catch {
      lastError = `Ответ не является валидным JSON: ${content.slice(0, 300)}`;
      if (mode === "json_schema") {
        mode = "json_object";
        usedJsonObjectFallback = true;
        continue;
      }
      break;
    }

    const validated = dishAnalysisSchema.safeParse(parsedJson);
    if (!validated.success) {
      lastError = `Ответ не соответствует схеме: ${validated.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`;
      break;
    }

    return {
      status: "ok",
      analysis: validated.data,
      raw: json,
      usage,
      latencyMs: Date.now() - startedAt,
      errorText: null,
      usedJsonObjectFallback,
      retried,
    };
  }

  return {
    status: "failed",
    analysis: null,
    raw: lastRaw,
    usage: lastUsage,
    latencyMs: Date.now() - startedAt,
    errorText: lastError,
    usedJsonObjectFallback,
    retried,
  };
}

// ── Стоимость (§9) ──────────────────────────────────────────────────────────

export interface CostBreakdown {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  /** Факт, ₽ — так её отдаёт polza.ai. */
  cost_rub_actual: number | null;
  /** Гипотетически напрямую у вендора, $. NULL, если цена вендора не сверена. */
  cost_direct_usd: number | null;
}

/**
 * Валюты не смешиваем и никуда не конвертируем (§9.2): рубли отвечают на
 * вопрос «сколько мы реально потратили», доллары — «дорогая ли эта модель по
 * мировым меркам». Это две независимые метрики.
 */
export function computeCost(
  usage: PolzaUsage | null,
  pricing: VendorPricing | null,
): CostBreakdown {
  const promptTokens = usage?.prompt_tokens ?? null;
  const completionTokens = usage?.completion_tokens ?? null;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? null;
  const reasoningTokens =
    usage?.completion_tokens_details?.reasoning_tokens ?? null;

  const costRub =
    typeof usage?.cost_rub === "number"
      ? usage.cost_rub
      : typeof usage?.cost === "number"
        ? usage.cost
        : null;

  let costDirectUsd: number | null = null;
  if (pricing && promptTokens !== null && completionTokens !== null) {
    const cached = cachedTokens ?? 0;
    const uncachedPrompt = Math.max(promptTokens - cached, 0);
    costDirectUsd =
      (uncachedPrompt / 1e6) * pricing.promptPerMillion +
      (cached / 1e6) * pricing.cachedPromptPerMillion +
      (completionTokens / 1e6) * pricing.completionPerMillion;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    reasoning_tokens: reasoningTokens,
    cost_rub_actual: costRub,
    cost_direct_usd: costDirectUsd,
  };
}

// ── Каталог моделей ─────────────────────────────────────────────────────────

export interface CatalogPricing {
  /** Каталог отдаёт цены строками; currency — "RUB". */
  prompt_per_million?: string | number;
  completion_per_million?: string | number;
  currency?: string;
}

export interface CatalogModel {
  id: string;
  name?: string;
  architecture?: { input_modalities?: string[] };
  top_provider?: {
    name?: string;
    context_length?: number;
    pricing?: CatalogPricing;
    supported_parameters?: string[];
  };
  [key: string]: unknown;
}

/**
 * §6, FR-COST-3: каталог с ценами polza.ai в рублях.
 *
 * Ответ постраничный: `{data, meta:{page, limit, total, totalPages}}`, по 20
 * записей по умолчанию. Забираем все страницы — иначе половина каталога просто
 * не видна, и сверка конфига объявляет существующие модели несуществующими.
 */
export async function fetchCatalog(params?: {
  inputModalities?: string;
  type?: string;
}): Promise<CatalogModel[]> {
  const collected: CatalogModel[] = [];
  const limit = 100;

  for (let page = 1; page <= 50; page += 1) {
    const query = new URLSearchParams({
      inputModalities: params?.inputModalities ?? "image",
      type: params?.type ?? "chat",
      sortBy: "price",
      sortOrder: "asc",
      page: String(page),
      limit: String(limit),
    });

    const res = await fetch(`${BASE_URL}/models/catalog?${query}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new PolzaError(
        `Каталог моделей недоступен: HTTP ${res.status}`,
        res.status,
        text.slice(0, 500),
      );
    }

    const json = JSON.parse(text);
    const rows: CatalogModel[] = Array.isArray(json)
      ? json
      : (json?.data ?? json?.models ?? []);
    if (!Array.isArray(rows)) {
      throw new PolzaError(
        "Не удалось разобрать ответ каталога моделей",
        res.status,
        json,
      );
    }

    collected.push(...rows);
    const total = json?.meta?.total;
    if (rows.length < limit || (typeof total === "number" && collected.length >= total)) {
      break;
    }
  }

  // Дедуп на случай, если пагинация вернёт пересекающиеся страницы.
  return [...new Map(collected.map((m) => [m.id, m])).values()];
}

/** Цена промпта/ответа в рублях за миллион токенов, если каталог её отдал. */
export function catalogPricing(model: CatalogModel): {
  promptRub: number | null;
  completionRub: number | null;
} {
  const pricing = model.top_provider?.pricing;
  const toNumber = (value: string | number | undefined) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    promptRub: toNumber(pricing?.prompt_per_million),
    completionRub: toNumber(pricing?.completion_per_million),
  };
}
