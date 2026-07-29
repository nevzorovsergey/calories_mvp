"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

/**
 * Поиск по справочнику с автодополнением (FR-EDIT-3, FR-EDIT-4).
 *
 * Ходит в RPC `search_ingredients` (миграция 0007): точное совпадение по
 * имени/алиасу, затем триграммы, с фильтром по `kind`. Для `unmatched`-позиций
 * это ещё и механизм
 * самообучения справочника: выбранная пользователем привязка создаёт алиас
 * (FR-CAT-1) — этим занимается вызывающий компонент.
 */

export interface IngredientOption {
  id: number;
  name_ru: string;
  name_en: string;
  category: string | null;
  kind: "ingredient" | "dish";
  match_status: string;
  match_score: number;
}

export default function IngredientSearch({
  autoFocus = false,
  placeholder = "Найти в справочнике",
  initialQuery = "",
  // Только сырьё по умолчанию: здесь чинят привязку распознанного ингредиента, и
  // подсунуть вместо него готовое блюдо FNDDS значит записать в приём пищи не то,
  // что человек ел. Экран добавления по справочнику передаёт оба вида.
  kinds = ["ingredient"],
  onSelect,
}: {
  autoFocus?: boolean;
  placeholder?: string;
  initialQuery?: string;
  kinds?: ("ingredient" | "dish")[];
  onSelect: (option: IngredientOption) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [options, setOptions] = useState<IngredientOption[]>([]);
  const [loading, setLoading] = useState(false);
  const supabase = useMemo(() => createClient(), []);
  const requestId = useRef(0);
  // Массив-проп на каждом рендере новый, и в зависимостях эффекта он крутил бы
  // запрос без конца. Сравниваем по содержимому.
  const kindsKey = kinds.join(",");

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setOptions([]);
      return;
    }

    const current = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.rpc("search_ingredients", {
        q: term,
        max_results: 20,
        kinds: kindsKey.split(","),
      });
      // Ответ на устаревший запрос игнорируем: иначе быстрый набор текста
      // подменяет свежие результаты старыми.
      if (current !== requestId.current) return;
      setLoading(false);
      if (error) {
        console.error(error);
        setOptions([]);
        return;
      }
      setOptions((data ?? []) as IngredientOption[]);
    }, 250);

    return () => clearTimeout(timer);
  }, [query, supabase, kindsKey]);

  return (
    <div>
      <label className="flex items-center gap-2 rounded-xl bg-card px-3">
        <Search size={18} className="shrink-0 text-ink-secondary" aria-hidden />
        <input
          type="search"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="tap-target w-full bg-transparent py-2 text-body outline-none"
        />
      </label>

      {loading && <p className="mt-2 text-caption text-ink-secondary">Ищем…</p>}

      {!loading && query.trim().length >= 2 && options.length === 0 && (
        <p className="mt-2 text-caption text-ink-secondary">
          Ничего не нашли. Попробуйте другое название — например, английское.
        </p>
      )}

      {options.length > 0 && (
        <ul
          aria-label="Результаты поиска"
          className="mt-2 max-h-72 overflow-y-auto rounded-xl bg-card"
        >
          {options.map((option) => (
            <li key={option.id} className="border-b border-separator last:border-0">
              <button
                type="button"
                onClick={() => onSelect(option)}
                className="tap-target w-full px-3 py-2 text-left"
              >
                <span className="block text-body">{option.name_ru}</span>
                <span className="block text-caption text-ink-secondary">
                  {option.name_en}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
