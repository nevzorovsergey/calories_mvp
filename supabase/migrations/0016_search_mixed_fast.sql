-- ── Смешанный поиск: две ветки с литеральным kind ───────────────────────────
--
-- Экран «добавить из справочника» (CatalogAdd) ищет сразу по сырью и по блюдам.
-- Замер на живой базе показал 5.3–5.6 СЕКУНДЫ на любой запрос, а на коротких
-- («щи») — `canceling statement due to statement timeout`. Компонент подсказок
-- на ошибку чистит список, и для пользователя это выглядит как «ничего не
-- найдено»: «щи вал» не находит ничего, а «щи валл» находит, потому что второй
-- запрос случайно уложился в таймаут.
--
-- Причина та же, что в 0015: под предикат `kind = any(kinds)` частичные индексы
-- недоказуемы, а `exists` по синонимам внутри OR не даёт сложить триграммные
-- условия в bitmap. Только теперь перебирается не 8 тысяч строк сырья, а все
-- 136 тысяч.
--
-- Решение: обе ветки считаются функциями с ЗАШИТЫМ видом
-- (`search_raw_ingredients` из 0015 и `search_catalog_dishes` здесь), а
-- `search_ingredients` объединяет их и отфильтровывает лишнее по `kinds` уже
-- после. Ветка, которая не нужна вызывающему, всё равно выполняется — но она
-- стоит десятки миллисекунд против пяти секунд, и это несопоставимо.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0016

create index if not exists ingredients_name_ru_trgm_dish_idx
  on ingredients using gin (name_ru gin_trgm_ops)
  where kind = 'dish' and is_active;

create index if not exists ingredients_ru_norm_trgm_dish_idx
  on ingredients using gin (public.ru_norm(name_ru) gin_trgm_ops)
  where kind = 'dish' and is_active;

analyze ingredients;

create or replace function public.search_catalog_dishes(
  q text,
  max_results int default 20
)
returns table (
  id int,
  name_ru text,
  name_en text,
  category text,
  kind text,
  match_status text,
  match_score numeric
)
language sql
stable
as $$
  with norm as (
    select lower(regexp_replace(trim(q), '[^\w\s]', '', 'g')) as term,
           public.ru_norm(q) as folded
  ),
  exact_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'exact'::text as match_status, 1.0::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = 'dish'
      and (lower(regexp_replace(i.name_en, '[^\w\s]', '', 'g')) = norm.term
        or lower(regexp_replace(i.name_ru, '[^\w\s]', '', 'g')) = norm.term
        -- Добавка про «ё»: старые условия выше остаются как были.
        or public.ru_norm(i.name_ru) = norm.folded
        or exists (
          select 1 from ingredient_aliases a
          where a.ingredient_id = i.id
            and (lower(regexp_replace(a.alias, '[^\w\s]', '', 'g')) = norm.term
              or public.ru_norm(a.alias) = norm.folded)
        ))
  ),
  head_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'exact'::text as match_status, 0.9::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = 'dish'
      and (lower(regexp_replace(split_part(i.name_en, ',', 1), '[^\w\s]', '', 'g')) = norm.term
        or (
          -- Запятая у Povarenok — пунктуация, а не разделитель уточнений
          -- (миграция 0011).
          i.source is distinct from 'povarenok'
          and (
            lower(regexp_replace(split_part(i.name_ru, ',', 1), '[^\w\s]', '', 'g')) = norm.term
            or public.ru_norm(split_part(i.name_ru, ',', 1)) = norm.folded
          )
        ))
  ),
  -- Совпадение по названию и совпадение по синониму — ДВЕ ветки, а не одно
  -- условие через OR, и это не стилистика.
  --
  -- Пока `exists (select … from ingredient_aliases …)` стоял внутри цепочки OR
  -- вместе с триграммными операторами, планировщик не мог объединить их в
  -- bitmap: подзапрос в bitmap-скан не складывается. Он выбирал обход по
  -- индексу `kind` и считал similarity фильтром НА КАЖДОЙ строке сырья:
  --
  --   Index Scan using ingredients_kind_active_idx … rows=87
  --   Rows Removed by Filter: 8008
  --   Execution Time: 418 ms
  --
  -- То есть триграммные индексы не использовались вообще. Разложенные по
  -- ветвям union, оба условия снова становятся индексными.
  fuzzy_by_name as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'fuzzy'::text as match_status,
           greatest(
             similarity(i.name_en, q),
             similarity(i.name_ru, q),
             similarity(public.ru_norm(i.name_ru), public.ru_norm(q))
           )::numeric as match_score
    from ingredients i
    where i.is_active
      and i.kind = 'dish'
      and (i.name_en % q
        or i.name_ru % q
        or public.ru_norm(i.name_ru) % public.ru_norm(q))
  ),
  fuzzy_by_alias as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'fuzzy'::text as match_status,
           max(greatest(
             similarity(a.alias, q),
             similarity(public.ru_norm(a.alias), public.ru_norm(q))
           ))::numeric as match_score
    from ingredient_aliases a
    join ingredients i on i.id = a.ingredient_id
    where i.is_active
      and i.kind = 'dish'
      and (a.alias % q or public.ru_norm(a.alias) % public.ru_norm(q))
    group by i.id, i.name_ru, i.name_en, i.category, i.kind
  ),
  ranked as (
    select * from exact_match
    union all
    select * from head_match
    union all
    select * from fuzzy_by_name
    union all
    select * from fuzzy_by_alias
  ),
  best as (
    select distinct on (r.id) r.*
    from ranked r
    order by r.id, r.match_score desc, (r.match_status = 'exact') desc
  )
  select b.id, b.name_ru, b.name_en, b.category, b.kind, b.match_status, b.match_score
  from best b
  join ingredients i on i.id = b.id
  order by b.match_score desc,
           i.is_service asc,
           i.popularity_views desc,
           (length(b.name_en) - length(replace(b.name_en, ',', ''))) asc,
           length(b.name_ru) asc,
           b.id asc
  limit max_results;
$$;

create or replace function public.search_ingredients(
  q text,
  max_results int default 20,
  kinds text[] default array['ingredient']
)
returns table (
  id int,
  name_ru text,
  name_en text,
  category text,
  kind text,
  match_status text,
  match_score numeric
)
language sql
stable
as $$
  with combined as (
    select * from public.search_raw_ingredients(q, max_results)
    union all
    select * from public.search_catalog_dishes(q, max_results)
  )
  select b.id, b.name_ru, b.name_en, b.category, b.kind, b.match_status, b.match_score
  from combined b
  join ingredients i on i.id = b.id
  where b.kind = any(kinds)
  order by b.match_score desc,
           i.is_service asc,
           i.popularity_views desc,
           (length(b.name_en) - length(replace(b.name_en, ',', ''))) asc,
           length(b.name_ru) asc,
           b.id asc
  limit max_results;
$$;
