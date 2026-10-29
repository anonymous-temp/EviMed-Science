#!/usr/bin/env python3 -I
"""Build items/arb.jsonl: AutoResearchBench, 30 deep + 15 wide, seed 20261028.

Source bundle: HF Lk123/AutoResearchBench AutoResearchBench.jsonl.obf.json (decoded with tools/arb_decode.py).
Deep (600 in the bundle, 60 of them have gold "None"): 27 non-None items stratified by category
(proportional, largest remainder) + 3 "None" items (population share is 10 %), the latter spread over categories at random.
Wide (400): 15 items, stratified by category (proportional, largest remainder).
"""
import os
import collections, json, random
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
SEED = 20261028
rows = [json.loads(l) for l in open(ROOT / "data/autoresearchbench_data/AutoResearchBench.jsonl", encoding="utf-8")]
for i, r in enumerate(rows):
    r["_idx"] = i

DEEP_LINE = "End with a final line: Final answer: <paper title> (arXiv:<id>), or None if no paper satisfies the conditions"
WIDE_LINE = ("End with a section that starts with a line \"Final answer:\" followed by one line per paper "
             "in the form: <paper title> (arXiv:<id>); write None if no paper satisfies the conditions")


def allocate(counts: dict, n: int, rng) -> dict:
    total = sum(counts.values())
    raw = {k: n * v / total for k, v in counts.items()}
    alloc = {k: int(x) for k, x in raw.items()}
    left = n - sum(alloc.values())
    order = sorted(counts, key=lambda k: (-(raw[k] - alloc[k]), rng.random()))
    for k in order[:left]:
        alloc[k] += 1
    return alloc


rng = random.Random(SEED)
deep = [r for r in rows if r["type"] == "deep"]
wide = [r for r in rows if r["type"] == "wide"]
deep_none = [r for r in deep if [a.strip().lower() for a in r["answer"]] == ["none"]]
deep_paper = [r for r in deep if r not in deep_none]

picked = []
for pool, n in ((deep_paper, 27), (wide, 15)):
    cats = collections.defaultdict(list)
    for r in pool:
        cats[r["category"]].append(r)
    alloc = allocate({c: len(v) for c, v in cats.items()}, n, rng)
    for c in sorted(cats):
        picked += rng.sample(cats[c], alloc[c])
picked += rng.sample(deep_none, 3)
picked.sort(key=lambda r: (r["type"] != "deep", r["_idx"]))

items = []
for r in picked:
    t = r["type"]
    is_none = t == "deep" and [a.strip().lower() for a in r["answer"]] == ["none"]
    prompt = r["question"].strip() + "\n\n" + (DEEP_LINE if t == "deep" else WIDE_LINE)
    items.append({
        "key": f"arb/{t}-{r['_idx']}", "bench": "arb", "id": f"{t}-{r['_idx']}", "group": "arb-main",
        "prompt": prompt, "line": None, "timeoutMin": 20, "files": [], "deleteGroupAfter": False,
        "gold": {"type": t, "titles": r["answer"], "arxiv_ids": r["arxiv_id"], "is_none": is_none},
        "scorer": "arb-deep" if t == "deep" else "arb-wide",
        "meta": {"type": t, "category": r["category"], "bundle_index": r["_idx"], "is_none": is_none,
                 "gold_count": 0 if is_none else len(r["answer"]), "topic": r.get("topic")},
    })
with open(ROOT / "items/arb.jsonl", "w", encoding="utf-8") as f:
    for it in items:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
print(len(items), collections.Counter((i["meta"]["type"], i["meta"]["category"]) for i in items))
print("none:", sum(i["meta"]["is_none"] for i in items), "wide gold sizes:", sorted(i["meta"]["gold_count"] for i in items if i["meta"]["type"] == "wide"))
