#!/usr/bin/env python3
"""Paired comparison of two scored arms on the same questions (exact McNemar, two-sided).
Lab host. Usage: paired.py <runA>[+variant] <runB>[+variant]   (run ids under /srv/evimed/runs)"""
import json
import sys
from math import comb
from score_rows import index_rows


def rows(spec):
    run, _, variant = spec.partition("+")
    path = f"/srv/evimed/runs/{run}/scores{'.' + variant if variant else ''}/rows.jsonl"
    with open(path, encoding="utf-8") as stream:
        return index_rows(json.loads(line) for line in stream if line.strip())


a, b = rows(sys.argv[1]), rows(sys.argv[2])
shared = set(a) & set(b)
ids = [key for key in shared if a[key] is not None and b[key] is not None]
print(f"all shared={len(shared)} paired observed={len(ids)} unobserved={len(shared) - len(ids)} "
      f"A-only identities={len(set(a) - set(b))} B-only identities={len(set(b) - set(a))}")
only_a = sum(1 for i in ids if a[i] and not b[i])
only_b = sum(1 for i in ids if b[i] and not a[i])
both = sum(1 for i in ids if a[i] and b[i])
n = only_a + only_b
k = min(only_a, only_b)
p = min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n) if n else 1.0
print(f"{sys.argv[1]} vs {sys.argv[2]}: shared={len(ids)} A={100 * (both + only_a) / (len(ids) or 1):.1f} B={100 * (both + only_b) / (len(ids) or 1):.1f} "
      f"A-only={only_a} B-only={only_b} diff={100 * (only_a - only_b) / (len(ids) or 1):+.1f} points, exact McNemar p={p:.4g}")
