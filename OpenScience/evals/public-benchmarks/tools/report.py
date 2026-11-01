#!/usr/bin/env python3
"""Baseline summary: per benchmark the score with a 95% interval, n, cost and time, from answers/ and judge/ files.

  report.py > report/baseline-v1.json   (and a Markdown table on stderr)       BENCH_ROOT = the work directory (default '.')

Proportions use the Wilson interval; continuous scores (RACE, rubric, metric) use a percentile bootstrap (seed 20261028,
2,000 resamples) over items. Every planned item counts: a run that failed or timed out scores 0.

Two figures for a run that timed out. `score` is STRICT: a timeout is 0, whatever it had written. `scoreAtCap` is the judged score
of what existed at the cap (answers/ row `delivery: "at-cap"`, a report-like file the driver captured; judge_packets.py puts it in
the packet); a timed-out run with nothing to read is 0 in both. The two are equal when no timed-out run was judged.

Repeated judging. A verdict file judge/<name>.jsonl is pass 1; judge/<name>.p2.jsonl, .p3.jsonl … are further passes over the same
reports (packets from `judge_packets.py --repeats N`, each judged with no verdict of another pass in sight). An item's value is the
mean over its passes; `judgeSd` is the pooled within-item standard deviation across passes (sqrt of the mean variance, n-1) and
`passes` the largest number of passes of any item. With one pass `judgeSd` is null, never 0. For a proportion, an item's value is
the share of its passes that said correct, and `flipRate` the share of items whose passes disagree.
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


def pass_files(verdict_file):
    """judge/<name>.jsonl (pass 1) and judge/<name>.p<k>.jsonl, in pass order; [] when there is no pass 1."""
    base = ROOT / 'judge' / verdict_file
    if not base.exists():
        return []
    stem = base.name[:-len('.jsonl')]
    extra = sorted((p for p in base.parent.glob(f'{stem}.p[0-9]*.jsonl') if p.name[len(stem) + 2:-len('.jsonl')].isdigit()),
                   key=lambda p: int(p.name[len(stem) + 2:-len('.jsonl')]))
    return [base, *extra]


def read_passes(verdict_file):
    """{key: [row of pass 1, row of pass 2, ...]} over the pass files (a key missing from a pass is simply not in its list)."""
    by_key = {}
    for f in pass_files(verdict_file):
        mine = {}
        for l in f.read_text().splitlines():
            if l.strip():
                row = json.loads(l)
                mine[row['key']] = row  # one verdict per key in a pass: a later line replaces an earlier one
        for key, row in mine.items():
            by_key.setdefault(key, []).append(row)
    return by_key


def pooled_sd(groups):
    """sqrt(mean within-group variance) over groups with >= 2 values; None when no group has two."""
    variances = [statistics.variance(g) for g in groups if len(g) >= 2]
    return math.sqrt(statistics.mean(variances)) if variances else None


def item_key(key):
    return key.split('#', 1)[0]


def ops(rows):
    costs = [r['cost'] for r in rows if r.get('cost') is not None]
    durs = [r['durationMs'] / 1000 for r in rows if r.get('durationMs')]
    firsts = [r['firstReportAtMs'] / 1000 for r in rows if r.get('firstReportAtMs') is not None]
    routes = {}
    for r in rows:
        routes[r.get('route') or 'none'] = routes.get(r.get('route') or 'none', 0) + 1
    out = {'runs': len(rows), 'succeeded': sum(1 for r in rows if r.get('status') == 'succeeded'),
           'timeouts': sum(1 for r in rows if r.get('status') == 'timeout'),
           'atCapReports': sum(1 for r in rows if r.get('delivery') == 'at-cap'),
           'costCny': round(sum(costs), 3), 'costPerRunCny': round(statistics.mean(costs), 4) if costs else None,
           'medianSeconds': round(statistics.median(durs), 1) if durs else None, 'routes': routes}
    # Only runs the driver (bench-driver/3) measured say whether they delivered within the cap; older rows say nothing.
    known = [r for r in rows if r.get('deliveredWithinCap') is not None]
    if known:
        out['deliveredWithinCapRate'] = round(sum(1 for r in known if r['deliveredWithinCap']) / len(known), 3)
        out['medianFirstReportSeconds'] = round(statistics.median(firsts), 1) if firsts else None
    return out


def proportion(name, queue, verdict_file, correct=lambda v: v.get('verdict') == 'correct', planned=None):
    rows = answers(queue)
    passes = read_passes(verdict_file)
    if not passes:
        return {'bench': name, 'status': 'not scored'}
    status = {r['key']: r.get('status') for r in rows}
    share = {k: statistics.mean(1.0 if correct(v) else 0.0 for v in vs) for k, vs in passes.items()}
    n = planned or len(share)
    k = sum(share.values())
    k_strict = sum(0.0 if status.get(item_key(key)) == 'timeout' else s for key, s in share.items())
    lo, hi = wilson(k_strict, n)
    out = {'bench': name, 'metric': 'accuracy', 'score': k_strict / n if n else None, 'ci95': [lo, hi], 'n': n, 'k': k_strict, **ops(rows)}
    if k_strict != k:
        out['scoreAtCap'] = k / n if n else None
        out['ci95AtCap'] = list(wilson(k, n))
    npass = max(len(vs) for vs in passes.values())
    out['passes'] = npass
    if npass > 1:
        multi = [vs for vs in passes.values() if len(vs) >= 2]
        out['judgeSd'] = pooled_sd([[1.0 if correct(v) else 0.0 for v in vs] for vs in multi])
        out['flipRate'] = sum(1 for vs in multi if len({bool(correct(v)) for v in vs}) > 1) / len(multi) if multi else None
    return out


def continuous(name, queue, verdict_file, field, planned=None):
    rows = answers(queue)
    passes = read_passes(verdict_file)
    if not passes:
        return {'bench': name, 'status': 'not scored'}
    status = {r['key']: r.get('status') for r in rows}
    per = {k: [float(v.get(field) or 0) for v in vs] for k, vs in passes.items()}
    means = {k: statistics.mean(vs) for k, vs in per.items()}
    at_cap = list(means.values())
    strict = [0.0 if status.get(item_key(k)) == 'timeout' else m for k, m in means.items()]
    if planned and len(strict) < planned:
        strict += [0.0] * (planned - len(strict))
        at_cap += [0.0] * (planned - len(at_cap))
    lo, hi = bootstrap(strict)
    out = {'bench': name, 'metric': field, 'score': statistics.mean(strict) if strict else None, 'ci95': [lo, hi], 'n': len(strict), **ops(rows)}
    if strict != at_cap:
        a_lo, a_hi = bootstrap(at_cap)
        out.update({'scoreAtCap': statistics.mean(at_cap), 'ci95AtCap': [a_lo, a_hi]})
    out['passes'] = max(len(vs) for vs in per.values())
    if out['passes'] > 1:
        out['judgeSd'] = pooled_sd(list(per.values()))
    return out


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
        atcap = f" (at-cap {r['scoreAtCap']:.3f})" if 'scoreAtCap' in r else ''
        sd = f" judge SD {r['judgeSd']:.3f} over {r['passes']} passes" if r.get('judgeSd') is not None else ''
        print(f"| {r['bench']} | {r['score']:.3f} [{ci[0]:.3f}, {ci[1]:.3f}]{atcap}{sd} | n={r['n']} | ¥{r['costCny']} | {r['medianSeconds']}s |", file=sys.stderr)


if __name__ == '__main__':
    main()
