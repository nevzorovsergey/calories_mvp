import { Suspense } from "react";
import LoginForm from "./LoginForm";

/**
 * Экран входа (§11.1). Форма — клиентская (ей нужен ?next= из адресной строки),
 * поэтому оборачиваем в Suspense: без него сборка не может отрендерить страницу
 * статически.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center">Загрузка…</div>}>
      <LoginForm />
    </Suspense>
  );
}
