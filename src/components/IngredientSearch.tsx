"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { apiFetch } from "@/lib/api";

/**
 * Поиск по справочнику с автодополнением (FR-EDIT-3, FR-EDIT-4).
 *
 * Под маршрутом `/api/catalog/search` — RPC `search_ingredients` (миграция
 * 0007): точное совпадение по имени/алиасу, затем триграммы, с фильтром по
 * `kind`. Для `unmatched`-позиций это ещё и механизм самообучения справочника:
 * выбранная пользователем привязка создаёт алиас (FR-CAT-1) — этим занимается
 * вызывающий компонент.
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
  // Отдельно от пустого списка: «не нашли» и «не смогли поискать» — разные
  // ответы, и подменять второй первым значит уверенно сообщать неправду о
  // содержимом справочника.
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);
  // Массив-проп на каждом рендере новый, и в зависимостях эффекта он крутил бы
  // запрос без конца. Сравниваем по содержимому.
  const kindsKey = kinds.join(",");

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setOptions([]);
      setFailed(false);
      return;
    }

    const current = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ q: term, kinds: kindsKey, limit: "20" });
      let found: IngredientOption[] = [];
      let broke = false;
      try {
        const response = await apiFetch(`/api/catalog/search?${params}`);
        // Ответ на устаревший запрос игнорируем: иначе быстрый набор текста
        // подменяет свежие результаты старыми.
        if (current !== requestId.current) return;
        if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
        const body = (await response.json()) as { options?: IngredientOption[] };
        found = body.options ?? [];
      } catch (error) {
        if (current !== requestId.current) return;
        console.error(error);
        broke = true;
      }
      setLoading(false);
      setFailed(broke);
      setOptions(found);
    }, 250);

    return () => clearTimeout(timer);
  }, [query, kindsKey]);

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

      {!loading && failed && (
        <p className="mt-2 text-caption text-error" role="alert">
          Не удалось поискать — похоже, пропала связь. Наберите ещё раз.
        </p>
      )}

      {!loading && !failed && query.trim().length >= 2 && options.length === 0 && (
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
