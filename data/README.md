# Данные справочника

Сюда кладутся дампы USDA FoodData Central и результаты русификации.
Дампы в репозиторий не коммитятся (они большие), переводы — коммитятся.

```
data/
  usda/sr_legacy/{food.csv,food_nutrient.csv,nutrient.csv}
  usda/foundation/{food.csv,food_nutrient.csv,nutrient.csv}
  translations.json           ← результат scripts/translate-ingredients.ts, КОММИТИТСЯ
  translations.override.csv   ← ручная вычитка топ-500, КОММИТИТСЯ
```

Формат `translations.override.csv` (первая строка — заголовок):

```csv
fdc_id,name_ru,synonyms
171077,"куриная грудка запечённая","куриное филе;грудка курицы"
```

Правки из override имеют приоритет над машинным переводом.
