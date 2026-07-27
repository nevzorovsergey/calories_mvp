# Данные справочника

Сюда кладутся дампы USDA FoodData Central и результаты русификации.
Дампы в репозиторий не коммитятся (они большие), переводы — коммитятся.

```
data/
  usda/sr_legacy/{food.csv,food_nutrient.csv,nutrient.csv,food_category.csv}
  usda/foundation/…то же самое
  translations/round-N/         ← рабочие чанки перевода, НЕ коммитятся
  translations.json             ← результат scripts/merge-translations.ts, КОММИТИТСЯ
  translations.override.csv     ← ручная вычитка топ-500, КОММИТИТСЯ
```

Формат `translations.override.csv` (первая строка — заголовок):

```csv
fdc_id,name_ru,synonyms
171077,"куриная грудка запечённая","куриное филе;грудка курицы"
```

Правки из override имеют приоритет над переводом из `translations.json`.

## Откуда качать дампы

Список версий — https://fdc.nal.usda.gov/download-datasets. Актуальные на 2026-07:

```sh
curl -LO https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
curl -LO https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip
```

SR Legacy заморожен на 2018-04 (7793 позиции, все — `data_type=sr_legacy_food`).
Foundation обновляется дважды в год; в его `food.csv` 88k строк, но собственно
продуктов — 469 (`data_type=foundation_food`), остальное — пробы и закупки
(`sample_food`, `sub_sample_food`, `market_acquisition`, `agricultural_acquisition`),
у которых нет ни калорийности, ни осмысленного названия.

Одинаковые продукты встречаются дважды: 100 описаний есть и в SR Legacy, и в
Foundation, плюс Foundation перепубликовывает продукт с новым `fdc_id`, когда
переснимает лабораторные данные (469 строк на 400 описаний). Импортёр оставляет
активной одну запись на описание — Foundation важнее SR, более поздняя
публикация важнее ранней.

## Датасеты для бенчмарка распознавания

`data/benchmarks/` в репозиторий не коммитится. Скачано на 2026-07:

```sh
mkdir -p data/benchmarks && cd data/benchmarks
curl -LO https://january-food-image-dataset-public.s3.amazonaws.com/food-scan-benchmark-dataset.tar.gz
tar xzf food-scan-benchmark-dataset.tar.gz && rm food-scan-benchmark-dataset.tar.gz
```

**January Food Benchmark (JFB)**, 240 МБ распакованными, [arXiv:2508.09966](https://arxiv.org/abs/2508.09966),
код бенчмарка — https://github.com/January-ai/food-scan-benchmarks (MIT; на сами
данные отдельной лицензии в репозитории нет, статья под CC BY 4.0).

```
food-scan-benchmark-dataset/
  fsb_images/fsb_00000.jpg … fsb_00999.jpg   ← 1000 фото
  food_scan_bench_v1.csv                     ← разметка, 1000 строк
  dataset_stats.json
```

Колонки CSV: `image_id`, `image_filename`, `meal_name`, `ingredients_list`,
`ingredient_names`, `num_ingredients`, `total_calories`, `total_carbs`,
`total_protein`, `total_fat`. Оба поля с ингредиентами — строки с
python-литералом внутри JSON-строки, парсятся `ast.literal_eval` (в JS —
двойной разбор). `ingredients_list` даёт КБЖУ по каждому ингредиенту отдельно.

821 уникальное название блюда, 863 уникальных ингредиента, в среднем 4.95 на
блюдо; калорийность от 32 до 1396 ккал, медиана 393. Кухня западная, названия
английские — для русских блюд бенчмарк надо собирать свой.

## Перевод субагентами

`npm run usda:chunks` раскладывает непереведённые позиции по
`data/translations/round-N/in/chunk-NN.json`. Каждый чанк отдаётся одному
субагенту Claude Code со следующим промптом (подставить путь):

> Ты переводишь названия продуктов из базы USDA FoodData Central на русский для
> справочника приложения подсчёта калорий.
>
> Прочитай `{IN_PATH}` инструментом Read. Это JSON с полями `chunk`, `out`,
> `count`, `items[]`, каждый элемент — `{fdc_id, description, category}`.
> Переведи **все** `count` позиций и запиши результат инструментом Write **ровно**
> по пути из поля `out`.
>
> Формат выходного файла — JSON-объект, ключ — строка `fdc_id`, значение —
> `{"name_ru": "...", "synonyms": ["...", "..."]}`. Ничего кроме JSON: без
> markdown-заборов, без BOM, отступ 1 пробел.
>
> - `name_ru` — короткое узнаваемое русское название, как его напишет обычный
>   человек («куриная грудка запечённая», а не «мясо птицы курица грудная часть
>   без кожи»). Строчными, без точки в конце, не длиннее 60 символов.
> - Сохраняй важные уточнения оригинала: способ приготовления, жирность,
>   сырое/готовое, консервированное. «Broccoli, raw» → «брокколи сырая»,
>   «Broccoli, cooked, boiled, drained» → «брокколи отварная».
> - `category` дана для снятия неоднозначности, переводить её не надо.
> - `synonyms` — 2–4 варианта, которыми продукт назовут в быту, включая
>   разговорные. Строчными, без повторов, ни один не совпадает с `name_ru`.
> - **Про синонимы важное:** родовое слово («молоко», «яйцо», «хлеб», «сыр»)
>   давай только той позиции, которая и есть этот продукт в чистом виде.
>   Уточнённым позициям — уточнённые синонимы («молоко 2%», «молоко нежирное»).
>   Родовое слово в справочнике принадлежит ровно одной позиции.
> - Бренды оставляй латиницей, если их так и пишут в России, иначе транслитерируй.
> - `fdc_id` не меняй и не переводи.
>
> Переводи сам, своими знаниями. **Не используй WebSearch, WebFetch, curl,
> внешние API и ключи.** Не читай и не меняй никакие файлы, кроме входного и
> выходного.
>
> Перед записью сверь: число ключей === `count`. Если не сходится — допиши
> недостающие и только потом пиши файл.
>
> В финальном сообщении верни одну строку: `chunk-NN 300/300 → <путь>`.

Дальше `npm run usda:merge -- --sample 30` собирает `translations.json` и
печатает отчёт: покрытие, непереведённое, коллизии синонимов. Если покрытие
неполное — `npm run usda:chunks -- --round 2` нарежет только остаток, раунды
аддитивны.
