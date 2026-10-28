#!/usr/bin/env python3
"""MedCalc items for the capability-skill RSI campaign, from the registered pools (rsi/pools.json).

  build_rsi_items.py screen   -> items/medcalc-rsi-screen.jsonl : baseline arm, 2 development rows per calculator (seeded)
  build_rsi_items.py arms --rows rsi/dev_rows.json --arm baseline --arm cand-xxx=rsi/candidates.json --repeats 1 --name rsi-dev
                              -> queue/<name>.jsonl with alternating arm blocks (keepRuntime), plus items/<name>.jsonl (gold kept)

Prompts are byte-identical in form to baseline v1 (tools/build_medcalc.py). A candidate arm's items carry its skill as
groupSkill; the baseline arm carries none. Arms alternate in blocks of `--block` rows so time-of-day drift falls on both.
"""
import os
import argparse
import csv
import json
import pathlib
import random

ROOT = pathlib.Path(os.environ.get('BENCH_ROOT', '.')).resolve()
FINAL = "End with a final line: Final answer: <value>"
SEED = 20261028


def table():
    return {r['Row Number']: r for r in csv.DictReader(open(ROOT / 'data/medcalc/test_data.csv', newline=''))}


def item(r, arm, repeat, repeats, skill):
    rid = r['Row Number'] + (f'#r{repeat}' if repeats > 1 else '')
    prompt = f"Here is the patient note:\n{r['Patient Note']}\n\nHere is the task:\n{r['Question']}\n\n{FINAL}"
    return {'key': f'medcalc-rsi/{arm}/{rid}', 'bench': 'medcalc-rsi', 'id': rid, 'group': f'rsi-{arm}', 'prompt': prompt, 'line': None,
            'timeoutMin': 10, 'files': [], 'deleteGroupAfter': False, 'keepRuntime': True, 'groupSkill': skill,
            'gold': {'calculator_id': int(r['Calculator ID']), 'answer': r['Ground Truth Answer'], 'lower': r['Lower Limit'],
                     'upper': r['Upper Limit'], 'output_type': r['Output Type']},
            'meta': {'arm': arm, 'repeat': repeat, 'calculator': r['Calculator Name'], 'row_number': int(r['Row Number'])}}


def write(name, items):
    (ROOT / 'items' / f'{name}.jsonl').write_text(''.join(json.dumps(i, ensure_ascii=False) + '\n' for i in items))
    keep = ('key', 'bench', 'id', 'group', 'prompt', 'line', 'timeoutMin', 'files', 'deleteGroupAfter', 'keepRuntime', 'groupSkill')
    (ROOT / 'queue' / f'{name}.jsonl').write_text(''.join(json.dumps({k: i[k] for k in keep} | {'collect': True}, ensure_ascii=False) + '\n' for i in items))
    print(name, len(items))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('command', choices=['screen', 'arms'])
    ap.add_argument('--rows')
    ap.add_argument('--arm', action='append', default=[])
    ap.add_argument('--repeats', type=int, default=1)
    ap.add_argument('--block', type=int, default=5)
    ap.add_argument('--name')
    args = ap.parse_args()
    t = table()
    pools = json.loads((ROOT / 'rsi/pools.json').read_text())
    if args.command == 'screen':
        rng = random.Random(SEED)
        by_calc = {}
        for row in pools['development']:
            by_calc.setdefault(t[row]['Calculator ID'], []).append(row)
        chosen = []
        for cid in sorted(by_calc, key=int):
            rows = sorted(by_calc[cid], key=int)
            chosen += rng.sample(rows, min(2, len(rows)))
        write('rsi-screen', [item(t[r], 'base', 0, 1, None) for r in sorted(chosen, key=int)])
        return
    rows = json.loads(pathlib.Path(args.rows).read_text())
    assert all(r in pools[rows['pool']] for r in rows['rows']), 'a row outside its registered pool'
    arms = []
    for spec in args.arm:
        if spec == 'baseline':
            arms.append(('base', None))
        else:
            arm, path = spec.split('=', 1)
            c = next(x for x in json.loads(pathlib.Path(path).read_text())['candidates'] if x['arm'] == arm)
            arms.append((arm, {'title': c['title'], 'description': c['description'], 'instructions': c['instructions']}))
    items, ids = [], rows['rows']
    for start in range(0, len(ids), args.block):
        block = ids[start:start + args.block]
        for repeat in range(args.repeats):
            for arm, skill in arms:
                items += [item(t[r], arm, repeat, args.repeats, skill) for r in block]
    write(args.name, items)


if __name__ == '__main__':
    main()
