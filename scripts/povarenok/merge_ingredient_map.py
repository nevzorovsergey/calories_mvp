"""
Тикет 01, шаг 3: сборка ответов субагентов в словарь соответствий.

    .venv/bin/python scripts/povarenok/merge_ingredient_map.py [--round 1]

Результат: data/povarenok-ingredients.json (коммитится)

Печатает то, ради чего словарь и делается: покрытие по УПОМИНАНИЯМ, а не по
названиям. 1114 названий покрывают 1.38 млн упоминаний крайне неравномерно —
«Соль» встречается 87 272 раза, «Момордика» один. Метрика по названиям тут
обманывает.
"""

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMES = ROOT / "data" / "povarenok" / "ingredient-names.json"
OUT = ROOT / "data" / "povarenok-ingredients.json"

VALID_CONFIDENCE = {"exact", "close", "none"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--round", type=int, default=1)
    args = parser.parse_args()

    names = json.loads(NAMES.read_text(encoding="utf-8"))
    mentions = {row["name"]: row["mentions"] for row in names}

    merged, problems = {}, []
    for round_no in range(1, args.round + 1):
        out_dir = ROOT / "data" / "povarenok" / "ingredients" / f"round-{round_no}" / "out"
        if not out_dir.exists():
            continue
        for path in sorted(out_dir.glob("chunk-*.json")):
            try:
                chunk = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                problems.append(f"{path.name}: не разбирается ({exc})")
                continue
            for name, value in chunk.items():
                if name not in mentions:
                    problems.append(f"{path.name}: имени «{name}» нет во входе")
                    continue
                ingredient_id = value.get("ingredient_id")
                confidence = value.get("confidence")
                if confidence not in VALID_CONFIDENCE:
                    problems.append(f"{path.name}: «{name}» — confidence {confidence!r}")
                    continue
                if (ingredient_id is None) != (confidence == "none"):
                    problems.append(
                        f"{path.name}: «{name}» — id и confidence не согласованы"
                    )
                merged[name] = {
                    "ingredient_id": ingredient_id,
                    "confidence": confidence,
                }

    total_mentions = sum(mentions.values())
    covered_names = [n for n, v in merged.items() if v["ingredient_id"] is not None]
    covered_mentions = sum(mentions[n] for n in covered_names)
    answered_mentions = sum(mentions[n] for n in merged)

    OUT.write_text(
        json.dumps({k: merged[k] for k in sorted(merged)}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )

    print(f"названий во входе: {len(mentions)}, получено ответов: {len(merged)}")
    print(f"  сматчено: {len(covered_names)} названий")
    print(f"  покрытие по упоминаниям: {covered_mentions / total_mentions:.1%}")
    print(f"  разобрано по упоминаниям: {answered_mentions / total_mentions:.1%}")

    by_conf = {}
    for v in merged.values():
        by_conf[v["confidence"]] = by_conf.get(v["confidence"], 0) + 1
    print(f"  по уверенности: {by_conf}")

    missing = [n for n in mentions if n not in merged]
    if missing:
        missing.sort(key=lambda n: -mentions[n])
        print(f"  БЕЗ ОТВЕТА: {len(missing)}, крупнейшие: {missing[:10]}")
        print("  → npx tsx scripts/povarenok/export-ingredient-chunks.ts --round 2")

    unmatched = [n for n, v in merged.items() if v["ingredient_id"] is None]
    unmatched.sort(key=lambda n: -mentions[n])
    print(f"  не сматчено (ожидаемо для служебных и экзотики): {len(unmatched)}")
    print(f"    крупнейшие: {[(n, mentions[n]) for n in unmatched[:12]]}")

    if problems:
        print(f"\nПРОБЛЕМЫ ({len(problems)}):")
        for p in problems[:20]:
            print(f"  {p}")

    print(f"\nзаписано {OUT}")


if __name__ == "__main__":
    main()
