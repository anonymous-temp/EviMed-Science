#!/usr/bin/env python3 -I
"""Build items/drb.jsonl (DeepResearch Bench, 15 zh + 15 en) and copy the RACE inputs for those items.

Source: data/drb_repo (shallow clone of Ayanami0730/deep_research_bench @ f2735b5c, 2026-09-29).
Selection per language (seed 20261028): every Health task, then every Science & Technology task
(= 12 per language), then the remaining 3 drawn at random from the other topics.
Writes data/drb/{criteria/<id>.json, reference/<id>.md, race/*}.
"""
import os
import json, random, shutil
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
REPO = ROOT / "data" / "drb_repo"
OUT = ROOT / "data" / "drb"
SEED = 20261028
PRIORITY = ["Health", "Science & Technology"]
PER_LANG = 15

queries = [json.loads(l) for l in open(REPO / "data/prompt_data/query.jsonl", encoding="utf-8")]
criteria = {c["id"]: c for c in (json.loads(l) for l in open(REPO / "data/criteria_data/criteria.jsonl", encoding="utf-8"))}
refs = {r["id"]: r for r in (json.loads(l) for l in open(REPO / "data/test_data/cleaned_data/reference.jsonl", encoding="utf-8"))}

rng = random.Random(SEED)
picked = []
for lang in ("zh", "en"):
    pool = [q for q in queries if q["language"] == lang]
    first = [q for q in pool if q["topic"] in PRIORITY]
    rest = [q for q in pool if q["topic"] not in PRIORITY]
    fill = rng.sample(rest, PER_LANG - len(first))
    picked += sorted(first, key=lambda q: q["id"]) + sorted(fill, key=lambda q: q["id"])

(OUT / "criteria").mkdir(parents=True, exist_ok=True)
(OUT / "reference").mkdir(parents=True, exist_ok=True)
(OUT / "race").mkdir(parents=True, exist_ok=True)
for name in ("prompt/score_prompt_en.py", "prompt/score_prompt_zh.py", "prompt/clean_prompt.py",
             "utils/score_calculator.py", "deepresearch_bench_race.py", "LICENSE"):
    shutil.copy(REPO / name, OUT / "race" / Path(name).name)

items = []
for q in picked:
    i = q["id"]
    assert q["prompt"] == criteria[i]["prompt"] == refs[i]["prompt"], i
    cpath = OUT / "criteria" / f"{i}.json"
    rpath = OUT / "reference" / f"{i}.md"
    cpath.write_text(json.dumps(criteria[i], ensure_ascii=False, indent=1), encoding="utf-8")
    rpath.write_text(refs[i]["article"], encoding="utf-8")
    items.append({
        "key": f"drb/{i}", "bench": "drb", "id": str(i), "group": "drb-main",
        "prompt": q["prompt"], "line": None, "timeoutMin": 30, "files": [], "deleteGroupAfter": False,
        "gold": {"criteria": f"/bench/data/drb/criteria/{i}.json",
                 "reference": f"/bench/data/drb/reference/{i}.md",
                 "dimension_weight": criteria[i]["dimension_weight"]},
        "scorer": "claude-race",
        "meta": {"topic": q["topic"], "language": q["language"], "source_id": i,
                 "reference_chars": len(refs[i]["article"])},
    })
(ROOT / "items").mkdir(exist_ok=True)
with open(ROOT / "items" / "drb.jsonl", "w", encoding="utf-8") as f:
    for it in items:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
print(len(items), [ (it["id"], it["meta"]["language"], it["meta"]["topic"]) for it in items])
