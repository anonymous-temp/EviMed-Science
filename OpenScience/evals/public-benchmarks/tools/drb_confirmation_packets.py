#!/usr/bin/env python3
"""Blinded pairwise judging packets for the sealed confirmation of the DeepResearch Bench family (RSI round 1): baseline against candidate, per
(row, repeat) of the registration, each pair in both orders.

  drb_confirmation_packets.py --registration rsi/round1/drb/registration.json --results /tmp/rsi1-scratch/round1/drb/confirmation \\
      --bench-key drb-rsi --candidate cand-806cd2194801 --criteria-dir data/drb/criteria --out /tmp/rsi1-scratch/round1/drb/cpackets [--passes 2]

--results is what materialise_lane_bundles.py wrote for the role (RESULTS/baseline and RESULTS/<candidate>). The development packets of
judged_packets_round.py refuse any id that is not a development row; this tool is the confirmation counterpart and takes its ids from the
registration alone (it verifies the registration first). It opens a task's criteria file because the judge reads the task's criteria; it prints
only counts, never a report, a criterion or a verdict.

Layout under --out (what judged_packets_round.py writes for development):
  judge/drb-pair-1/<label>/pass<k>/{task.txt, criteria.json, report_1.md, report_2.md, meta.json}   what a judge is given; <label> is `<row>r<repeat>`;
                                                                       arm names, order and rids appear nowhere in it
  operator/order/drb-pair-1/order.json (+ one link per label)           for `export_harness_arms.py --pairwise-order` (arm `a` is `baseline`, `b` the candidate)
  operator/pair-map/drb-pair-1.json                                      label -> {row, repeat, arm}, for `--pair-map`
  operator/keys.json, operator/manifest.json                             label -> rids; counts, and the pairs that have no packet and why

A pair has a packet when the candidate run SUCCEEDED (a run that did not deliver scores 0 in the lab and takes no verdict). A baseline run that did not
deliver, or left no report, is shown as an empty report ("an empty report loses decisively"); a baseline run that is not in --results at all stops the call.
Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import drb_pairwise as dp  # noqa: E402
import export_harness_arms as eha  # noqa: E402
import register_round as rr  # noqa: E402

DEFAULT_SEED = 20261028


class PacketError(Exception):
    pass


def run_status(folder):
    try:
        return json.loads((folder / 'result.json').read_text(encoding='utf-8')).get('status')
    except (OSError, ValueError):
        return None


def build(args):
    problems = rr.check(args.registration, None, None, None)
    if problems:
        raise PacketError('the registration does not verify: ' + '; '.join(problems))
    registration = json.loads(pathlib.Path(args.registration).read_text(encoding='utf-8'))
    if registration.get('scorer') != 'judged-verdicts' or registration.get('judge', {}).get('form') != 'pairwise':
        raise PacketError('the registration is not a pairwise judged family')
    rows = [str(i) for i in registration['rows']['confirmation']]
    repeats = int(registration['repeats']['confirmation'])
    passes = args.passes or int(registration['judge']['passes'])
    if passes != registration['judge']['passes']:
        raise PacketError(f'--passes {passes} is not the registered {registration["judge"]["passes"]}')
    out = pathlib.Path(args.out)
    judge, operator = out / 'judge' / 'drb-pair-1', out / 'operator'
    results = pathlib.Path(args.results)
    pair_map, keys, skipped = {}, {}, []
    for row in rows:
        criteria_file = pathlib.Path(args.criteria_dir) / f'{row}.json'
        for repeat in range(repeats):
            label = f'{row}r{repeat}'
            base_key = eha.run_key(eha.DEFAULT_KEY_TEMPLATE, args.bench_key, eha.BASELINE, row, repeat, repeats)
            cand_key = eha.run_key(eha.DEFAULT_KEY_TEMPLATE, args.bench_key, args.candidate, row, repeat, repeats)
            base, cand = eha.result_folder(results / eha.BASELINE, base_key), eha.result_folder(results / args.candidate, cand_key)
            if not base.is_dir() or not cand.is_dir():
                raise PacketError(f'{label}: a run is not in --results (materialise the role first)')
            status = run_status(cand)
            if status != 'succeeded':
                skipped.append({'label': label, 'why': f'candidate run did not deliver ({status})'})
                continue
            dp.build_packets(label, base, cand, 'baseline', args.candidate, passes, args.seed, judge, criteria_file)
            pair_map[label] = {'row': row, 'repeat': repeat, 'arm': args.candidate}
            keys[label] = {'row': row, 'repeat': repeat, 'baselineRun': base.name, 'candidateRun': cand.name, 'baselineStatus': run_status(base)}
    order_file = judge / 'order.json'
    target = operator / 'order' / 'drb-pair-1'
    target.mkdir(parents=True, exist_ok=True)
    os.replace(order_file, target / 'order.json')
    for label in pair_map:
        link = target / label
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(os.path.relpath((judge / label).resolve(), target.resolve()))
    (operator / 'pair-map').mkdir(parents=True, exist_ok=True)
    (operator / 'pair-map' / 'drb-pair-1.json').write_text(json.dumps(pair_map, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    (operator / 'keys.json').write_text(json.dumps(keys, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    (operator / 'manifest.json').write_text(json.dumps({
        'schema': 'rsi-round1-confirmation-packets/1', 'role': 'confirmation', 'registration': registration['digest'], 'candidate': args.candidate, 'seed': args.seed,
        'passes': passes, 'pairs': len(pair_map), 'packets': len(pair_map) * passes, 'skipped': skipped}, indent=1) + '\n', encoding='utf-8')
    return len(pair_map), passes, skipped


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--registration', required=True)
    p.add_argument('--results', required=True)
    p.add_argument('--bench-key', required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--criteria-dir', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--passes', type=int)
    p.add_argument('--seed', type=int, default=DEFAULT_SEED)
    args = p.parse_args(argv)
    try:
        pairs, passes, skipped = build(args)
    except (PacketError, dp.PairwiseError, rr.RegistrationError, OSError, ValueError) as error:
        print(f'drb_confirmation_packets: {error}', file=sys.stderr)
        return 2
    print(f'{pairs} pairs x {passes} passes = {pairs * passes} packets; {len(skipped)} pair(s) without a packet')
    return 0


if __name__ == '__main__':
    sys.exit(main())
