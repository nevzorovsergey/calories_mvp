"use client";

import { useRouter } from "next/navigation";
import { Button } from "konsta/react";
import { apiPost } from "@/lib/api";

export default function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    // Отказ здесь не останавливает выход: сессию гасит сам маршрут, а если он
    // не ответил, увести человека на /login всё равно честнее, чем оставить
    // его на экране профиля с ощущением, что кнопка сломана. Не вышло —
    // покажет proxy, вернув обратно.
    try {
      await apiPost("/api/auth/logout", {});
    } catch (error) {
      console.error(error);
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <Button clear className="text-error" onClick={signOut}>
      Выйти
    </Button>
  );
}
