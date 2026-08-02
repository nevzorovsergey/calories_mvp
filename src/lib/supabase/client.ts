import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL } from "./env";

/**
 * Потолок на один запрос к Supabase из браузера.
 *
 * Канал до us-east-2 иногда встаёт наглухо: TLS-хендшейк проходит, а ответа нет
 * ни через двадцать секунд, ни вообще — соединение при этом не отваливается по
 * ошибке. Свой потолок нужен потому, что fetch внутри supabase-js в такой
 * ситуации ждёт бесконечно, и экран навсегда остаётся в состоянии «запрос
 * идёт»: ни ответа, ни ошибки, ни способа узнать, что ждать уже нечего.
 *
 * Успешный ответ с этого канала укладывается в доли секунды, так что десять
 * секунд отделяют «медленно» от «уже не приедет» с большим запасом.
 */
const REQUEST_TIMEOUT_MS = 10_000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    // Свой signal подмешиваем, а не подменяем: supabase-js передаёт
    // собственный, когда сам отменяет запрос, и потерять его значит оставить
    // висеть уже отменённый вызов.
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
}

/**
 * Клиент Supabase для браузера (логин, поиск по справочнику, привязка алиасов).
 *
 * Обрыв по потолку приходит в вызывающий код как `AuthRetryableFetchError`
 * (`isAuthRetryableFetchError`) для авторизации и как отказ промиса для
 * остальных запросов.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    global: { fetch: fetchWithTimeout },
  });
}
