"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Button, Page } from "konsta/react";

/**
 * Сколько раз пробуем войти, прежде чем показать ошибку.
 *
 * Повтор открывает новое соединение, а зависание — это состояние конкретного
 * соединения, а не сервера. Второй попытки хватает, дальше честнее показать
 * ошибку, чем молча держать человека в ожидании.
 */
const SIGN_IN_ATTEMPTS = 2;

/**
 * Потолок на попытку. До Vercel канал быстрый, так что пять секунд здесь — это
 * уже «не приедет», а не «медленно»; на сломанном канале до Supabase пришлось
 * закладывать вдвое больше.
 */
const ATTEMPT_TIMEOUT_MS = 5_000;

const NETWORK_MESSAGE =
  "Сеть не ответила. Проверьте соединение и нажмите «Войти» ещё раз.";

/** Итог попытки: либо вошли, либо есть что показать человеку. */
type Attempt =
  | { ok: true }
  | { ok: false; message: string; retryable: boolean };

async function attemptSignIn(email: string, password: string): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  } catch {
    // Сюда попадают и обрыв по потолку, и офлайн — для человека это одно и то
    // же: ответа нет, надо повторить.
    return { ok: false, message: NETWORK_MESSAGE, retryable: true };
  }

  if (response.ok) return { ok: true };

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    retryable?: boolean;
  };

  // §13.8: сообщение объясняет, что произошло и что делать дальше.
  if (body.retryable) {
    return { ok: false, message: NETWORK_MESSAGE, retryable: true };
  }
  if (body.error === "Invalid login credentials") {
    return {
      ok: false,
      message: "Неверный email или пароль. Проверьте раскладку и попробуйте ещё раз.",
      retryable: false,
    };
  }
  return {
    ok: false,
    message: `Не удалось войти: ${body.error ?? "сервер ответил ошибкой"}`,
    retryable: false,
  };
}

/**
 * Вход (§11.1). Email + пароль, больше ничего: регистрации нет, восстановления
 * пароля нет, пользователей заводит владелец через дашборд Supabase (FR-AUTH-2).
 */
export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    let result: Attempt = { ok: true };
    for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
      result = await attemptSignIn(email, password);
      // Повторяем только молчание сети: неверный пароль второй попыткой не
      // исправить, а лишний запрос выглядел бы как подбор.
      if (result.ok || !result.retryable) break;
    }

    if (!result.ok) {
      setError(result.message);
      setPending(false);
      return;
    }

    router.replace(searchParams.get("next") || "/today");
    router.refresh();
  }

  return (
    <App theme="ios" safeAreas className="min-h-dvh bg-screen text-ink">
      <Page className="mx-auto max-w-screen-sm">
        {/* Настоящий h1, а не BlockTitle: тот рисует div, и экран остаётся
            без заголовка для скринридера и для навигации по заголовкам. */}
        <h1 className="px-4 pt-6 pb-2 text-title font-semibold">Что я ем</h1>
        <p className="px-4 pb-4 text-ink-secondary">
          Прототип распознавания состава блюда по фотографии. Вход по учётной
          записи, которую завёл владелец.
        </p>

        {/* Поля намеренно обычные, а не konsta/ListInput: тот падает с
            «Cannot read properties of null (reading constructor)» —
            внутри Konsta передаёт null в свой сборщик классов. Вёрстка здесь
            повторяет сгруппированный список iOS теми же токенами (§13). */}
        <form onSubmit={handleSubmit} className="px-4">
          <div className="overflow-hidden rounded-2xl bg-card">
            <label className="block border-b border-separator px-3 py-2">
              <span className="block text-caption text-ink-secondary">Email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="tap-target w-full bg-transparent text-body outline-none"
              />
            </label>
            <label className="block px-3 py-2">
              <span className="block text-caption text-ink-secondary">Пароль</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="tap-target w-full bg-transparent text-body outline-none"
              />
            </label>
          </div>

          {error && (
            <p className="pt-3 text-error" role="alert">
              {error}
            </p>
          )}

          <div className="pt-4">
            <Button type="submit" large disabled={pending} className="tap-target">
              {pending ? "Входим…" : "Войти"}
            </Button>
          </div>
        </form>
      </Page>
    </App>
  );
}
