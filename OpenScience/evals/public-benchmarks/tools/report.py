#!/usr/bin/env python3
"""Baseline v1 summary: per benchmark the score with a 95% interval, n, cost and time, from answers/ and judge/ files.

  report.py > report/baseline-v1.json   (and a Markdown table on stderr)

Proportions use the Wilson interval; continuous scores (RACE, rubric, metric) use a percentile bootstrap (seed 20261028,
2,000 resamples) over items. Every planned item counts: a run that failed or timed out scores 0.
"""
import os
import json
import math
import pathlib
import random
import statistics
import sys

ROOT = pathlib.Path(os.environ.get('BENCH_ROOT', '.')).resolve()


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - r) / d, (c + r) / d)


def bootstrap(values, seed=20261028, b=2000):
    if not values:
        return (None, None)
    rng = random.Random(seed)
    means = sorted(statistics.mean(rng.choice(values) for _ in values) for _ in range(b))
    return (means[int(0.025 * b)], means[int(0.975 * b) - 1])


def answers(queue):
    path = ROOT / 'answers' / f'{queue}.jsonl'
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


def ops(rows):
    costs = [r['cost'] for r in rows if r.get('cost') is not None]
    durs = [r['durationMs'] / 1000 for r in rows if r.get('durationMs')]
    routes = {}
    for r in rows:
        routes[r.get('route') or 'none'] = routes.get(r.get('route') or 'none', 0) + 1
    return {'runs': len(rows), 'succeeded': sum(1 for r in rows if r.get('status') == 'succeeded'),
            'costCny': round(sum(costs), 3), 'costPerRunCny': round(statistics.mean(costs), 4) if costs else None,
            'medianSeconds': round(statistics.median(durs), 1) if durs else None, 'routes': routes}


def proportion(name, queue, verdict_file, correct=lambda v: v.get('verdict') == 'correct', planned=None):
    rows = answers(queue)
    path = ROOT / 'judge' / verdict_file
    if not path.exists():
        return {'bench': name, 'status': 'not scored'}
    verdicts = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    n = planned or len(verdicts)
    k = sum(1 for v in verdicts if correct(v))
    lo, hi = wilson(k, n)
    return {'bench': name, 'metric': 'accuracy', 'score': k / n if n else None, 'ci95': [lo, hi], 'n': n, 'k': k, **ops(rows)}


def continuous(name, queue, verdict_file, field, planned=None):
    rows = answers(queue)
    path = ROOT / 'judge' / verdict_file
    if not path.exists():
        return {'bench': name, 'status': 'not scored'}
    values = [float(json.loads(l).get(field) or 0) for l in path.read_text().splitlines() if l.strip()]
    if planned and len(values) < planned:
        values += [0.0] * (planned - len(values))
    lo, hi = bootstrap(values)
    return {'bench': name, 'metric': field, 'score': statistics.mean(values) if values else None, 'ci95': [lo, hi], 'n': len(values), **ops(rows)}


def main():
    out = [
        proportion('MedCalc-Bench', 'v1-medcalc', 'medcalc.v1.jsonl'),
        proportion('MedBrowseComp', 'v1-medbrowsecomp', 'medbrowsecomp.final.jsonl'),
        proportion('AutoResearchBench (deep)', 'v1-arb', 'arb.deep.final.jsonl'),
        continuous('AutoResearchBench (wide)', 'v1-arb', 'arb.wide.final.jsonl', 'iou'),
        continuous('DeepResearch Bench (RACE, Claude judge)', 'v1-drb', 'drb.race.jsonl', 'race'),
        proportion('BixBench (open answers, Claude judge)', 'v1-bixbench', 'bixbench.final.jsonl'),
        continuous('ResearchClawBench (rubric, Claude judge)', 'v1-rcb', 'rcb.rubric.jsonl', 'score'),
        continuous('BioXArena (local held-out)', 'v1-bioxarena', 'bioxarena.scores.jsonl', 'score'),
    ]
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    for r in out:
        if r.get('status'):
            print(f"| {r['bench']} | {r['status']} |", file=sys.stderr)
            continue
        ci = r['ci95']
        print(f"| {r['bench']} | {r['score']:.3f} [{ci[0]:.3f}, {ci[1]:.3f}] | n={r['n']} | ¥{r['costCny']} | {r['medianSeconds']}s |", file=sys.stderr)


if __name__ == '__main__':
    main()
