"""
Тикет 03: сквозная проверка словаря ингредиентов и граммовки мер.

Словарь (тикет 01) и граммовка (тикет 02) получены разными способами, и ошибка
в любом из них дальше уже не всплывёт: блюдо просто получит неверное КБЖУ, и
никто не заметит.

Проверка бесплатная и независимая. У каждого рецепта есть заявленное сайтом КБЖУ.
Мы считаем своё: словарь даёт ingredient_id, граммовка — вес, справочник — состав
на 100 г. Сравниваем.

Цель не сойтись в ноль: у нас USDA, у сайта своя таблица продуктов, и уварки нет
ни там, ни там. Цель — поймать грубые ошибки: перепутанный ингредиент, меру,
завышенную в десять раз, потерянный множитель.

    PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsx \
      scripts/povarenok/export-nutrients.ts
    .venv/bin/python scripts/povarenok/validate.py
"""

import collections
import json
import statistics
from pathlib import Path

from dump import KNOWN_UNITS, UNIT_PRIORS, dish_mass, load, parse_count

ROOT = Path(__file__).resolve().parents[2]
MAP = ROOT / "data" / "povarenok-ingredients.json"
MEASURES = ROOT / "data" / "povarenok-measures.json"
NUTRIENTS = ROOT / "data" / "povarenok" / "nutrients-cache.json"

# Рецепт идёт в проверку, только если словарь покрыл хотя бы столько его массы.
# Иначе меряется не расхождение таблиц, а дырка в покрытии.
MIN_COVERED_MASS = 0.8


def main():
    mapping = json.loads(MAP.read_text(encoding="utf-8"))
    measures = json.loads(MEASURES.read_text(encoding="utf-8"))["measures"]
    nutrients = json.loads(NUTRIENTS.read_text(encoding="utf-8"))
    data = load()

    errors = collections.defaultdict(list)
    by_root = collections.defaultdict(list)
    worst = []
    skipped = collections.Counter()

    for i, items in enumerate(data["ingredients"]):
        mass = dish_mass(data["nae_value"][i])
        if mass is None or not items:
            skipped["нет массы"] += 1
            continue

        totals = {"energy_kcal": 0.0, "protein": 0.0, "fat": 0.0, "carbs": 0.0}
        covered = 0.0
        actual = 0.0
        for it in items:
            parsed = parse_count(it["count"])
            if parsed is None:
                continue
            qty, unit = parsed
            name = (it["name"] or "").strip()
            if unit in KNOWN_UNITS:
                grams = qty * KNOWN_UNITS[unit]
            elif unit in UNIT_PRIORS:
                grams = qty * measures.get(name, {}).get(unit, UNIT_PRIORS[unit])
            else:
                continue
            actual += grams
            entry = mapping.get(name)
            if not entry or entry["ingredient_id"] is None:
                continue
            per100 = nutrients.get(str(entry["ingredient_id"]))
            if not per100:
                continue
            covered += grams
            for code in totals:
                totals[code] += per100.get(code, 0.0) * grams / 100.0

        if actual <= 0 or covered / actual < MIN_COVERED_MASS:
            skipped["мало покрыто словарём"] += 1
            continue

        declared = data["nae_value"][i].get("100 г блюда") or {}
        theirs = {
            "energy_kcal": declared.get("kcal"),
            "protein": declared.get("protein"),
            "fat": declared.get("fats"),
            "carbs": declared.get("carb"),
        }
        if not theirs["energy_kcal"]:
            skipped["нет заявленного КБЖУ"] += 1
            continue

        root = (data["kroshki"][i] or ["—"])[0]
        for code, value in theirs.items():
            if not value or value <= 0:
                continue
            ours = totals[code] / actual * 100.0
            deviation = abs(ours - value) / value
            errors[code].append(deviation)
            if code == "energy_kcal":
                by_root[root].append(deviation)
                worst.append((deviation, data["title"][i], round(ours), value))

    print(f"рецептов в проверке: {len(errors['energy_kcal'])}")
    for reason, n in skipped.most_common():
        print(f"  пропущено — {reason}: {n}")

    print("\nрасхождение с заявленным КБЖУ (на 100 г блюда):")
    for code in ("energy_kcal", "protein", "fat", "carbs"):
        values = sorted(errors[code])
        if not values:
            continue
        n = len(values)
        over50 = sum(1 for v in values if v > 0.5) / n
        print(
            f"  {code:12s} медиана {values[n // 2]:6.1%}  "
            f"p75 {values[int(n * 0.75)]:6.1%}  p90 {values[int(n * 0.9)]:6.1%}  "
            f"хуже 50%: {over50:5.1%}"
        )

    print("\nпо категориям (калорийность, медиана):")
    for root, values in sorted(by_root.items(), key=lambda kv: -len(kv[1]))[:12]:
        if len(values) < 50:
            continue
        print(f"  {root:38s} {statistics.median(values):6.1%}  n={len(values)}")

    worst.sort(reverse=True)
    print("\nхудшие 15 рецептов по калорийности:")
    for deviation, title, ours, theirs_value in worst[:15]:
        print(f"  {deviation:7.1%}  {title[:44]:44s} наше {ours:5} vs их {theirs_value}")


if __name__ == "__main__":
    main()
