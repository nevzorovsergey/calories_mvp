"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import type { CatalogAlias } from "@/lib/data/lab-catalog";

/**
 * Синонимы позиции (FR-LABX-4).
 *
 * Источник у каждой строки виден намеренно: `import` пришёл из дампа,
 * `user_mapping` — след привязки unmatched-позиции живым человеком (FR-CAT-1),
 * `admin` дописан здесь. Удалять чужой след, не понимая, откуда он, — верный
 * способ сломать маппинг, который уже работал.
 */

const SOURCE_RU: Record<string, string> = {
  import: "из дампа",
  user_mapping: "привязка пользователем",
  admin: "добавлен вручную",
};

export default function AliasEditor({
  ingredientId,
  aliases,
}: {
  ingredientId: number;
  aliases: CatalogAlias[];
}) {
  const router = useRouter();
  const [alias, setAlias] = useState("");
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (alias.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/lab/catalog/${ingredientId}/aliases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: alias.trim(), lang }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Ошибка ${response.status}`);
      setAlias("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(aliasId: number) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/lab/catalog/${ingredientId}/aliases?alias_id=${aliasId}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Ошибка ${response.status}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-card p-4">
      <h2 className="mb-3 text-caption text-ink-secondary uppercase">
        Синонимы ({aliases.length})
      </h2>

      {aliases.length === 0 ? (
        <p className="mb-3 text-caption text-ink-secondary">
          Синонимов нет — позиция находится только по своему названию.
        </p>
      ) : (
        <ul className="mb-3 divide-y divide-separator">
          {aliases.map((row) => (
            <li key={row.id} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-body">{row.alias}</span>
              <span className="shrink-0 text-micro text-ink-secondary">
                {row.lang} · {SOURCE_RU[row.source] ?? row.source}
              </span>
              <button
                type="button"
                onClick={() => remove(row.id)}
                disabled={busy}
                aria-label={`Удалить синоним «${row.alias}»`}
                className="tap-target shrink-0 rounded-lg px-2 py-1 text-ink-secondary hover:text-error disabled:opacity-40"
              >
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="новый синоним"
          className="tap-target min-w-40 grow rounded-xl bg-screen px-3 py-2 text-body"
        />
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as "ru" | "en")}
          aria-label="Язык синонима"
          className="tap-target rounded-xl bg-screen px-3 py-2 text-body"
        >
          <option value="ru">ru</option>
          <option value="en">en</option>
        </select>
        <button
          type="button"
          onClick={add}
          disabled={busy || alias.trim() === ""}
          className="tap-target inline-flex items-center rounded-xl bg-accent px-4 py-2 text-white disabled:opacity-40"
        >
          Добавить
        </button>
      </div>

      {error && (
        <p className="mt-2 text-caption text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
