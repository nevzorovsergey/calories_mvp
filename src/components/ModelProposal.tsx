"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/format";

/**
 * Блок «Что предложила модель» (FR-DET-3).
 *
 * Сворачиваемый: показывает исходную версию с подсветкой отличий от
 * пользовательской — изменённый вес, удалённые и добавленные позиции.
 * Плюс диагностика масштабной цепочки (§7.5.2): согласованность чисел —
 * измеримая характеристика модели, и смотреть на неё удобнее всего рядом с
 * самим ответом.
 */

interface ModelItem {
  id: string;
  name_ru: string;
  weight_g: number;
  visible: boolean;
  match_status: string;
}

interface UserItem {
  source_item_id: string | null;
  name_ru: string;
  weight_g: number;
  origin: string;
}

const SCALE_MODE_RU: Record<string, string> = {
  reference: "по эталонному объекту",
  container: "по типовому размеру посуды",
  prior: "по общему представлению о порции",
};

const FLAG_RU: Record<string, string> = {
  scale_mismatch: "масштаб не сходится с якорем",
  volume_mismatch: "объём не сходится с размерами пятна еды",
  mass_mismatch: "масса не сходится с объёмом и плотностью",
  anchor_incomplete: "режим «по эталону», но чисел якоря нет",
};

export default function ModelProposal({
  recognition,
  modelItems,
  userItems,
}: {
  recognition: {
    model_label: string;
    prompt_version: string;
    total_weight_g: number;
    scale_mode: string | null;
    scale_size_error: number | null;
    scale_chain: Record<string, unknown> | null;
    latency_ms: number | null;
  };
  modelItems: ModelItem[];
  userItems: UserItem[];
}) {
  const [open, setOpen] = useState(false);

  const userBySource = new Map(
    userItems
      .filter((i) => i.source_item_id)
      .map((i) => [i.source_item_id as string, i]),
  );
  const addedByUser = userItems.filter((i) => !i.source_item_id);
  const flags = (recognition.scale_chain?.consistency_flags ?? []) as string[];

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tap-target flex w-full items-center gap-1 text-caption text-accent uppercase"
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Что предложила модель
      </button>

      {open && (
        <div className="mt-2 rounded-2xl bg-card p-4">
          <p className="mb-3 text-caption text-ink-secondary">
            {recognition.model_label} · промпт {recognition.prompt_version} ·{" "}
            {formatNumber(recognition.total_weight_g, 0)} г
            {recognition.latency_ms !== null &&
              ` · ${Math.round(recognition.latency_ms / 100) / 10} с`}
          </p>

          <ul className="mb-3 divide-y divide-separator">
            {modelItems.map((item) => {
              const user = userBySource.get(item.id);
              const removed = !user;
              const changed =
                user && Math.abs(user.weight_g - item.weight_g) > 0.001;

              return (
                <li key={item.id} className="flex justify-between py-1 text-caption">
                  <span
                    className={`min-w-0 flex-1 truncate ${removed ? "text-ink-secondary line-through" : ""}`}
                  >
                    {item.name_ru}
                    {!item.visible && (
                      <span className="ml-1 text-micro text-ink-secondary">
                        (выведено логически)
                      </span>
                    )}
                    {item.match_status === "unmatched" && (
                      <span className="ml-1 text-warning" title="Нет в справочнике">
                        ≈
                      </span>
                    )}
                  </span>
                  <span className="tnum ml-2 shrink-0">
                    {formatNumber(item.weight_g, 0)} г
                    {changed && (
                      <span className="ml-1 font-semibold text-ink">
                        → {formatNumber(user!.weight_g, 0)}
                      </span>
                    )}
                    {removed && (
                      <span className="ml-1 text-micro text-error">удалено</span>
                    )}
                  </span>
                </li>
              );
            })}

            {addedByUser.map((item, index) => (
              <li
                key={`added-${index}`}
                className="flex justify-between py-1 text-caption text-success"
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.name_ru} <span className="text-micro">добавлено вами</span>
                </span>
                <span className="tnum ml-2">{formatNumber(item.weight_g, 0)} г</span>
              </li>
            ))}
          </ul>

          <dl className="text-micro text-ink-secondary">
            {recognition.scale_mode && (
              <div className="flex justify-between py-0.5">
                <dt>Масштаб</dt>
                <dd>
                  {SCALE_MODE_RU[recognition.scale_mode] ?? recognition.scale_mode}
                </dd>
              </div>
            )}
            {recognition.scale_size_error !== null && (
              <div className="flex justify-between py-0.5">
                <dt>Ошибка в размере эталона</dt>
                <dd className="tnum">
                  {Math.round(recognition.scale_size_error * 100)}%
                </dd>
              </div>
            )}
            <div className="flex justify-between py-0.5">
              <dt>Согласованность цепочки</dt>
              <dd className={flags.length > 0 ? "text-warning" : "text-success"}>
                {flags.length === 0
                  ? "числа сходятся"
                  : flags.map((f) => FLAG_RU[f] ?? f).join("; ")}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
