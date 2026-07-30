-- ── Буква «ё» в поиске по справочнику ───────────────────────────────────────
--
-- В справочнике «мёд», «свёкла», «гречневая» — через «ё», потому что перевод
-- USDA делался грамотно. Пользователь и модели пишут «мед» и «свекла».
-- Триграммы этого не переживают: замерено на живой базе — запрос «Мед» не
-- возвращал НИЧЕГО, «мёд» возвращал позицию 2748. Ровно на этом при сборке
-- словаря Povarenok потерялись «Мед» (8657 упоминаний) и «Кефир».
--
-- Правка откладывалась до сих пор не из осторожности вообще, а по конкретной
-- причине: `search_ingredients` — это путь маппинга распознанных ингредиентов,
-- на котором стоят H1 и H2. Смена правил сравнения сдвигает уже собранные
-- метрики, и делать её вслепую нельзя.
--
-- Поэтому изменение построено так, чтобы быть МОНОТОННЫМ: скор может только
-- вырасти, но не упасть.
--
--   * exact и head сравнивают дополнительно свёрнутую форму — это добавляет
--     совпадения, но ни одного не убирает: старое условие осталось через OR;
--   * fuzzy берёт greatest() от сходства по сырому тексту и по свёрнутому,
--     то есть прежний скор — нижняя граница нового.
--
-- Следствие, которое надо знать: множество найденных позиций может только
-- расшириться, но ПОРЯДОК внутри выдачи измениться может — чей-то скор вырос
-- сильнее. Замер до и после приложен к тикету.
--
-- Свёртка — `public.ru_norm` из миграции 0008, под неё уже есть триграммный
-- индекс `ingredients_name_ru_norm_trgm_idx`, иначе `%` по выражению шёл бы
-- последовательным сканом по 130 тысячам строк.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0012

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
    select lower(regexp_replace(trim(q), '[^\w\s]', '', 'g')) as term,
           public.ru_norm(q) as folded
  ),
  exact_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'exact'::text as match_status, 1.0::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = any(kinds)
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
      and i.kind = any(kinds)
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
  fuzzy_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'fuzzy'::text as match_status,
           greatest(
             similarity(i.name_en, q),
             similarity(i.name_ru, q),
             -- Нижняя граница нового скора — прежний: greatest никогда не
             -- уменьшает результат.
             similarity(public.ru_norm(i.name_ru), public.ru_norm(q)),
             coalesce((
               select max(greatest(similarity(a.alias, q),
                                   similarity(public.ru_norm(a.alias), public.ru_norm(q))))
               from ingredient_aliases a
               where a.ingredient_id = i.id
                 and (a.alias % q or public.ru_norm(a.alias) % public.ru_norm(q))
             ), 0)
           )::numeric as match_score
    from ingredients i
    where i.is_active
      and i.kind = any(kinds)
      and (i.name_en % q or i.name_ru % q
        or public.ru_norm(i.name_ru) % public.ru_norm(q)
        or exists (
          select 1 from ingredient_aliases a
          where a.ingredient_id = i.id
            and (a.alias % q or public.ru_norm(a.alias) % public.ru_norm(q))
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
           i.is_service asc,
           i.popularity_views desc,
           (length(b.name_en) - length(replace(b.name_en, ',', ''))) asc,
           length(b.name_ru) asc,
           b.id asc
  limit max_results;
$$;
