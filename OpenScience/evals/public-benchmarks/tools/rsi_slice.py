#!/usr/bin/env python3
"""Decide the registered failure slice and the improver's input from baseline evidence only (baseline v1 + the
development screen), never from a confirmation-pool row.

  rsi_slice.py --threshold 0.75 --out-dir rsi/

Writes rsi/slice.json (per-calculator accuracy, the slice and the rule), rsi/failures.json (the improver's input: every
baseline failure on those rows) and rsi/dev_rows.json / rsi/conf_rows.json (the development rows candidates run on, and
the confirmation groups), chosen by registered rules from the pools.
"""
import os
import argparse
import csv
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(os.environ.get('BENCH_ROOT', '.')).resolve()


def final_line(text):
    lines = [l.strip() for l in (text or '').splitlines() if l.strip()]
    marked = [l for l in lines if re.search(r'最终答案|final\s*answer', l, re.I)]
    return (marked or lines or [''])[-1][:300]


def verdicts(scored_path):
    return {json.loads(l)['key']: json.loads(l) for l in pathlib.Path(scored_path).read_text().splitlines() if l.strip()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--threshold', type=float, default=0.75)
    ap.add_argument('--dev-rows', type=int, default=36)
    ap.add_argument('--conf-groups', type=int, default=40)
    ap.add_argument('--out-dir', default=str(ROOT / 'rsi'))
    args = ap.parse_args()
    out = pathlib.Path(args.out_dir)
    table = {r['Row Number']: r for r in csv.DictReader(open(ROOT / 'data/medcalc/test_data.csv', newline=''))}
    pools = json.loads((ROOT / 'rsi/pools.json').read_text())
    sources = [('items/medcalc.jsonl', 'answers/v1-medcalc.jsonl', 'judge/medcalc.v1.jsonl'),
               ('items/rsi-screen.jsonl', 'answers/rsi-screen.jsonl', 'judge/medcalc.screen.jsonl')]
    per_calc, failures, screened = {}, [], set()
    for items_path, answers_path, scored_path in sources:
        items = {json.loads(l)['key']: json.loads(l) for l in (ROOT / items_path).read_text().splitlines() if l.strip()}
        answers = {json.loads(l)['key']: json.loads(l) for l in (ROOT / answers_path).read_text().splitlines() if l.strip()}
        scored = verdicts(ROOT / scored_path)
        for key, item in items.items():
            row = str(item['meta']['row_number'])
            assert row not in pools['confirmation'], f'confirmation row {row} in baseline evidence'
            ok = scored.get(key, {}).get('verdict') == 'correct'
            cid = int(item['gold']['calculator_id'])
            per_calc.setdefault(cid, []).append(ok)
            if items_path.endswith('rsi-screen.jsonl'):
                screened.add(row)
            if not ok:
                failures.append({'calculator': table[row]['Calculator Name'], 'question': table[row]['Question'] + '\n\n' + table[row]['Patient Note'][:900],
                                 'answer': final_line(answers.get(key, {}).get('text')), 'gold': table[row]['Ground Truth Answer'], 'row': row})
    accuracy = {cid: sum(v) / len(v) for cid, v in per_calc.items()}
    slice_ids = sorted(cid for cid, acc in accuracy.items() if acc < args.threshold)
    # Development rows: development-pool rows of slice calculators (screened first, then by the registered hash order),
    # topped up with non-slice screened rows so overall quality is measured too.
    key = lambda r: hashlib.sha256(f'rsi-capability-skill-2026-11|order|{r}'.encode()).hexdigest()
    dev_slice = sorted([r for r in pools['development'] if int(table[r]['Calculator ID']) in slice_ids], key=lambda r: (r not in screened, key(r)))
    dev_other = sorted([r for r in screened if int(table[r]['Calculator ID']) not in slice_ids], key=key)
    n_slice = min(len(dev_slice), round(args.dev_rows * 0.75))
    dev_rows = dev_slice[:n_slice] + dev_other[:args.dev_rows - n_slice]
    conf_slice = sorted([r for r in pools['confirmation'] if int(table[r]['Calculator ID']) in slice_ids], key=key)
    conf_other = sorted([r for r in pools['confirmation'] if int(table[r]['Calculator ID']) not in slice_ids], key=key)
    n_cs = min(len(conf_slice), max(25, round(args.conf_groups * 0.8)))
    conf_rows = conf_slice[:n_cs] + conf_other[:max(0, args.conf_groups - n_cs)]
    (out / 'slice.json').write_text(json.dumps({'rule': f'calculators whose baseline accuracy over baseline v1 + development screen < {args.threshold}',
        'threshold': args.threshold, 'failureCalculators': slice_ids, 'accuracy': {str(k): [round(v, 3), len(per_calc[k])] for k, v in sorted(accuracy.items())},
        'baselineRows': sum(len(v) for v in per_calc.values()), 'baselineAccuracy': sum(sum(v) for v in per_calc.values()) / sum(len(v) for v in per_calc.values())}, indent=1))
    (out / 'failures.json').write_text(json.dumps(failures, ensure_ascii=False, indent=1))
    (out / 'dev_rows.json').write_text(json.dumps({'pool': 'development', 'rows': dev_rows, 'slice_rows': n_slice}, indent=1))
    (out / 'conf_rows.json').write_text(json.dumps({'pool': 'confirmation', 'rows': conf_rows, 'slice_rows': n_cs}, indent=1))
    print(json.dumps({'slice': slice_ids, 'failures': len(failures), 'dev_rows': len(dev_rows), 'dev_slice': n_slice,
                      'conf_rows': len(conf_rows), 'conf_slice': n_cs, 'conf_slice_available': len(conf_slice)}))


if __name__ == '__main__':
    main()
