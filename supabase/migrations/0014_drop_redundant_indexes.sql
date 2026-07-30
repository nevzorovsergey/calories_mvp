-- ── Уборка индексов, созданных по ошибке ────────────────────────────────────
--
-- Разбирая, почему `search_ingredients` отвечает за 800 мс после импорта
-- 122 607 блюд, я добавил несколько индексов. Ни один не помог, и часть из них
-- оказалась дубликатами уже существующих. Эта миграция их убирает — индекс на
-- таблице в 138 тысяч строк стоит места и замедляет запись, а мёртвый индекс не
-- стоит ничего, кроме этого.
--
-- 1. Дубликаты. Индексы под выражения ярусов `exact` и `head` были созданы ещё
--    в 0005 — там же стоит предупреждение «выражения обязаны посимвольно
--    совпадать». Я его не прочитал и создал те же четыре плюс один по алиасам
--    заново, под другими именами. Удаляются мои, остаются исходные.
--
-- 2. Частичные и составной триграммные индексы по `kind`. Идея была верной:
--    EXPLAIN показывает 15.9 мс вместо 363, потому что триграммный индекс по
--    всей таблице достаёт тысячи похожих НАЗВАНИЙ БЛЮД и отбрасывает их уже
--    после чтения с диска. Но внутри функции `kinds` — параметр, а не литерал,
--    и планировщик не может доказать условие частичного индекса. Замер
--    подтвердил: латентность функции не изменилась.
--
--    Чтобы это заработало, функцию надо переписать с ветвлением по частому
--    случаю `kinds = array['ingredient']` — тогда предикат станет доказуемым.
--    Это отдельная работа с отдельным замером, и делать её заодно нельзя.
--
-- Что остаётся: индексы из 0013 — они нужны сравнению свёрнутой формы из 0012
-- и без них «ё» стоила бы секунды.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0014

drop index if exists ingredients_name_ru_norm_eq_idx;
drop index if exists ingredients_name_en_norm_eq_idx;
drop index if exists ingredients_name_ru_head_eq_idx;
drop index if exists ingredients_name_en_head_eq_idx;
drop index if exists ingredient_aliases_norm_eq_idx;

drop index if exists ingredients_name_ru_trgm_ingredient_idx;
drop index if exists ingredients_name_ru_trgm_dish_idx;
drop index if exists ingredients_name_en_trgm_ingredient_idx;
drop index if exists ingredients_ru_norm_trgm_ingredient_idx;
drop index if exists ingredients_kind_name_ru_trgm_idx;

analyze ingredients;
analyze ingredient_aliases;
