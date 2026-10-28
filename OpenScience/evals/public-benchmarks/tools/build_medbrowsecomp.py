#!/usr/bin/env python3 -I
"""Build items/medbrowsecomp.jsonl: 80 of the 605 MedBrowseComp questions (16 per task type), seed 20261028.

Strata = task_name (5 types x 121). Within Exclusivity_Date (82/121 gold is empty = "no exclusivity date")
and Open_on_Approval (70/121 gold is Not_Listed) the sample is balanced 8 "trivial negative" + 8
"substantive" so a constant "NA"/"NOT LISTED" answer does not score 50-68%; meta.popWeight (N_stratum / n_stratum)
lets the analysis recover the population-weighted accuracy. Distinct trial (NCT id) per item where possible.
"""
import os
import csv, json, random, re, collections
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
SEED = 20261028
rows = list(csv.DictReader(open(ROOT / "data/medbrowsecomp/MedBrowseComp_605.csv", encoding="utf-8")))
for i, r in enumerate(rows):
    r["idx"] = i
    r["nct"] = re.search(r"NCT\d{8}", r["prompt"]).group(0)

def trivial(r):
    return (r["task_name"] == "Exclusivity_Date" and r["gold"] == "") or \
           (r["task_name"] == "Open_on_Approval" and r["gold"] == "Not_Listed")

rng = random.Random(SEED)
quota = []  # (task, stratum, n)
for t in ("Exclusivity_Date", "Open_on_Approval"):
    quota += [(t, "substantive", 8), (t, "trivial", 8)]
for t in ("Ingredient", "Applicant_Full_Name", "Patent_Expire_Date_Text"):
    quota.append((t, "all", 16))

used_nct, chosen = set(), []
for t, stratum, n in quota:
    pool = [r for r in rows if r["task_name"] == t and (stratum == "all" or (stratum == "trivial") == trivial(r))]
    rng.shuffle(pool)
    fresh = [r for r in pool if r["nct"] not in used_nct]
    take = (fresh + [r for r in pool if r["nct"] in used_nct])[:n]
    for r in take:
        r["stratum"] = stratum
        r["popWeight"] = len(pool) / n
        used_nct.add(r["nct"])
    chosen += take
assert len(chosen) == 80
order = {"Ingredient": 0, "Applicant_Full_Name": 1, "Patent_Expire_Date_Text": 2, "Exclusivity_Date": 3, "Open_on_Approval": 4}
chosen.sort(key=lambda r: (order[r["task_name"]], r["idx"]))
items = []
for r in chosen:
    items.append({
        "key": f"medbrowsecomp/{r['idx']}", "bench": "medbrowsecomp", "id": str(r["idx"]), "group": "medbrowsecomp-main",
        "prompt": r["prompt"], "line": None, "timeoutMin": 15, "files": [], "deleteGroupAfter": False,
        "gold": {"task_name": r["task_name"], "answer": r["gold"]},
        "scorer": "medbrowsecomp",
        "meta": {"task_name": r["task_name"], "stratum": r["stratum"], "popWeight": round(r["popWeight"], 4),
                 "nct": r["nct"], "csv_row": r["idx"]},
    })
with open(ROOT / "items/medbrowsecomp.jsonl", "w", encoding="utf-8") as f:
    for it in items:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
print(len(items), collections.Counter((i["meta"]["task_name"], i["meta"]["stratum"]) for i in items),
      "distinct NCT:", len({i["meta"]["nct"] for i in items}))
