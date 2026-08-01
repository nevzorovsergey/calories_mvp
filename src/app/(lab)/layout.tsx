import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/data/meals";
import LabNav from "@/components/lab/LabNav";

/**
 * Оболочка «Лаборатории» (FR-LABX-1).
 *
 * Своя группа маршрутов, а не вложенность в `(app)`: пользовательские экраны
 * живут в мобильной оболочке Konsta шириной с телефон, а здесь смотрят таблицу
 * на 136 тысяч строк и сетку фотографий. Адреса при этом не меняются — группа в
 * скобках в URL не попадает, ссылка из профиля и существующие тесты продолжают
 * работать.
 *
 * Гейт админа тоже здесь, один на весь раздел: пять страниц с копией проверки
 * рано или поздно разошлись бы, и разошлись бы молча.
 */
export const dynamic = "force-dynamic";

export default async function LabLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  if (!profile?.is_admin) {
    return (
      <div className="px-4 pt-4">
        <div className="mx-auto max-w-screen-sm rounded-2xl bg-card p-6 text-center">
          <p className="font-medium">Экран доступен только владельцу</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-screen text-ink md:flex-row">
      <LabNav />
      <main className="min-w-0 flex-1 px-4 py-4 md:h-dvh md:overflow-y-auto md:px-6">
        {children}
      </main>
    </div>
  );
}
