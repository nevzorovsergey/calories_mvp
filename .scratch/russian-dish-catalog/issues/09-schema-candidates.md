# 09. Схема БД: кандидаты и выбор пользователя

Status: ready-for-human
Blocked by: 05

Ключевой продуктовый принцип не меняется (§1.3 PRD): предложение модели и версия
пользователя сохраняются обе и никогда не перезаписывают друг друга. Меняется
только то, что предложение теперь — три названия, а не список ингредиентов.

## Миграция 0009

```sql
create table recognition_dish_candidates (
  id              uuid primary key default gen_random_uuid(),
  recognition_id  uuid not null references recognitions(id) on delete cascade,
  position        int not null,          -- 1..3, порядок модели
  name_ru         text not null,         -- как сказала модель
  confidence      numeric,
  why             text,
  ingredient_id   int references ingredients(id),   -- null, если не сматчилось
  match_score     numeric,
  match_source    text,                  -- 'povarenok' | 'usda_fndds'
  unique (recognition_id, position)
);
```

В `recognitions` добавить `portion_size` и `portion_reasoning` — денормализация
из `parsed`, как уже сделано для `dish_name_ru` и `scale_mode`.

В `meals` — что выбрал пользователь:

- `selected_dish_id` → `ingredients(id)`, null если ни один вариант не подошёл;
- `selected_candidate_position` — какой из трёх, или null при ручном вводе;
- `selected_portion_size` — `small` / `medium` / `large` / `custom`.

## Как заполняются meal_items

Выбрал блюдо и размер → состав раскладывается из `ingredient_components` и
масштабируется на вес порции по `share`. Каждая позиция — строка `meal_items` с
`nutrition_source = 'catalog'`.

`origin` в 0001 принимает `model_kept` / `model_edited` / `user_added`. Нужно
четвёртое значение — `catalog_dish`. Без него аналитика H1 начнёт считать
раскладку справочника за предложение модели, и метрика «доля оставленных без
изменений» потеряет смысл ровно тогда, когда её начнут сравнивать с H7.

## Когда ничего не сматчилось

Не ошибка, а штатный исход. Пользователю показываются три названия от модели без
привязки к справочнику и предложение ввести вес руками; `selected_dish_id`
остаётся null. Такие случаи считаются отдельно — это метрика покрытия справочника,
и она интереснее большинства остальных.

## Критерии приёмки

- Миграция идемпотентна (`if not exists` / `drop policy if exists`), применяется
  точечно через `apply-migrations.ts --only 0009` — как 0006.
- RLS: `recognition_dish_candidates` читается владельцем приёма пищи, по образцу
  `recognition_items` из 0002.
- Старый путь (v1/v2) продолжает работать без изменений — проверяется e2e.


## Comments

**Сделано.** Миграция 0009 применена: `recognition_dish_candidates` с RLS по
образцу `recognition_items`, `recognitions.portion_size` и `portion_reasoning`,
`meals.selected_dish_id` / `selected_candidate_position` / `selected_portion_size`.

Пайплайн связан сквозь: `polza.ts` валидирует ответ по `dishGuessSchema`, когда
`promptVersion = 'v3-dish'` (отдельным полем `guess`, а не union с `analysis` —
чтобы вызывающие v1/v2 не переписывать), `run.ts` сохраняет кандидатов через
`persistDishGuess`, `process.ts` ставит приёму пищи статус `awaiting_choice`.

`meal_items.origin` ограничения в схеме не имеет — только комментарий, так что
значение `catalog_dish` добавляется кодом без миграции.

**Не сделано:** сама раскладка выбранного блюда в `meal_items` — она относится к
экрану выбора [[10-ui-selection]], потому что запускается действием
пользователя, а не фоновым распознаванием.
