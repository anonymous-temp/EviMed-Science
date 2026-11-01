#!/usr/bin/env python3
"""Judge-noise sample (phase 0.4): repeat packets of reports already judged once, and the noise band once they are judged again.

  noise_sample.py packets [--passes 3] [--out DIR] [--bix-scope llm|unsettled]
  noise_sample.py band    [--verdicts DIR] [--sample-size N]

The sample (fixed; the same report is judged `--passes` times, each pass blind to the others):
  rcb       the delivered ResearchClawBench reports of baseline v1 (every run that ended `succeeded`; 5 of the 8 tasks)
  drb       DeepResearch Bench tasks 59, 27, 75, 63, 77, 3, 13, 53, 62, 100
  bixbench  the llm_verifier questions of the 12 capsules that answered (--bix-scope unsettled: every question score_bixbench.py leaves
            to a judge; a capsule that timed out has no answer to read twice)

`packets` writes <out>/<bench>/p<k>/<id>/ (default <BENCH_ROOT>/judge/packets-noise, the layout and the isolation rules of
judge_packets.py --repeats), and prints the verdict files the judges are to write:
  <verdicts>/<bench>.p<k>.jsonl   (default <BENCH_ROOT>/judge/noise), one line per packet — rcb {key, score}, drb {key, race},
  bixbench {key: "<item key>#<question id>", verdict}, exactly the lines the briefs in judge/briefs ask for.
Pass 1 may be the v1 verdict itself, copied to <bench>.p1.jsonl, but a fresh pass 1 is cleaner (the judge of a v1 verdict saw
the packets as they were then; a repeat must see the same packet bytes).

`band` reads those files and prints, per benchmark, the noise of ONE judging of ONE report:
  rcb / drb   `sd` = pooled within-report standard deviation over the passes (sqrt of the mean variance, n-1), in the benchmark's
              own units (0-100 for rcb, the RACE ratio for drb); `band95` = 1.96 * sd, the half-width inside which a second
              judging of the same report falls 95% of the time under a normal model; `meanAbsPairDiff` = mean |difference| of
              two passes of the same report (the "two judgings differ by about 4 points" figure); `range` = mean max-min.
  bixbench    `flipRate` = share of questions whose passes disagree, `passAccuracies` and their SD.
  `mdeJudgeOnly` = the smallest true difference between two arms that judge noise alone would hide on n reports, one judging
  each: 2.8 * sd * sqrt(2 / n) (two-sided 5%, 80% power); report-to-report variation and the model's own run-to-run variation are
  extra. It is printed for n = 8, 10, 20, 30, 40.
"""
import argparse
import json
import math
import os
import pathlib
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import judge_packets  # noqa: E402
import report  # noqa: E402

DRB_TASKS = ['59', '27', '75', '63', '77', '3', '13', '53', '62', '100']
FIELDS = {'rcb': 'score', 'drb': 'race'}
SAMPLE_SIZES = (8, 10, 20, 30, 40)


def root():
    return pathlib.Path(os.environ.get('BENCH_ROOT', '.')).resolve()


def rcb_delivered():
    """Ids of the ResearchClawBench tasks whose v1 run ended on its own (their report exists)."""
    ans = judge_packets.answers('v1-rcb')
    return [it['id'] for it in judge_packets.items('researchclawbench') if ans.get(it['key'], {}).get('status') == 'succeeded']


def bix_answered():
    """Ids of the BixBench capsules whose v1 run answered (a timed-out capsule has nothing for a judge to read twice)."""
    ans = judge_packets.answers('v1-bixbench')
    return [it['id'] for it in judge_packets.items('bixbench') if ans.get(it['key'], {}).get('status') == 'succeeded']


def build(out, passes, bix_scope='llm'):
    judge_packets.ROOT = root()
    report.ROOT = root()
    made = {}
    made['rcb'] = judge_packets.write_packets('rcb', out, repeats=passes, only=set(rcb_delivered()))
    made['drb'] = judge_packets.write_packets('drb', out, repeats=passes, only=set(DRB_TASKS))
    made['bixbench'] = judge_packets.write_packets('bixbench', out, repeats=passes, only=set(bix_answered()),
                                                   modes=None if bix_scope == 'unsettled' else {'llm_verifier'}, unsettled=bix_scope == 'unsettled')
    return made


def band_numbers(per_key, mde_sizes=SAMPLE_SIZES):
    """per_key: {key: [value per pass]} (numbers). Noise statistics of one judging of one report."""
    groups = {k: vs for k, vs in per_key.items() if len(vs) >= 2}
    if not groups:
        return {'reports': len(per_key), 'withRepeats': 0, 'sd': None}
    sd = report.pooled_sd(list(groups.values()))
    pair_diffs = [abs(a - b) for vs in groups.values() for i, a in enumerate(vs) for b in vs[i + 1:]]
    out = {'reports': len(per_key), 'withRepeats': len(groups), 'passes': max(len(v) for v in groups.values()), 'sd': sd, 'band95': 1.96 * sd,
           'meanAbsPairDiff': statistics.mean(pair_diffs), 'range': statistics.mean(max(vs) - min(vs) for vs in groups.values()),
           'mdeJudgeOnly': {str(n): 2.8 * sd * math.sqrt(2 / n) for n in mde_sizes}}
    return out


def band(verdict_dir):
    out = {}
    for bench, field in FIELDS.items():
        per_key = {}
        for f in sorted(verdict_dir.glob(f'{bench}.p[0-9]*.jsonl')):
            mine = {}
            for line in f.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    mine[row['key']] = float(row.get(field) or 0)
            for key, value in mine.items():
                per_key.setdefault(key, []).append(value)
        out[bench] = band_numbers(per_key) if per_key else {'status': 'no verdict files'}
    per_key, accuracies = {}, []
    for f in sorted(verdict_dir.glob('bixbench.p[0-9]*.jsonl')):
        mine = {}
        for line in f.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                mine[row['key']] = 1.0 if row.get('verdict') == 'correct' else 0.0
        accuracies.append(statistics.mean(mine.values()) if mine else 0.0)
        for key, value in mine.items():
            per_key.setdefault(key, []).append(value)
    multi = {k: vs for k, vs in per_key.items() if len(vs) >= 2}
    out['bixbench'] = ({'questions': len(per_key), 'withRepeats': len(multi), 'flipRate': sum(len(set(vs)) > 1 for vs in multi.values()) / len(multi),
                        'passAccuracies': accuracies, 'passAccuracySd': statistics.stdev(accuracies) if len(accuracies) > 1 else None}
                       if multi else {'status': 'no verdict files'})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='command', required=True)
    p = sub.add_parser('packets')
    p.add_argument('--passes', type=int, default=3)
    p.add_argument('--out')
    p.add_argument('--bix-scope', choices=['llm', 'unsettled'], default='llm')
    b = sub.add_parser('band')
    b.add_argument('--verdicts')
    a = ap.parse_args()
    if a.command == 'packets':
        out = pathlib.Path(a.out) if a.out else root() / 'judge' / 'packets-noise'
        made = build(out, a.passes, a.bix_scope)
        for bench, dirs in made.items():
            print(f'{bench}: {len(dirs) // max(1, a.passes)} packets x {a.passes} passes under {out / bench}/p<k>/')
        print(f'verdict files to write: {root() / "judge" / "noise"}/<bench>.p<k>.jsonl (k = 1..{a.passes})')
    else:
        d = pathlib.Path(a.verdicts) if a.verdicts else root() / 'judge' / 'noise'
        json.dump(band(d), sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write('\n')


if __name__ == '__main__':
    main()
