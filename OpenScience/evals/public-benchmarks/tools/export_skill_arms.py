#!/usr/bin/env python3
"""Build a `skill-arms` source (skill_campaign.mjs) from bench-driver results.

Usage:
  export_skill_arms.py --items items/medcalc-rsi-dev.jsonl --arm baseline=results/rsi-dev-baseline \
      --arm cand-xxxxxxxxxxxx=results/rsi-dev-cand-xxxxxxxxxxxx --candidates rsi/candidates.json \
      --repeats 1 --out rsi/development.json

Each results dir holds <key with / replaced by __>/result.json and answer.md as bench-driver writes them. An item key
carries the repeat as a suffix `#r<k>` when repeats > 1 (medcalc-rsi/<row>#r0). A run's cost is its settled CNY (the
driver's usage-ledger read): null when any of its calls was still open or uncertain, which the evaluator refuses to sign.
"""
import argparse
import re
import json
import pathlib
import sys


def load_items(path):
    rows = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        row_id = item['id'].split('#')[0]
        gold = item['gold']
        rows[row_id] = {'id': row_id, 'calculatorId': int(gold['calculator_id']),
                        'gold': {'answer': str(gold['answer']), 'lower': gold.get('lower'), 'upper': gold.get('upper')}}
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--items', required=True)
    ap.add_argument('--arm', action='append', required=True, help='armId=resultsDir')
    ap.add_argument('--candidates', help='improver output (candidates.json) for candidate arms')
    ap.add_argument('--repeats', type=int, required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    rows = load_items(args.items)
    candidates = {}
    if args.candidates:
        for c in json.loads(pathlib.Path(args.candidates).read_text())['candidates']:
            candidates[c['arm']] = {'digest': c['digest'], 'chars': c['chars'], 'title': c['title']}
    arms, runs, missing = {}, [], []
    for spec in args.arm:
        arm, directory = spec.split('=', 1)
        if arm == 'baseline':
            arms[arm] = {'skill': None}
        elif arm in candidates:
            arms[arm] = {'skill': candidates[arm]}
        else:
            sys.exit(f'unknown candidate arm {arm}')
        folder_arm = 'base' if arm == 'baseline' else arm
        for row_id in sorted(rows, key=lambda x: int(x) if x.isdigit() else x):
            for repeat in range(args.repeats):
                key = f'medcalc-rsi/{folder_arm}/{row_id}' + (f'#r{repeat}' if args.repeats > 1 else '')
                # bench-driver's folder rule: '/' -> '__', any other character outside [A-Za-z0-9_.-] -> '_'
                folder = pathlib.Path(directory) / re.sub(r'[^A-Za-z0-9_.-]', '_', key.replace('/', '__'))
                result_path = folder / 'result.json'
                if not result_path.exists():
                    missing.append(f'{arm}:{key}')
                    continue
                result = json.loads(result_path.read_text())
                answer_path = folder / 'answer.md'
                answer = answer_path.read_text() if answer_path.exists() else None
                cost = result.get('cost') or {}
                settled = cost.get('cost') if cost.get('openCost', 1) == 0 and cost.get('uncertain', 1) == 0 else None
                runs.append({'row': row_id, 'arm': arm, 'repeat': repeat, 'runId': result.get('runId') or f'none:{key}',
                             'status': result.get('status', 'unknown'), 'answer': answer, 'cost': settled})
    if missing:
        sys.exit(f'{len(missing)} runs missing, e.g. {missing[:5]}')
    source = {'kind': 'skill-arms', 'schema': 1, 'benchmark': 'medcalc-bench', 'repeats': args.repeats,
              'rows': [rows[k] for k in sorted(rows, key=lambda x: int(x) if x.isdigit() else x)], 'arms': arms, 'runs': runs}
    pathlib.Path(args.out).write_text(json.dumps(source, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'rows': len(rows), 'arms': list(arms), 'runs': len(runs),
                      'unsettled': sum(1 for r in runs if r['cost'] is None)}))


if __name__ == '__main__':
    main()
