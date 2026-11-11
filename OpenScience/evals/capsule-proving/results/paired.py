#!/usr/bin/env python3
"""Paired comparison of two scored arms on the same questions (exact McNemar, two-sided).
Lab host. Usage: paired.py <runA>[+variant] <runB>[+variant]   (run ids under /srv/evimed/runs)"""
import json
import sys
from math import comb


def rows(spec):
    run, _, variant = spec.partition("+")
    path = f"/srv/evimed/runs/{run}/scores{'.' + variant if variant else ''}/rows.jsonl"
    out = {}
    for line in open(path, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("kind") == "answer":
            out[r["id"]] = r.get("verdict") == "pass"
    return out


a, b = rows(sys.argv[1]), rows(sys.argv[2])
ids = sorted(set(a) & set(b))
only_a = sum(1 for i in ids if a[i] and not b[i])
only_b = sum(1 for i in ids if b[i] and not a[i])
both = sum(1 for i in ids if a[i] and b[i])
n = only_a + only_b
k = min(only_a, only_b)
p = min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n) if n else 1.0
print(f"{sys.argv[1]} vs {sys.argv[2]}: shared={len(ids)} A={100 * (both + only_a) / len(ids):.1f} B={100 * (both + only_b) / len(ids):.1f} "
      f"A-only={only_a} B-only={only_b} diff={100 * (only_a - only_b) / len(ids):+.1f} points, exact McNemar p={p:.4g}")
