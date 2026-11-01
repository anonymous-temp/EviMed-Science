#!/usr/bin/env python3
"""The registered failure slice of the MedCalc family and the number of confirmation rows that makes it testable (RSI round 1).

  medcalc_slice.py --data data/medcalc/test_data.csv --pools pools/medcalc.json --ppc rsi/ppc-tasks.json --salt rsi1-confirm \\
      --development-salt rsi1-screen --development-rows 60 --verdicts judge/medcalc.v1.jsonl --verdicts judge/medcalc.v2.jsonl \\
      --verdicts judge/medcalc.screen.jsonl --score rsi/score/round1-medcalc-baseline.json --arm base --arm aa \\
      --threshold 0.75 --min-confirmation-in-slice 30 --out rsi/round1/medcalc/slice.json

The rule. A calculator is in the failure slice when its POOLED accuracy over the baseline evidence is below the threshold: every judged
or scored run of the baseline image is one observation, a calculator's accuracy is correct observations over observations, and the
evidence is exactly what is named here, development and baseline only:
  --verdicts   verdict lines {key, verdict} of earlier baseline runs on rows that are in neither pool (`medcalc/<row>` or
               `medcalc-rsi/base/<row>`); an observation is correct when the verdict is `correct`
  --score      a score_round.py JSON; the runs of the named --arm (here the unmodified image and its A/A repeat) that arrived and were
               scored; an observation is correct when the lab scorer gave 1
No candidate arm is read. A row id is mapped to its calculator by the two columns `Row Number` and `Calculator ID` of the original test
set (the source of the lane prompts); no other column is read into any name.

The confirmation size. Confirmation rows come in the registration's order (ascending sha256(salt|id) over the confirmation list
minus the ppc ids); the number asked for is the smallest N whose first N rows hold at least --min-confirmation-in-slice rows of
the slice. That needs each confirmation row's calculator id and nothing else; the ids and their calculators are never printed or
written, only N and how many of the N are in the slice.

Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import csv
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import register_round as rr  # noqa: E402

SCHEMA = 'rsi-round1-medcalc-slice/1'


class SliceError(Exception):
    pass


def calculator_ids(data_path, row_ids):
    """{row id: calculator id} for the wanted rows from the two columns the mapping needs; every other column goes unread."""
    wanted = {str(i) for i in row_ids}
    found = {}
    with open(data_path, newline='', encoding='utf-8') as handle:
        reader = csv.reader(handle)
        header = next(reader)
        at_row, at_calculator = header.index('Row Number'), header.index('Calculator ID')
        for record in reader:
            if record[at_row] in wanted:
                found[record[at_row]] = int(record[at_calculator])
    missing = sorted(wanted - set(found))
    if missing:
        raise SliceError(f'{len(missing)} row(s) have no calculator in {data_path}')
    return found


def row_of_key(key):
    return str(key).rsplit('/', 1)[-1]


def verdict_observations(path):
    """[(row id, correct)] from a verdict file."""
    out = []
    for number, line in enumerate(pathlib.Path(path).read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            out.append((row_of_key(entry['key']), entry['verdict'] == 'correct'))
        except (KeyError, TypeError, ValueError):
            raise SliceError(f'{path}:{number}: not a verdict line')
    return out


def score_observations(path, arm):
    """[(row id, correct)] from the runs of one arm of a score_round JSON that arrived and were scored by code."""
    document = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    try:
        runs = document['families']['medcalc']['arms'][arm]['runs']
    except KeyError:
        raise SliceError(f'{path} has no medcalc arm {arm!r}')
    return [(str(run['row']), run['score'] == 1) for run in runs if run.get('state') == 'ok' and isinstance(run.get('score'), (int, float))]


def sha256_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def confirmation_size(pool, salt, development_salt, ppc, development_rows, calculators, slice_ids, minimum):
    rows, available, _ = rr.select_rows(pool, salt, ppc, development_rows, None, development_salt)
    ordered = rows['confirmation']
    mapping = calculators(ordered)
    inside = 0
    for count, row in enumerate(ordered, 1):
        inside += mapping[row] in slice_ids
        if inside >= minimum:
            return count, inside, available['confirmation']
    raise SliceError(f'the whole confirmation list ({len(ordered)} rows) holds only {inside} rows of the slice, below {minimum}')


def build(args):
    observations, evidence = [], []
    for path in args.verdicts:
        found = verdict_observations(path)
        observations += found
        evidence.append({'source': pathlib.Path(path).name, 'kind': 'baseline verdicts', 'sha256': sha256_file(path), 'observations': len(found)})
    for arm in args.arm:
        found = score_observations(args.score, arm)
        observations += found
        evidence.append({'source': f'{pathlib.Path(args.score).name}#{arm}', 'kind': 'baseline-image runs of this round', 'sha256': sha256_file(args.score), 'observations': len(found)})
    mapping = calculator_ids(args.data, {row for row, _ in observations})
    counts = {}
    for row, correct in observations:
        entry = counts.setdefault(mapping[row], [0, 0])
        entry[0] += correct
        entry[1] += 1
    per = {str(cid): {'correct': c, 'n': n, 'accuracy': round(c / n, 6)} for cid, (c, n) in sorted(counts.items())}
    slice_ids = sorted(cid for cid, (c, n) in counts.items() if c / n < args.threshold)
    pool_file, pool, pool_digest = rr.read_pool(args.pools, args.pool)
    ppc = rr.ppc_ids(rr.read_json(args.ppc, 'the ppc file'), {'medcalc', str(pool_file.get('bench'))})
    size, inside, available = confirmation_size(pool, args.salt, args.development_salt, ppc, args.development_rows,
                                                lambda ids: calculator_ids(args.data, ids), set(slice_ids), args.min_confirmation_in_slice)
    return {
        'schema': SCHEMA, 'family': 'medcalc',
        'rule': (f'calculators whose pooled accuracy over development and baseline evidence is below {args.threshold}: every judged or scored run of the '
                 'baseline image is one observation; accuracy = correct observations / observations; no candidate arm is read'),
        'threshold': args.threshold, 'evidence': evidence, 'observations': len(observations), 'calculatorsObserved': len(per),
        'perCalculator': per, 'failureCalculators': slice_ids,
        'confirmation': {'rule': (f'the smallest N whose first N confirmation rows (registration order) hold at least {args.min_confirmation_in_slice} rows of the slice'),
                         'salt': args.salt, 'minimumInSlice': args.min_confirmation_in_slice, 'rows': size, 'rowsInSlice': inside, 'available': available},
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--data', required=True, help='the original MedCalc-Bench test_data.csv (the lane prompts come from it)')
    p.add_argument('--pools', required=True)
    p.add_argument('--pool', default='main')
    p.add_argument('--ppc', required=True)
    p.add_argument('--salt', required=True)
    p.add_argument('--development-salt')
    p.add_argument('--development-rows', type=int, required=True)
    p.add_argument('--verdicts', action='append', default=[])
    p.add_argument('--score', required=True)
    p.add_argument('--arm', action='append', required=True)
    p.add_argument('--threshold', type=float, default=0.75)
    p.add_argument('--min-confirmation-in-slice', type=int, default=30)
    p.add_argument('--out', required=True)
    args = p.parse_args(argv)
    try:
        document = build(args)
    except (SliceError, rr.RegistrationError, OSError, ValueError) as error:
        print(f'medcalc_slice: {error}', file=sys.stderr)
        return 2
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'failureCalculators': document['failureCalculators'], 'observations': document['observations'], 'confirmation': document['confirmation']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
