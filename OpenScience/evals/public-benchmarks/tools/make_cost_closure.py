#!/usr/bin/env python3
"""The cost records of the runs a campaign's receipt refused, as `harness_closure.mjs` reads them.

When the evaluator's receipt is refused with `campaign_cost_measurement_missing`, some runs of the sealed confirmation source carry no
settled cost: the usage record the lane driver read still showed an uncertain call or an open reservation. The ledger's record of each
of those runs is in the run's own `result.json` (bench-driver/3: `runId`, `status`, `cost` = {cost (the settled sum), openCost,
uncertain, calls}). This script collects exactly those records, each named by the row, arm and repeat it belongs to, into
`cost-closure.json` (+ `.sha256`), the file the lab inbox takes beside the campaign's other files. It reads no answer, no gold and no
score: only the ledger numbers of the runs it is given.

  make_cost_closure.py --benchmark medcalc-bench --run 601:baseline:2=results/cf.medcalc.601.base.r2/result.json \\
      --run 612:baseline:1=results/cf.medcalc.612.base.r1/result.json --out cost-closure.json [--source inputs-or-export.json]

--run ROW:ARM:REPEAT=RESULT (repeatable; the arm is `baseline` or `cand-<12 hex>`, the repeat is the 0-based index). With --source (a
harness-arms export or the lab's inputs.json) the set of runs given must be exactly the confirmation runs with no cost in it, with
the run ids and statuses it holds; without it the lab's closure makes the same check against the campaign's own inputs. A result whose
cost record is not a settled sum (no `cost.cost` number) is refused: the closure takes a number from the ledger and never invents one.
Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import hashlib
import json
import pathlib
import sys

DELIVERY = ('succeeded', 'failed', 'timeout')
NOTE = ('Each entry is the usage ledger\'s record of one run: `cost` is the sum of the calls it settled (a lower bound when `uncertain` or `openCost` is above 0). '
        'A signed closure (harness_closure.mjs) uses it as that run\'s cost and says so.')


class ClosureError(Exception):
    pass


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float('inf')


def read_run(spec):
    head, sep, path = spec.partition('=')
    parts = head.split(':')
    if not sep or len(parts) != 3 or not parts[0] or not parts[1] or not parts[2].isdigit():
        raise ClosureError(f'--run {spec!r} is ROW:ARM:REPEAT=RESULT (repeat a non-negative integer)')
    row, arm, repeat = parts[0], parts[1], int(parts[2])
    raw = pathlib.Path(path).read_bytes()
    try:
        result = json.loads(raw)
    except ValueError:
        raise ClosureError(f'{path} is not JSON')
    cost = result.get('cost') if isinstance(result, dict) else None
    if not isinstance(cost, dict) or not finite(cost.get('cost')) or cost['cost'] < 0:
        raise ClosureError(f'{path}: no settled cost in the usage record (cost.cost is not a number): the ledger has nothing to close this run with')
    if not isinstance(result.get('runId'), str) or not result['runId'] or result.get('status') not in DELIVERY:
        raise ClosureError(f'{path}: runId and a delivery status (succeeded, failed, timeout) are required')
    ledger = {'cost': cost['cost'], 'openCost': cost.get('openCost'), 'uncertain': cost.get('uncertain'), 'calls': cost.get('calls')}
    return {'row': row, 'arm': arm, 'repeat': repeat, 'runId': result['runId'], 'status': result['status'], 'ledger': ledger, 'resultSha256': hashlib.sha256(raw).hexdigest()}


def source_runs(path):
    data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    if isinstance(data, dict) and isinstance(data.get('sources'), dict):
        sources = [s for s in data['sources'].values() if isinstance(s, dict) and s.get('role') == 'confirmation']
        if len(sources) != 1:
            raise ClosureError(f'{path}: expected one confirmation source, found {len(sources)}')
        data = sources[0]
    if not isinstance(data, dict) or data.get('role') != 'confirmation' or not isinstance(data.get('runs'), list):
        raise ClosureError(f'{path} is not a confirmation harness-arms source or an inputs.json holding one')
    return data


def build(args):
    if not args.run:
        raise ClosureError('give at least one --run')
    runs = [read_run(spec) for spec in args.run]
    keys = [(r['row'], r['arm'], r['repeat']) for r in runs]
    if len(set(keys)) != len(keys):
        raise ClosureError('a run is named twice')
    if args.source:
        source = source_runs(args.source)
        if source.get('benchmark') != args.benchmark:
            raise ClosureError(f'the source is for {source.get("benchmark")}, not {args.benchmark}')
        missing = {(str(r['row']), r['arm'], r['repeat']): r for r in source['runs'] if not finite(r.get('cost'))}
        if set(keys) != set(missing):
            raise ClosureError(f'the runs given are not the runs without a cost: given {sorted(keys)}, without a cost {sorted(missing)}')
        for r in runs:
            held = missing[(r['row'], r['arm'], r['repeat'])]
            if held['runId'] != r['runId'] or held['status'] != r['status']:
                raise ClosureError(f'run {r["row"]}/{r["arm"]}/{r["repeat"]}: the source holds run {held["runId"]} ({held["status"]}), the result is {r["runId"]} ({r["status"]})')
    return {'kind': 'harness-cost-closure', 'schema': 1, 'benchmark': args.benchmark, 'note': NOTE, 'runs': sorted(runs, key=lambda r: (str(r['row']), r['arm'], r['repeat']))}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--benchmark', required=True)
    p.add_argument('--run', action='append', default=[])
    p.add_argument('--source')
    p.add_argument('--out', required=True)
    args = p.parse_args(argv)
    try:
        document = build(args)
    except (ClosureError, OSError) as error:
        print(f'make_cost_closure: {error}', file=sys.stderr)
        return 2
    out = pathlib.Path(args.out)
    payload = (json.dumps(document, ensure_ascii=False, indent=1) + '\n').encode('utf-8')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(payload)
    pathlib.Path(f'{out}.sha256').write_text(f'{hashlib.sha256(payload).hexdigest()}  {out.name}\n', encoding='utf-8')
    print(json.dumps({'written': str(out), 'runs': len(document['runs']), 'sha256': hashlib.sha256(payload).hexdigest()}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
