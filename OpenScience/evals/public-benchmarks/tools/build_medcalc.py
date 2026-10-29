#!/usr/bin/env python3 -I
"""Build items/medcalc.jsonl: 120 MedCalc-Bench test rows, 2 per calculator (55) + 10 extra rows
from 10 randomly chosen calculators (seed 20261028). Also writes items/medcalc_used_rows.json."""
import os
import csv, json, random, collections
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
SEED = 20261028
rows = list(csv.DictReader(open(ROOT / "data/medcalc/test_data.csv", encoding="utf-8")))
by_calc = collections.defaultdict(list)
for r in rows:
    by_calc[int(r["Calculator ID"])].append(r)

rng = random.Random(SEED)
chosen = []
calc_ids = sorted(by_calc)
for cid in calc_ids:
    chosen += rng.sample(by_calc[cid], 2)
extra_calcs = sorted(rng.sample(calc_ids, 10))
for cid in extra_calcs:
    taken = {r["Row Number"] for r in chosen}
    chosen.append(rng.choice([r for r in by_calc[cid] if r["Row Number"] not in taken]))
chosen.sort(key=lambda r: int(r["Row Number"]))
assert len(chosen) == 120 and len({r["Row Number"] for r in chosen}) == 120

FINAL = "End with a final line: Final answer: <value>"
items = []
for r in chosen:
    prompt = (f"Here is the patient note:\n{r['Patient Note']}\n\n"
              f"Here is the task:\n{r['Question']}\n\n{FINAL}")
    items.append({
        "key": f"medcalc/{r['Row Number']}", "bench": "medcalc", "id": r["Row Number"], "group": "medcalc-main",
        "prompt": prompt, "line": None, "timeoutMin": 10, "files": [], "deleteGroupAfter": False,
        "gold": {"calculator_id": int(r["Calculator ID"]), "answer": r["Ground Truth Answer"],
                 "lower": r["Lower Limit"], "upper": r["Upper Limit"], "output_type": r["Output Type"]},
        "scorer": "medcalc",
        "meta": {"calculator_id": int(r["Calculator ID"]), "calculator": r["Calculator Name"],
                 "category": r["Category"], "output_type": r["Output Type"], "note_id": r["Note ID"],
                 "note_type": r["Note Type"], "row_number": int(r["Row Number"])},
    })
with open(ROOT / "items/medcalc.jsonl", "w", encoding="utf-8") as f:
    for it in items:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
used = {"source": "ncbi-nlp/MedCalc-Bench datasets/test_data.csv (1100 rows)",
        "row_numbers": [int(r["Row Number"]) for r in chosen],
        "note_ids_by_row": {r["Row Number"]: f"{r['Calculator ID']}:{r['Note ID']}" for r in chosen},
        "extra_calculators": extra_calcs}
(ROOT / "items/medcalc_used_rows.json").write_text(json.dumps(used, indent=1), encoding="utf-8")
print(len(items), collections.Counter(len([1 for r in chosen if int(r['Calculator ID'])==c]) for c in calc_ids))
print("rows:", ",".join(r["Row Number"] for r in chosen))
