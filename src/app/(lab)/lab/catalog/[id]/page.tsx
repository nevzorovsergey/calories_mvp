import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  KIND_RU,
  NUTRIENT_GROUP_RU,
  PORTION_LEVEL_RU,
  SOURCE_RU,
  STATE_RU,
  loadCatalogItem,
} from "@/lib/data/lab-catalog";
import { formatNumber } from "@/lib/format";
import CatalogItemEditor from "@/components/lab/CatalogItemEditor";
import AliasEditor from "@/components/lab/AliasEditor";

/**
 * Карточка позиции справочника (FR-LABX-3).
 *
 * Три блока, каждый отвечает на свой вопрос: что это (происхождение и
 * нутриенты), во что превращается при съедании (порции и раскладка) и где
 * реально всплывало (использование). Последний блок и есть причина, по которой
 * карточка нужна: понять, почему модель сматчилась именно сюда, можно только
 * увидев, сколько раз она уже это делала и с каким статусом.
 */
export const dynamic = "force-dynamic";

export default async function CatalogItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) notFound();

  const supabase = await createClient();
  const item = await loadCatalogItem(supabase, numericId);
  if (!item) notFound();

  const groups = [...new Set(item.nutrients.map((n) => n.group_code))];
  const componentsSum = item.components.reduce((sum, c) => sum + c.share, 0);

  return (
    <div className="max-w-5xl">
      <Link href="/lab/catalog" className="text-caption text-accent">
        ← Справочник
      </Link>

      <h1 className="mt-2 text-title font-semibold">{item.name_ru}</h1>
      <p className="mb-1 text-body text-ink-secondary">{item.name_en}</p>
      <p className="mb-6 text-caption text-ink-secondary">
        #{item.id} · {KIND_RU[item.kind] ?? item.kind} ·{" "}
        {SOURCE_RU[item.source] ?? item.source}
        {item.source_id && ` · ${item.source_id}`}
        {!item.is_active && <span className="text-error"> · выключена</span>}
        {item.is_service && <span className="text-warning"> · служебная</span>}
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-card p-4">
          <h2 className="mb-3 text-caption text-ink-secondary uppercase">Происхождение</h2>
          <dl className="text-caption">
            <Row label="Источник" value={SOURCE_RU[item.source] ?? item.source} />
            <Row label="Идентификатор источника" value={item.source_id ?? "—"} />
            <Row
              label="Состояние"
              value={item.state ? (STATE_RU[item.state] ?? item.state) : "—"}
            />
            <Row label="Категория" value={item.category ?? "—"} />
            {item.source === "povarenok" && (
              <>
                <Row
                  label="Просмотров рецептов"
                  value={formatNumber(item.popularity_views, 0)}
                />
                <Row label="Рецептов свёрнуто" value={String(item.source_recipes)} />
              </>
            )}
            {item.portion_source_level !== null && (
              <Row
                label="Откуда типовой вес порции"
                value={
                  PORTION_LEVEL_RU[item.portion_source_level] ??
                  `уровень ${item.portion_source_level}`
                }
              />
            )}
            <Row
              label="Плотность, г/мл"
              value={
                item.density_g_per_ml === null
                  ? "—"
                  : formatNumber(Number(item.density_g_per_ml), 2)
              }
            />
          </dl>
        </div>

        <div className="rounded-2xl bg-card p-4">
          <h2 className="mb-3 text-caption text-ink-secondary uppercase">Использование</h2>
          <dl className="text-caption">
            <Row label="Позиций в приёмах пищи" value={String(item.usage.mealItems)} />
            <Row
              label="Предложений модели"
              value={String(item.usage.recognitionItems)}
            />
            {item.usage.byMatchStatus.map((s) => (
              <Row
                key={s.status}
                label={`— из них ${s.status}`}
                value={String(s.n)}
              />
            ))}
            <Row
              label="В кандидатах блюда"
              value={String(item.usage.dishCandidates)}
            />
            <Row
              label="Выбрано человеком как блюдо"
              value={String(item.usage.selectedAsDish)}
            />
          </dl>
          {item.usage.mealItems > 0 && item.nutrients.length === 0 && (
            <p className="mt-3 text-caption text-warning">
              Позиция уже попадала в еду, но нутриентов у неё нет — калорийность
              таких приёмов пищи считается только по снимку модели.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <CatalogItemEditor
          id={item.id}
          initial={{
            name_ru: item.name_ru,
            category: item.category,
            is_active: item.is_active,
            is_service: item.is_service,
          }}
        />
        <AliasEditor ingredientId={item.id} aliases={item.aliases} />
      </div>

      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
        Нутриенты на 100 г ({item.nutrients.length})
      </h2>
      {item.nutrients.length === 0 ? (
        <p className="rounded-2xl bg-card p-4 text-caption text-ink-secondary">
          Нутриентов нет. Такая позиция вносит вклад только в макронутриенты — и
          только если модель их сама оценила.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {groups.map((group) => (
            <div key={group} className="rounded-2xl bg-card p-4">
              <h3 className="mb-2 text-caption text-ink-secondary">
                {NUTRIENT_GROUP_RU[group] ?? group}
              </h3>
              <dl className="text-caption">
                {item.nutrients
                  .filter((n) => n.group_code === group)
                  .map((n) => (
                    <Row
                      key={n.code}
                      label={n.name_ru}
                      value={`${formatNumber(n.amount_per_100g, 2)} ${n.unit}`}
                    />
                  ))}
              </dl>
            </div>
          ))}
        </div>
      )}

      {item.portions.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
            Порции ({item.portions.length})
          </h2>
          <ul className="overflow-hidden rounded-2xl bg-card">
            {item.portions.map((portion) => (
              <li
                key={portion.seq}
                className="flex items-baseline justify-between border-b border-separator px-3 py-2 text-caption last:border-0"
              >
                <span className="min-w-0 flex-1">
                  {portion.label_ru ?? portion.label_en}
                  {portion.label_ru && (
                    <span className="ml-2 text-micro text-ink-secondary">
                      {portion.label_en}
                    </span>
                  )}
                  {portion.is_default && (
                    <span className="ml-2 text-micro text-accent">по умолчанию</span>
                  )}
                </span>
                <span className="tnum ml-2">
                  {formatNumber(portion.gram_weight, 0)} г
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {item.components.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
            Раскладка ({item.components.length})
          </h2>
          <ul className="overflow-hidden rounded-2xl bg-card">
            {item.components.map((component) => (
              <li
                key={component.seq}
                className="flex items-baseline justify-between border-b border-separator px-3 py-2 text-caption last:border-0"
              >
                <span className="min-w-0 flex-1 truncate">
                  {component.ingredient_id ? (
                    <Link
                      href={`/lab/catalog/${component.ingredient_id}`}
                      className="text-accent"
                    >
                      {component.name}
                    </Link>
                  ) : (
                    <>
                      {component.name}
                      <span
                        className="ml-1 text-warning"
                        title="Код компонента не резолвится в справочник"
                      >
                        ≈
                      </span>
                    </>
                  )}
                </span>
                <span className="tnum ml-2 text-ink-secondary">
                  {formatNumber(component.share * 100, 1)}%
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 mb-6 text-micro text-ink-secondary">
            Сумма долей {formatNumber(componentsSum * 100, 1)}%. Отклонение от ста
            означает компоненты, не сматченные в справочник, — их доля посчитана,
            но КБЖУ взять неоткуда.
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-separator py-1 last:border-0">
      <dt className="min-w-0 text-ink-secondary">{label}</dt>
      <dd className="tnum shrink-0 text-right">{value}</dd>
    </div>
  );
}
