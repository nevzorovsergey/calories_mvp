-- ── Быстрый поиск по сырью ──────────────────────────────────────────────────
--
-- `search_ingredients` — путь маппинга распознанных ингредиентов, он
-- вызывается на каждую позицию блюда. После импорта 122 607 блюд он отвечал за
-- 800–910 мс: блюдо из десяти ингредиентов стоило девять секунд.
--
-- Профиль по ярусам (EXPLAIN ANALYZE, «куриная грудка», холодный кэш):
-- exact 18 мс, head 53 мс, fuzzy 3402 мс. Внутри fuzzy:
--
--   Bitmap Index Scan on ingredients_name_ru_idx … rows=8884
--   Rows Removed by Index Recheck: 8324
--   Rows Removed by Filter: 525        ← отсев по kind, уже после чтения
--   Heap Blocks: exact=4042            ← 4042 страницы ради 35 строк
--
-- Триграммный индекс построен по всей таблице. Сырья 8265 строк, блюд 128 040,
-- поэтому поиск по сырью вычитывает в шестнадцать раз больше мусора, чем
-- полезного, и отбрасывает его фильтром уже потом.
--
-- Лечится частичным индексом по kind. Но его предикат планировщик обязан
-- ДОКАЗАТЬ, а в `search_ingredients` kind сравнивается с параметром-массивом.
-- Проверено два подхода, оба не работают:
--
--   1. Просто создать частичные индексы — время не меняется даже после
--      пересоздания функции (то есть дело не в кэше планов).
--   2. Собирать предикат динамически через EXECUTE. `kind in ('ingredient')`
--      планировщик к равенству не сводит, ускорения нет, а смешанный поиск
--      деградировал с 900 мс до 5 секунд.
--
-- Работает только literal-равенство, поэтому горячий путь вынесен в отдельную
-- функцию с зашитым `kind = 'ingredient'`. Тело — то же, что в 0012, включая
-- свёртку «ё» и ранжирование из 0011.
--
-- `search_ingredients` остаётся как была: по ней ходит экран «добавить из
-- справочника», которому нужны оба вида сразу.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0015

create index if not exists ingredients_name_ru_trgm_ingredient_idx
  on ingredients using gin (name_ru gin_trgm_ops)
  where kind = 'ingredient' and is_active;

create index if not exists ingredients_name_en_trgm_ingredient_idx
  on ingredients using gin (name_en gin_trgm_ops)
  where kind = 'ingredient' and is_active;

create index if not exists ingredients_ru_norm_trgm_ingredient_idx
  on ingredients using gin (public.ru_norm(name_ru) gin_trgm_ops)
  where kind = 'ingredient' and is_active;

analyze ingredients;

create or replace function public.search_raw_ingredients(
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
      and i.kind = 'ingredient'
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
      and i.kind = 'ingredient'
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
      and i.kind = 'ingredient'
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
      and i.kind = 'ingredient'
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
