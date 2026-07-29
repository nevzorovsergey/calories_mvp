import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/data/meals";
import { localDateIso } from "@/lib/format";
import BackLink from "@/components/BackLink";
import CatalogAdd from "@/components/CatalogAdd";

/**
 * Добавление приёма пищи по справочнику, без фотографии.
 *
 * Дата приходит параметром с экрана «Сегодня»: человек может листать дни назад и
 * дописывать вчерашний ужин, и приём пищи должен лечь в тот день, который он
 * видит, а не в сегодняшний.
 */
export const dynamic = "force-dynamic";

export default async function AddPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date: dateParam } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  const date = dateParam ?? localDateIso(profile?.timezone);

  return (
    <div className="px-4 pt-4">
      <header className="mb-3">
        <BackLink href={`/today?date=${date}`} label="Сегодня" />
      </header>
      <h1 className="mb-4 text-section font-semibold">Добавить по справочнику</h1>
      <CatalogAdd mealDate={date} />
    </div>
  );
}
