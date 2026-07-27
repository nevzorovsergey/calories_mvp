import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL } from "@/lib/supabase/env";

/**
 * Proxy (в Next.js ≤15 это называлось middleware).
 *
 * Обновляет cookie-сессию Supabase на каждом запросе и закрывает приложение от
 * неавторизованных: регистрации нет, пользователей заводит владелец руками
 * (FR-AUTH-2), поэтому единственный публичный маршрут — экран входа.
 * Сессия сохраняется между запусками PWA (FR-AUTH-3).
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  // Маршруты /api проверяют авторизацию сами и отвечают JSON-ошибкой 401.
  // Редирект на /login вернул бы им HTML, и fetch на клиенте упал бы на разборе.
  const isPublic = pathname.startsWith("/login") || pathname.startsWith("/api/");

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/today";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Всё, кроме статики и иконок.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|.*\\.(?:png|jpg|jpeg|svg|webp)$).*)",
  ],
};
