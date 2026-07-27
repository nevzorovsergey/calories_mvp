"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { REFERENCE_PRESETS, type ReferencePreset } from "@config/reference-objects";

/**
 * «Мои эталоны» (§7.5.4, FR-SCALE-4, FR-AUTH-4).
 *
 * Чекбоксы по готовому списку предметов известного размера. Смысл не в
 * настройке ради настройки: зная точный размер, мы (а) сообщаем его модели —
 * «используй, не угадывай», убирая целый класс ошибок, и (б) получаем
 * знаменатель для `scale_size_error`. Пустой реестр допустим — тогда подсказка
 * просто не подставляется.
 */
export default function ReferenceObjectsEditor({
  userId,
  initial,
}: {
  userId: string;
  initial: {
    id: string;
    type: string;
    label: string;
    true_size_mm: number;
    size_axis: string;
  }[];
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [saving, setSaving] = useState<string | null>(null);
  const [rows, setRows] = useState(initial);

  const selectedByLabel = new Map(rows.map((r) => [r.label, r]));

  async function toggle(preset: ReferencePreset) {
    setSaving(preset.key);
    const existing = selectedByLabel.get(preset.label);

    if (existing) {
      await supabase.from("user_reference_objects").delete().eq("id", existing.id);
      setRows((current) => current.filter((r) => r.id !== existing.id));
    } else {
      const { data } = await supabase
        .from("user_reference_objects")
        .insert({
          user_id: userId,
          type: preset.type,
          label: preset.label,
          true_size_mm: preset.trueSizeMm,
          size_axis: preset.sizeAxis,
        })
        .select("id, type, label, true_size_mm, size_axis")
        .single();
      if (data) {
        setRows((current) => [
          ...current,
          {
            id: data.id as string,
            type: data.type as string,
            label: data.label as string,
            true_size_mm: Number(data.true_size_mm),
            size_axis: data.size_axis as string,
          },
        ]);
      }
    }

    setSaving(null);
    router.refresh();
  }

  return (
    <section>
      <h2 className="mb-1 text-section font-semibold">Мои эталоны</h2>
      <p className="mb-3 text-caption text-ink-secondary">
        Отметьте, что у вас есть и что вы обычно кладёте в кадр. Мы сообщим
        модели точные размеры — так она не будет их угадывать, а мы сможем
        измерить, насколько она ошибается.
      </p>

      <ul className="overflow-hidden rounded-2xl bg-card">
        {REFERENCE_PRESETS.map((preset) => {
          const checked = selectedByLabel.has(preset.label);
          return (
            <li key={preset.key} className="border-b border-separator last:border-0">
              <label className="tap-target flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={saving === preset.key}
                  onChange={() => toggle(preset)}
                  className="accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body">{preset.label}</span>
                  <span className="block text-micro text-ink-secondary">
                    {preset.trueSizeMm} мм
                    {preset.reliability === "exact" && " · размер стандартизирован"}
                    {preset.reliability === "model_dependent" && " · зависит от модели"}
                    {preset.reliability === "approximate" && " · приблизительно"}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
