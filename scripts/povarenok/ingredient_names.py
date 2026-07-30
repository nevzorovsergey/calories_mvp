"""
Тикет 01, шаг 1: выгрузка словаря ингредиентов Povarenok.

Словарь у сайта закрытый, поэтому маппинг на наш справочник — задача на тысячу
строк, а не на полтора миллиона. Здесь только выгрузка; кандидатов из нашего
справочника подтягивает scripts/povarenok/export-ingredient-chunks.ts, ему нужен
Supabase, а parquet читать он не умеет.

    .venv/bin/python scripts/povarenok/ingredient_names.py

Результат: data/povarenok/ingredient-names.json (не коммитится, как весь дамп)
"""

import collections
import json
from pathlib import Path

from dump import KNOWN_UNITS, UNIT_PRIORS, load, parse_count

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "povarenok" / "ingredient-names.json"


def main():
    data = load()
    mentions = collections.Counter()
    units = collections.defaultdict(collections.Counter)

    for items in data["ingredients"]:
        if not items:
            continue
        for it in items:
            # Висячий пробел делает «Яблоко » и «Яблоко» разными строками —
            # схлопываем здесь, иначе субагенты будут переводить одно дважды.
            name = (it["name"] or "").strip()
            if not name:
                continue
            mentions[name] += 1
            parsed = parse_count(it["count"])
            if parsed:
                unit = parsed[1]
                if unit in KNOWN_UNITS or unit in UNIT_PRIORS:
                    units[name][unit or "по вкусу"] += 1

    out = [
        {
            "name": name,
            "mentions": count,
            "units": [u for u, _ in units[name].most_common(4)],
        }
        for name, count in mentions.most_common()
    ]
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    total = sum(mentions.values())
    covered, acc = 0, 0
    for _, c in mentions.most_common():
        acc += c
        covered += 1
        if acc >= 0.95 * total:
            break
    print(f"названий: {len(out)}, упоминаний: {total}")
    print(f"95% упоминаний покрывают {covered} названий")
    print(f"встречаются один раз: {sum(1 for c in mentions.values() if c == 1)}")
    print(f"записано {OUT}")


if __name__ == "__main__":
    main()
