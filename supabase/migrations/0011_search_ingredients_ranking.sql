-- ── Поиск по сырью и блюдам вместе: правило запятой и ранжирование ──────────
--
-- После импорта 122 607 блюд Povarenok экран «добавить из справочника»
-- (CatalogAdd ходит с kinds = ['ingredient','dish']) перестал находить сырьё.
-- Замер на живой базе по запросу «куриная грудка» — первые восемь строк:
--
--   0.90 exact [dish] Куриная грудка, запеченная с манго
--   0.90 exact [dish] Куриная грудка, жареная во фритюре
--   0.90 exact [dish] Куриная грудка, томленная в молоке
--   …
--
-- Сырой куриной грудки в выдаче нет вовсе.
--
-- Причина — ярус `head_match` из 0007: «всё до первой запятой равно запросу»
-- даёт 0.9. Правило писалось под USDA, где запятая отделяет уточнения от
-- канонического продукта («Broccoli, cooked, boiled, drained» → «broccoli»), и
-- там оно верное. У Povarenok запятая — обычная пунктуация внутри одного
-- описательного названия: «Куриная грудка, запеченная с манго» — это не
-- «куриная грудка с уточнениями», а целое название блюда. Одно и то же правило
-- на двух источниках означает разное.
--
-- Поэтому head_match по name_ru перестаёт применяться к Povarenok. По name_en
-- он не применялся и так: у этих позиций name_en пустой.
--
-- Второе изменение — ранжирование. Внутри одного скора блюд теперь сотни, и
-- порядок между ними был случайным. Добавлены популярность (миграция 0008) и
-- понижение служебных позиций.
--
-- Для запросов с kinds = ['ingredient'] не меняется НИЧЕГО, и это важно: на них
-- стоит маппинг распознанных ингредиентов, а на нём H1 и H2. Ни одной позиции
-- Povarenok среди сырья нет, у всего сырья popularity_views = 0 и
-- is_service = false, поэтому оба новых ключа сортировки на нём — тождество.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0011

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
  with norm as (
    select lower(regexp_replace(trim(q), '[^\w\s]', '', 'g')) as term
  ),
  exact_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'exact'::text as match_status, 1.0::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = any(kinds)
      and (lower(regexp_replace(i.name_en, '[^\w\s]', '', 'g')) = norm.term
        or lower(regexp_replace(i.name_ru, '[^\w\s]', '', 'g')) = norm.term
        or exists (
          select 1 from ingredient_aliases a
          where a.ingredient_id = i.id
            and lower(regexp_replace(a.alias, '[^\w\s]', '', 'g')) = norm.term
        ))
  ),
  head_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'exact'::text as match_status, 0.9::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = any(kinds)
      and (lower(regexp_replace(split_part(i.name_en, ',', 1), '[^\w\s]', '', 'g')) = norm.term
        or (
          -- Запятая в названии Povarenok не отделяет уточнения, а разделяет
          -- части одной фразы: см. шапку миграции.
          i.source is distinct from 'povarenok'
          and lower(regexp_replace(split_part(i.name_ru, ',', 1), '[^\w\s]', '', 'g')) = norm.term
        ))
  ),
  fuzzy_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'fuzzy'::text as match_status,
           greatest(
             similarity(i.name_en, q),
             similarity(i.name_ru, q),
             coalesce((
               select max(similarity(a.alias, q))
               from ingredient_aliases a
               where a.ingredient_id = i.id and a.alias % q
             ), 0)
           )::numeric as match_score
    from ingredients i
    where i.is_active
      and i.kind = any(kinds)
      and (i.name_en % q or i.name_ru % q
        or exists (
          select 1 from ingredient_aliases a
          where a.ingredient_id = i.id and a.alias % q
        ))
  ),
  ranked as (
    select * from exact_match
    union all
    select * from head_match
    union all
    select * from fuzzy_match
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
           -- Заготовки, соусы и украшения ниже настоящих блюд.
           i.is_service asc,
           -- Расхожее название важнее авторского: у сырья это поле всегда 0,
           -- поэтому на поиске по сырью ключ ничего не меняет.
           i.popularity_views desc,
           (length(b.name_en) - length(replace(b.name_en, ',', ''))) asc,
           length(b.name_ru) asc,
           b.id asc
  limit max_results;
$$;
