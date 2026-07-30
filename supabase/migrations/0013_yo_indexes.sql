-- ── Индексы под сравнение свёрнутой формы (миграция 0012) ───────────────────
--
-- 0012 научила поиск букве «ё», но сравнение идёт по выражению
-- `public.ru_norm(...)`, а индексов под него не было. Замер после 0012: около
-- 2000 мс на запрос вместо прежних сотен миллисекунд — то есть
-- последовательный проход по 130 тысячам строк с вычислением функции на каждой.
--
-- Для матчинга распознанных ингредиентов это неприемлемо вдвойне: он вызывается
-- на каждую позицию блюда, и десять ингредиентов превратились бы в двадцать
-- секунд ожидания.
--
-- btree — под равенство в ярусах exact и head, GIN trgm — под оператор `%` в
-- fuzzy. Отдельный индекс на голову названия нужен потому, что `split_part`
-- внутри ru_norm — это другое выражение, и индекс по целому имени под него не
-- подходит.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0013

create index if not exists ingredients_ru_norm_btree_idx
  on ingredients (public.ru_norm(name_ru));

create index if not exists ingredients_ru_norm_head_btree_idx
  on ingredients (public.ru_norm(split_part(name_ru, ',', 1)));

create index if not exists ingredient_aliases_ru_norm_btree_idx
  on ingredient_aliases (public.ru_norm(alias));

create index if not exists ingredient_aliases_ru_norm_trgm_idx
  on ingredient_aliases using gin (public.ru_norm(alias) gin_trgm_ops);

analyze ingredients;
analyze ingredient_aliases;
