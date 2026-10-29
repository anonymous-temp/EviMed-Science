#!/usr/bin/env python3 -I
"""Validate items/*.jsonl against the output contract; print per-bench counts, time budget and leak checks."""
import os
import glob, json, re, sys
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
REQ = ["key", "bench", "id", "group", "prompt", "line", "timeoutMin", "files", "deleteGroupAfter", "gold", "scorer", "meta"]
BANNED = re.compile(r"medcalc|medbrowsecomp|autoresearchbench|deepresearch bench|bixbench|researchclaw|bioxarena", re.I)
problems, keys, tot = [], set(), 0
for p in sorted(glob.glob(str(ROOT / "items/*.jsonl"))):
    its = [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
    name = Path(p).stem
    groups = {}
    for it in its:
        for k in REQ:
            if k not in it:
                problems.append((name, it.get("key"), "missing " + k))
        if it["key"] in keys:
            problems.append((name, it["key"], "duplicate key"))
        keys.add(it["key"])
        if it["bench"] != name or not it["key"].startswith(name + "/"):
            problems.append((name, it["key"], "bench/key mismatch"))
        if BANNED.search(it["prompt"]):
            problems.append((name, it["key"], "prompt names a benchmark: " + BANNED.search(it["prompt"]).group(0)))
        if "canary" in json.dumps(it).lower():
            problems.append((name, it["key"], "canary string present"))
        g = it["gold"]
        # leak checks: long gold strings must not appear in the prompt
        golds = []
        if "titles" in g: golds += [t for t in g["titles"] if len(t) > 12 and t.lower() != "none"]
        if "questions" in g: golds += [q["ideal"] for q in g["questions"] if len(q["ideal"]) > 8]
        if isinstance(g.get("answer"), str) and len(g["answer"]) > 9 and g.get("task_name") in ("Ingredient", "Applicant_Full_Name"): golds.append(g["answer"])
        for s in golds:
            if s.lower() in it["prompt"].lower():
                problems.append((name, it["key"], "gold text in prompt: " + s[:40]))
        for f in it["files"]:
            if not f["src"].startswith("/bench/data/") or not f["dest"].startswith("inputs/"):
                problems.append((name, it["key"], "bad file mapping " + str(f)))
            if "target_study" in f["src"] or "CapsuleNotebook" in f["src"]:
                problems.append((name, it["key"], "answer material mounted: " + f["src"]))
        groups.setdefault(it["group"], []).append(it)
    mins = sum(i["timeoutMin"] for i in its)
    tot += mins
    print(f"{name:20s} items={len(its):3d} groups={len(groups):3d} timeoutMin_sum={mins:5d} max_timeout={max(i['timeoutMin'] for i in its)} "
          f"files={sum(len(i['files']) for i in its)} scorers={sorted({i['scorer'] for i in its})}")
print("TOTAL items:", len(keys), "sum of timeouts (upper bound, minutes):", tot)
print("PROBLEMS:", problems or "none")
sys.exit(1 if problems else 0)
