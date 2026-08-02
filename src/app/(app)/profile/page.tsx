import Link from "next/link";
import { redirect } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/data/meals";
import ReferenceObjectsEditor from "@/components/ReferenceObjectsEditor";
import SignOutButton from "@/components/SignOutButton";

/** Профиль: реестр эталонов (§7.5.4, FR-SCALE-4) и вход в «Лабораторию» для админа. */
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);

  const { data: references } = await supabase
    .from("user_reference_objects")
    .select("id, type, label, true_size_mm, size_axis")
    .eq("user_id", user.id)
    .order("created_at");

  return (
    <div className="px-4 pt-4">
      <h1 className="text-title font-semibold">
        {profile?.display_name ?? "Профиль"}
      </h1>
      <p className="mb-6 text-caption text-ink-secondary">{user.email}</p>

      <ReferenceObjectsEditor
        initial={(references ?? []).map((r) => ({
          id: r.id as string,
          type: r.type as string,
          label: r.label as string,
          true_size_mm: Number(r.true_size_mm),
          size_axis: r.size_axis as string,
        }))}
      />

      {profile?.is_admin && (
        <Link
          href="/lab"
          className="mt-6 flex items-center gap-2 rounded-2xl bg-card p-4 text-accent"
        >
          <FlaskConical size={20} />
          Лаборатория: метрики, справочник, разбор по пользователям
        </Link>
      )}

      <div className="mt-6 mb-4">
        <SignOutButton />
      </div>
    </div>
  );
}
