#!/usr/bin/env python3
"""Latest ledger row per (runId, arm, metric, name). Lab host. Usage: latest.py [regex on runId] [regex on metric]"""
import json
import re
import sys

pat = re.compile(sys.argv[1] if len(sys.argv) > 1 else ".")
mpat = re.compile(sys.argv[2] if len(sys.argv) > 2 else "accuracy")
path = sys.argv[3] if len(sys.argv) > 3 else "/srv/evimed/results/ledger.jsonl"
last = {}
for line in open(path, encoding="utf-8"):
    if not line.strip():
        continue
    r = json.loads(line)
    if not pat.search(r.get("runId", "")) or not mpat.search(r.get("metric", "")):
        continue
    last[(r.get("runId"), r.get("arm"), r.get("metric"), r.get("redline") or r.get("notes") or "")] = r
for (run, arm, metric, name), r in sorted(last.items(), key=lambda kv: (kv[1].get("set") or "", kv[0][0], kv[0][1] or "")):
    ci = r.get("ci95") or [0, 0]
    v = r.get("value")
    if metric == "accuracy":
        steps = json.dumps(r.get("byStep") or {}, separators=(",", ":"))
        print(f"{r.get('set'):<16} {arm:<28} n={r.get('n'):<5} {100 * v:5.1f} [{100 * ci[0]:.1f}, {100 * ci[1]:.1f}]  {steps}  ({run})")
    else:
        print(f"{r.get('set'):<16} {arm:<28} {metric} {name}: {v} of {r.get('n')}  ({run})")
