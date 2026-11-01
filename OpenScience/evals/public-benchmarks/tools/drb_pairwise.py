#!/usr/bin/env python3
"""DeepResearch Bench, pairwise: which of two of OUR reports is better, per criterion, with the order swapped.

Why this exists.  Baseline v1 scored each report against the benchmark's fixed reference (RACE = target / (target +
reference)).  That ratio saturates: even a perfect 10 on every criterion only reaches 0.573 when the reference averages
7.5 (bench/report/analysis-drb.md section 6), so beyond about 0.55 it cannot rank two versions of the product and a +10 point
change cannot be tracked.  A pairwise comparison puts the two arms against each other on the task's own criteria: the
scale is the judge's preference between them, not a ratio to a third document, so it has no ceiling short of "decisively
better on every criterion", and what it measures is exactly the change under test.  The price is that it says nothing
about the absolute level; keep the RACE numbers for that and use this for A/B decisions.

Flow (the judge is whoever reads the packets; nothing here calls a model or a paid API and no provider is hard-coded):

  drb_pairwise.py packets --task 59 --a runs/arm-a --b runs/arm-b --arm-a base --arm-b skill [--passes 2] [--seed N] [--out DIR]
      -> DIR/<task>/pass<k>/{task.txt, criteria.json, report_1.md, report_2.md, meta.json}   (what a judge reads)
      -> DIR/order.json                                                                      (what only the aggregator reads)
  ... a judge (Claude subagents following judge/drb-pairwise.md and judge/PROTOCOL.md, or an API judge later) writes
      one verdict line per packet: {"key": "drb-pair/<task>/p<k>", "scores": {dimension: [{"idx": i, "pref": -3..3}]}}
  drb_pairwise.py aggregate --verdicts parts/*.jsonl --order DIR/order.json [--arms base,skill] [--out result.json]
  drb_pairwise.py selftest

Position handling.  Every pair is judged in BOTH orders: passes come in swapped couples (1,2), (3,4), ...; in the odd pass
of a couple the first-shown report is picked from sha256(f"{seed}|{task}|{pass}") and the even pass shows the opposite
order.  The order lives only in order.json; a packet holds report_1 / report_2 and a meta with its key and the criteria
count, nothing about arms, order or the other passes.  Give each packet to an independent judge call that has seen no
verdict of the same pair.

Verdict scale (pref, integer): +n means report_1 is better, -n report_2 is better, 0 equal; |n| 1 slight, 2 clear, 3 decisive.

Aggregation (arm A is the first --arm-a / --arm-b of `packets`):
  signed(pass, criterion) = pref if report_1 is A else -pref                (positive = A better)
  dimension(pass)         = sum(w_c * signed_c) / sum(w_c)                  (criterion weights from criteria.json)
  total(pass)             = sum(W_d * dimension_d) / sum(W_d)               (dimension_weight)
  task result             = mean over passes of dimension / total           (positive = A better)
  position bias           = mean over passes of the preference for whichever report was SHOWN FIRST (total level):
                            what flips with the order.  A judge that always favours the first report by n has bias n and
                            task result 0; a judge with a real preference has bias 0.  In scale units (-3..3).
  agreement               = share of criterion calls, over complete swapped couples, whose sign is the same in both orders
                            (0 == 0 counts); contradiction = share whose signs are strictly opposite
  win / tie / loss        = task result > +0.25 / within +-0.25 / < -0.25 (stated dead zone)
  overall                 = mean over included tasks, 95% percentile bootstrap over tasks (seed 20261028, 2000 resamples,
                            as report.py)
A task with a missing or invalid pass or criterion, a duplicate verdict that differs, or no criteria file is EXCLUDED from
every mean and listed with the reason; nothing is silently counted as zero.

Calibration against the official judge (future, not done here).  The benchmark's official RACE judge is GPT-5.5 since
2026-05-11 (Gemini-2.5-Pro on the legacy board).  A calibration would run the official pipeline over N tasks of ours for
both arms, then compare the sign and the rank of the per-task differences (official RACE target score of A minus B) with
this tool's task results, and read the agreement rate between the two; this repo makes no paid call, so the owner's decision
on a paid judge comes first.  Whatever judge is used only has to write the same verdict lines.

Python 3.10 compatible; run with `python3 -I`.  BENCH_ROOT (default '.') is the work directory holding data/drb/criteria/<task>.json.
"""
import argparse
import hashlib
import json
import os
import pathlib
import random
import statistics
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(os.environ.get('BENCH_ROOT', '.')).resolve()
DEFAULT_SEED = 20261028
BOOTSTRAP_SEED = 20261028
BOOTSTRAP_RESAMPLES = 2000
DEAD_ZONE = 0.25
PREF_MIN, PREF_MAX = -3, 3


class PairwiseError(Exception):
    pass


# ----------------------------------------------------------------------------------------------------------- reading reports

def pandoc_text(path):
    try:
        return subprocess.run(['pandoc', '-t', 'gfm', '--wrap=none', str(path)], capture_output=True, text=True, check=True).stdout
    except FileNotFoundError:
        raise PairwiseError('pandoc is needed to read a .docx report')
    except subprocess.CalledProcessError as error:
        raise PairwiseError(f'pandoc failed on {path}: {error.stderr[:200]}')


def read_report(path):
    """A report as text and where it came from. `path` is a .md/.txt/.docx file or a bench-driver result folder."""
    p = pathlib.Path(path)
    if p.is_dir():
        files = p / 'files'
        candidates = []
        if files.is_dir():
            candidates += [files / 'report' / 'report.md']
            candidates += sorted(files.rglob('report.md'))
            candidates += sorted((f for f in files.rglob('*.md')), key=lambda f: -f.stat().st_size)
            candidates += sorted((f for f in files.rglob('*.docx')), key=lambda f: -f.stat().st_size)
        result = p / 'result.json'
        if result.exists():
            try:
                last = (json.loads(result.read_text(encoding='utf-8')).get('lastReport') or {}).get('path')
            except ValueError:
                last = None
            if last:
                candidates.append(files / last)
        candidates.append(p / 'answer.md')
        for candidate in candidates:
            if candidate.is_file():
                return read_report(candidate)
        return '', f'{p}: nothing found'
    if not p.is_file():
        raise PairwiseError(f'report not found: {path}')
    if p.suffix.lower() == '.docx':
        return pandoc_text(p), str(p)
    return p.read_text(encoding='utf-8'), str(p)


# ----------------------------------------------------------------------------------------------------------- order

def position_first(seed, task, pass_no):
    """'a' or 'b': the arm shown first in `pass_no` (1-based). Odd passes are hashed, even passes swap the one before."""
    if pass_no % 2 == 0:
        return 'b' if position_first(seed, task, pass_no - 1) == 'a' else 'a'
    digest = hashlib.sha256(f'{seed}|{task}|{pass_no}'.encode()).digest()
    return 'a' if digest[0] % 2 == 0 else 'b'


def load_order(path):
    data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    if 'tasks' in data:
        return data
    return {'seed': None, 'arms': {'a': 'A', 'b': 'B'}, 'tasks': data}


def criteria_path(task, override=None):
    return pathlib.Path(override) if override else ROOT / 'data' / 'drb' / 'criteria' / f'{task}.json'


def criteria_count(criteria):
    return sum(len(v) for v in criteria['criterions'].values())


# ----------------------------------------------------------------------------------------------------------- packets

def build_packets(task, a_path, b_path, arm_a='A', arm_b='B', passes=2, seed=DEFAULT_SEED, out=None, criteria_file=None):
    if passes < 2 or passes % 2:
        raise PairwiseError('--passes must be an even number of at least 2 (every pair is judged in both orders)')
    task = str(task)
    out = pathlib.Path(out) if out else ROOT / 'judge' / 'packets-pair'
    criteria_text = criteria_path(task, criteria_file).read_text(encoding='utf-8')
    criteria = json.loads(criteria_text)
    text_a, source_a = read_report(a_path)
    text_b, source_b = read_report(b_path)
    texts = {'a': text_a, 'b': text_b}
    order_file = out / 'order.json'
    order = {'seed': seed, 'arms': {'a': arm_a, 'b': arm_b}, 'tasks': {}}
    if order_file.exists():
        order = json.loads(order_file.read_text(encoding='utf-8'))
        if order.get('seed') != seed or order.get('arms') != {'a': arm_a, 'b': arm_b}:
            raise PairwiseError(f'{order_file} was written for another seed or pair of arms; use a new --out')
    entry = {'passes': {}, 'sources': {'a': {'path': source_a, 'chars': len(text_a)}, 'b': {'path': source_b, 'chars': len(text_b)}}}
    for k in range(1, passes + 1):
        first = position_first(seed, task, k)
        second = 'b' if first == 'a' else 'a'
        d = out / task / f'pass{k}'
        d.mkdir(parents=True, exist_ok=True)
        (d / 'task.txt').write_text(criteria['prompt'], encoding='utf-8')
        (d / 'criteria.json').write_text(criteria_text, encoding='utf-8')
        (d / 'report_1.md').write_text(texts[first], encoding='utf-8')
        (d / 'report_2.md').write_text(texts[second], encoding='utf-8')
        (d / 'meta.json').write_text(json.dumps({'key': f'drb-pair/{task}/p{k}', 'criteria': criteria_count(criteria)}), encoding='utf-8')
        entry['passes'][str(k)] = {'first': first}
    order['tasks'][task] = entry
    out.mkdir(parents=True, exist_ok=True)
    tmp = order_file.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(order, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    tmp.replace(order_file)
    return order, out


# ----------------------------------------------------------------------------------------------------------- aggregation

def sign(x):
    return (x > 0) - (x < 0)


def bootstrap(values, seed=BOOTSTRAP_SEED, b=BOOTSTRAP_RESAMPLES):
    if not values:
        return [None, None]
    rng = random.Random(seed)
    means = sorted(statistics.mean(rng.choice(values) for _ in values) for _ in range(b))
    return [means[int(0.025 * b)], means[int(0.975 * b) - 1]]


def read_verdicts(files):
    """key -> list of verdict dicts (several only when a pass was judged twice)."""
    found = {}
    for f in files:
        for line_no, line in enumerate(pathlib.Path(f).read_text(encoding='utf-8').splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                raise PairwiseError(f'{f}:{line_no} is not JSON')
            if isinstance(row, dict) and isinstance(row.get('key'), str):
                found.setdefault(row['key'], []).append(row)
    return found


def valid_pref(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != int(value) or not PREF_MIN <= value <= PREF_MAX:
        return None
    return int(value)


def pass_prefs(rows, criteria, key):
    """Signed-as-shown preference per (dimension, idx) for one pass, or (None, reason)."""
    if len(rows) > 1 and any(json.dumps(r.get('scores'), sort_keys=True) != json.dumps(rows[0].get('scores'), sort_keys=True) for r in rows[1:]):
        return None, f'{key}: duplicate verdicts that differ'
    scores = rows[0].get('scores')
    if not isinstance(scores, dict):
        return None, f'{key}: no scores'
    shown = {}
    for dim, lst in criteria['criterions'].items():
        got = scores.get(dim)
        if not isinstance(got, list):
            return None, f'{key}: dimension {dim} missing'
        by_idx = {}
        for item in got:
            if isinstance(item, dict) and isinstance(item.get('idx'), int) and not isinstance(item.get('idx'), bool):
                by_idx.setdefault(item['idx'], []).append(item.get('pref'))
        for idx in range(len(lst)):
            prefs = by_idx.get(idx)
            if not prefs:
                return None, f'{key}: {dim}[{idx}] missing'
            if len(prefs) > 1:
                return None, f'{key}: {dim}[{idx}] scored twice'
            pref = valid_pref(prefs[0])
            if pref is None:
                return None, f'{key}: {dim}[{idx}] pref {prefs[0]!r} is not an integer in {PREF_MIN}..{PREF_MAX}'
            shown[(dim, idx)] = pref
        if len(by_idx) != len(lst):
            return None, f'{key}: {dim} has criteria that the packet does not list'
    return shown, None


def weighted(criteria, per_criterion):
    """(dimension means, total) of a (dim, idx) -> value map, with the criteria and dimension weights."""
    dims = {}
    for dim, lst in criteria['criterions'].items():
        total_w = sum(c['weight'] for c in lst)
        dims[dim] = sum(c['weight'] * per_criterion[(dim, i)] for i, c in enumerate(lst)) / total_w
    dw = criteria['dimension_weight']
    total = sum(dw[d] * dims[d] for d in dw) / sum(dw.values())
    return dims, total


def aggregate_task(task, entry, order_dir, verdicts):
    criteria_file = order_dir / task / 'pass1' / 'criteria.json'
    if not criteria_file.exists():
        return None, f'task {task}: {criteria_file} not found'
    criteria = json.loads(criteria_file.read_text(encoding='utf-8'))
    pass_numbers = sorted(int(k) for k in entry['passes'])
    signed, shown_first = {}, {}
    for k in pass_numbers:
        key = f'drb-pair/{task}/p{k}'
        rows = verdicts.get(key)
        if not rows:
            return None, f'task {task}: pass {k} has no verdict'
        shown, why = pass_prefs(rows, criteria, key)
        if why:
            return None, f'task {task}: {why}'
        first = entry['passes'][str(k)]['first']
        shown_first[k] = shown
        signed[k] = {c: (v if first == 'a' else -v) for c, v in shown.items()}
    dim_by_pass, total_by_pass, bias_by_pass, bias_dim_by_pass = {}, {}, {}, {}
    for k in pass_numbers:
        dim_by_pass[k], total_by_pass[k] = weighted(criteria, signed[k])
        bias_dim_by_pass[k], bias_by_pass[k] = weighted(criteria, shown_first[k])
    dims = {d: statistics.mean(dim_by_pass[k][d] for k in pass_numbers) for d in criteria['criterions']}
    total = statistics.mean(total_by_pass.values())
    bias = statistics.mean(bias_by_pass.values())
    agree = contradict = calls = 0
    for k in pass_numbers:
        if k % 2 == 1 and k + 1 in signed:
            for c in signed[k]:
                s1, s2 = sign(signed[k][c]), sign(signed[k + 1][c])
                calls += 1
                agree += s1 == s2
                contradict += s1 * s2 < 0
    result = {
        'task': task, 'passes': len(pass_numbers), 'dimensions': {d: round(v, 4) for d, v in dims.items()}, 'total': round(total, 4),
        'positionBias': round(bias, 4), 'agreement': round(agree / calls, 4) if calls else None,
        'contradiction': round(contradict / calls, 4) if calls else None, 'criteriaCalls': calls,
        'verdict': 'A' if total > DEAD_ZONE else 'B' if total < -DEAD_ZONE else 'tie',
        'perPass': {str(k): {'total': round(total_by_pass[k], 4), 'shownFirst': entry['passes'][str(k)]['first'], 'preferenceForFirstShown': round(bias_by_pass[k], 4)} for k in pass_numbers},
    }
    return result, None


def aggregate(order_file, verdict_files, arms=None):
    order_file = pathlib.Path(order_file)
    order = load_order(order_file)
    names = {'a': (arms[0] if arms else order['arms']['a']), 'b': (arms[1] if arms else order['arms']['b'])}
    verdicts = read_verdicts(verdict_files)
    tasks, excluded = [], []
    for task in sorted(order['tasks'], key=lambda t: (len(t), t)):
        result, why = aggregate_task(task, order['tasks'][task], order_file.parent, verdicts)
        if why:
            excluded.append({'task': task, 'reason': why})
        else:
            tasks.append(result)
    unknown = sorted(k for k in verdicts if not any(k.startswith(f'drb-pair/{t}/p') for t in order['tasks']))
    dims = sorted({d for t in tasks for d in t['dimensions']})
    totals = [t['total'] for t in tasks]
    summary = {
        'armA': names['a'], 'armB': names['b'], 'convention': 'positive = arm A better (scale -3..+3)', 'tasks': len(tasks), 'excluded': len(excluded),
        'total': {'mean': statistics.mean(totals) if totals else None, 'ci95': bootstrap(totals)},
        'dimensions': {d: {'mean': statistics.mean(t['dimensions'][d] for t in tasks), 'ci95': bootstrap([t['dimensions'][d] for t in tasks])} for d in dims} if tasks else {},
        'positionBias': {'mean': statistics.mean(t['positionBias'] for t in tasks) if tasks else None, 'ci95': bootstrap([t['positionBias'] for t in tasks]),
                         'note': 'preference for whichever report was shown first, scale units; 0 = none'},
        'agreement': (statistics.mean(t['agreement'] for t in tasks if t['agreement'] is not None) if any(t['agreement'] is not None for t in tasks) else None),
        'contradiction': (statistics.mean(t['contradiction'] for t in tasks if t['contradiction'] is not None) if any(t['contradiction'] is not None for t in tasks) else None),
        'deadZone': DEAD_ZONE, 'win': sum(t['verdict'] == 'A' for t in tasks), 'tie': sum(t['verdict'] == 'tie' for t in tasks), 'loss': sum(t['verdict'] == 'B' for t in tasks),
    }
    return {'summary': summary, 'tasks': tasks, 'excluded': excluded, 'unmatchedVerdictKeys': unknown}


def table(result):
    s = result['summary']
    f = lambda v: 'n/a' if v is None else f'{v:+.3f}'
    ci = lambda c: '' if c[0] is None else f' [{c[0]:+.3f}, {c[1]:+.3f}]'
    lines = [f"| {s['armA']} vs {s['armB']} | {s['tasks']} tasks ({s['excluded']} excluded) | win/tie/loss {s['win']}/{s['tie']}/{s['loss']} (dead zone +-{s['deadZone']}) |",
             f"| total | {f(s['total']['mean'])}{ci(s['total']['ci95'])} |"]
    lines += [f"| {d} | {f(v['mean'])}{ci(v['ci95'])} |" for d, v in s['dimensions'].items()]
    lines += [f"| position bias | {f(s['positionBias']['mean'])}{ci(s['positionBias']['ci95'])} |",
              f"| agreement / contradiction | {s['agreement'] if s['agreement'] is None else round(s['agreement'], 3)} / {s['contradiction'] if s['contradiction'] is None else round(s['contradiction'], 3)} |"]
    lines += [f"| excluded | {e['reason']} |" for e in result['excluded']]
    return '\n'.join(lines)


# ----------------------------------------------------------------------------------------------------------- selftest

def synthetic_criteria():
    return {'id': 1, 'prompt': 'Write about X.', 'dimension_weight': {'comprehensiveness': 0.6, 'insight': 0.4},
            'criterions': {'comprehensiveness': [{'criterion': 'c0', 'explanation': '', 'weight': 0.5}, {'criterion': 'c1', 'explanation': '', 'weight': 0.5}],
                           'insight': [{'criterion': 'i0', 'explanation': '', 'weight': 1.0}]}}


def selftest():
    with tempfile.TemporaryDirectory(prefix='drb-pair-') as tmp:
        tmp = pathlib.Path(tmp)
        (tmp / 'c.json').write_text(json.dumps(synthetic_criteria()))
        (tmp / 'a.md').write_text('report of arm a')
        (tmp / 'b.md').write_text('report of arm b')
        order, out = build_packets('1', tmp / 'a.md', tmp / 'b.md', 'base', 'skill', 2, 7, tmp / 'out', tmp / 'c.json')
        firsts = [order['tasks']['1']['passes'][k]['first'] for k in ('1', '2')]
        assert set(firsts) == {'a', 'b'}, firsts
        lines = []
        for k in (1, 2):  # a judge that likes arm A decisively
            first = firsts[k - 1]
            p = 3 if first == 'a' else -3
            lines.append(json.dumps({'key': f'drb-pair/1/p{k}', 'scores': {'comprehensiveness': [{'idx': 0, 'pref': p}, {'idx': 1, 'pref': p}], 'insight': [{'idx': 0, 'pref': p}]}}))
        (tmp / 'v.jsonl').write_text('\n'.join(lines) + '\n')
        result = aggregate(out / 'order.json', [tmp / 'v.jsonl'])
        assert result['tasks'][0]['total'] == 3 and result['tasks'][0]['positionBias'] == 0, result
    print('selftest: ok')
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='command', required=True)
    p = sub.add_parser('packets')
    p.add_argument('--task', required=True)
    p.add_argument('--a', required=True)
    p.add_argument('--b', required=True)
    p.add_argument('--arm-a', default='A')
    p.add_argument('--arm-b', default='B')
    p.add_argument('--passes', type=int, default=2)
    p.add_argument('--seed', type=int, default=DEFAULT_SEED)
    p.add_argument('--out')
    p.add_argument('--criteria', help='criteria JSON (default: BENCH_ROOT/data/drb/criteria/<task>.json)')
    g = sub.add_parser('aggregate')
    g.add_argument('--verdicts', nargs='+', required=True)
    g.add_argument('--order', required=True)
    g.add_argument('--arms', help='display names "a,b" (default: the names written by `packets`)')
    g.add_argument('--out')
    sub.add_parser('selftest')
    args = ap.parse_args(argv)
    try:
        if args.command == 'selftest':
            return selftest()
        if args.command == 'packets':
            order, out = build_packets(args.task, args.a, args.b, args.arm_a, args.arm_b, args.passes, args.seed, args.out, args.criteria)
            print(f"drb-pair/{args.task}: {args.passes} packets in {out / str(args.task)}; order in {out / 'order.json'} (keep it away from the judges)")
            return 0
        arms = args.arms.split(',') if args.arms else None
        if arms is not None and len(arms) != 2:
            raise PairwiseError('--arms takes two names: "a,b"')
        result = aggregate(args.order, args.verdicts, arms)
        text = json.dumps(result, ensure_ascii=False, indent=1) + '\n'
        if args.out:
            pathlib.Path(args.out).write_text(text, encoding='utf-8')
        else:
            sys.stdout.write(text)
        print(table(result), file=sys.stderr)
        return 0
    except PairwiseError as error:
        print(f'drb_pairwise: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
