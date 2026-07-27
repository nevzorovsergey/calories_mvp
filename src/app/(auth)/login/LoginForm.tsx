"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Button, Page } from "konsta/react";
import { createClient } from "@/lib/supabase/client";

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

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      // §13.8: сообщение объясняет, что произошло и что делать.
      setError(
        error.message === "Invalid login credentials"
          ? "Неверный email или пароль. Проверьте раскладку и попробуйте ещё раз."
          : `Не удалось войти: ${error.message}`,
      );
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
