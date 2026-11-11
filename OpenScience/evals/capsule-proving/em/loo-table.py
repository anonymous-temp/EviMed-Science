#!/usr/bin/env python3
"""Write-side matrix table: pass counts, Wilson 95% intervals and exact McNemar tests against the all-on cell.
Every scored row (answer, redline or redline-check) of a dataset's cells is paired by id. Run on the lab host."""
import json
import pathlib
import sys
from math import comb, sqrt

RUNS = pathlib.Path('/srv/evimed/runs')

def rows(name):
    path = RUNS / name / 'scores' / 'rows.jsonl'
    if not path.exists():
        return None
    out = {}
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            if row.get('verdict') in ('pass', 'fail') and row.get('kind') in ('answer', 'redline', 'redline-check'):
                out[row['id']] = row['verdict'] == 'pass'
    return out

def wilson(k, n, z=1.96):
    if not n:
        return (0, 0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (100 * (c - h), 100 * (c + h))

for dataset in sys.argv[1:]:
    base = rows(f'em-loo-{dataset}-baseline-1')
    print(f'## {dataset}')
    for config in ['baseline', 'no-safety', 'no-redaction', 'no-pasted-check', 'all-off']:
        cell = rows(f'em-loo-{dataset}-{config}-1')
        if cell is None:
            continue
        k, n = sum(cell.values()), len(cell)
        lo, hi = wilson(k, n)
        line = f'{config:16} {k}/{n} = {100 * k / n:.1f}% [{lo:.1f}, {hi:.1f}]'
        if config != 'baseline' and base:
            ids = sorted(set(base) & set(cell))
            a = sum(1 for i in ids if base[i] and not cell[i])
            b = sum(1 for i in ids if cell[i] and not base[i])
            m = a + b
            p = min(1.0, 2 * sum(comb(m, i) for i in range(min(a, b) + 1)) / 2 ** m) if m else 1.0
            line += f'  vs all-on: on-only {a}, off-only {b}, paired n={len(ids)}, exact McNemar p={p:.4f}'
        print(line)
