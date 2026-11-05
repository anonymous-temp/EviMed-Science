#!/usr/bin/env python3
"""Judge-noise sample (phase 0.4): repeat packets of reports already judged once, and the judge's measurement once they are judged again.

  noise_sample.py packets [--passes 3] [--out DIR] [--bix-scope llm|unsettled]
  noise_sample.py band    [--verdicts DIR] [--pairwise ORDER VERDICTS [VERDICTS ...]]... [--out FILE]

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

`band` reads those files (and, with --pairwise, a drb_pairwise.py order file and the pairwise verdict lines judged over it, swapped couples
of passes; repeatable) and writes the judge's measurement, `judge-noise/2` (stdout or --out), per judged family and per form:
  {"schema": "judge-noise/2", "scale": "verdict-0-1", "families": {"rcb": {"absolute": R}, "drb": {"absolute": R, "pairwise": R}, "bixbench": {"absolute": R}, "frontier-source": {"absolute": R}}}
Every number of a record R is on the scale of the verdict the lab scores (export_harness_arms.py), 0 to 1, of the unit a verdict scores:
  rcb absolute       a report, score / 100 (the percent dialect)
  drb absolute       a report, the RACE ratio (race)
  bixbench absolute  a capsule, the share of its questions judged correct (the questions dialect), over the questions it has a verdict for in
                     every pass that judged it (a capsule in one pass only has no repeat)
  frontier-source absolute  a rewrite, the share of its fidelity questions judged correct (module_arms.mjs packets, one question: the questions dialect). Not part of the
                     fixed sample above: its verdict files are what `claude_judge.py remap --dialect questions --bench-key frontier-source --out <verdicts>/frontier-source` writes
  drb pairwise       a comparison (one task of an order file: a candidate's report against the baseline's), (3 + s) / 6 per pass with s the
                     criterion-weighted preference of the pass (drb_pairwise.aggregate `perPass.total`, toward the order file's arm a; the
                     band and the agreement do not depend on which arm it leans toward)
R = {form, scale: "verdict-0-1", unit, units, withRepeats, passes, noiseSd, noiseBand95, meanAbsPairDiff, range, mdeJudgeOnly, agreement,
     comparisons, ties} (bixbench adds questions and questionFlipRate, the share of repeated questions whose passes disagree):
  noiseSd        pooled within-unit standard deviation over the passes (sqrt of the mean variance, n-1): the noise of ONE judging of one unit
  noiseBand95    1.96 * noiseSd, the half-width inside which a second judging of the same unit falls 95% of the time under a normal model;
                 the registration's rule (register_round.py) reads it as noiseBand95 / sqrt(passes) for the verdict the lab uses, the mean of
                 the registered passes, against the margin
  meanAbsPairDiff / range   the mean |difference| of two passes of one unit, and the mean max - min
  mdeJudgeOnly   2.8 * noiseSd * sqrt(2 / n) for n = 8, 10, 20, 30, 40: the smallest true difference between two arms judge noise alone would
                 hide on n units judged once each (two-sided 5%, 80% power); unit-to-unit and run-to-run variation are extra
  agreement      sign agreement between repeated judgings, ties excluded, on the scored unit:
                 pairwise  over every complete swapped couple of passes (2j-1, 2j) of a comparison: the two passes' preferences (s, the same
                           orientation) agree when they have the same strict sign; a couple in which either pass states no preference (s = 0)
                           is a tie and is excluded. agreement = agreeing couples / couples without a tie.
                 absolute  over every pair of passes (p, q) and every pair of units (u, v) that both passes judged: the two judgings order the
                           two units the same way when sign(score_p(u) - score_p(v)) = sign(score_q(u) - score_q(v)); a comparison in which
                           either pass scores the two units equal is a tie and is excluded. agreement = same-order comparisons / comparisons
                           without a tie. It asks of an absolute judge what the pairwise rule asks of a pairwise one: would a second judging
                           rank two reports the same way.
                 `comparisons` counts the comparisons without a tie, `ties` the excluded ones. With no comparison free of a tie the agreement
                 is null — a judge that never states a preference (a tie-only or constant judge) has no agreement and never qualifies.
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


SCALE = 'verdict-0-1'
SCHEMA = 'judge-noise/2'


def sign(x):
    return (x > 0) - (x < 0)


def band_numbers(per_unit, mde_sizes=SAMPLE_SIZES):
    """per_unit: {unit: {pass: score on the 0-1 verdict scale}}. The noise statistics of one judging of one unit (no agreement)."""
    groups = {u: [v for _, v in sorted(by_pass.items())] for u, by_pass in per_unit.items() if len(by_pass) >= 2}
    if not groups:
        return {'units': len(per_unit), 'withRepeats': 0, 'noiseSd': None, 'noiseBand95': None}
    sd = report.pooled_sd(list(groups.values()))
    pair_diffs = [abs(a - b) for vs in groups.values() for i, a in enumerate(vs) for b in vs[i + 1:]]
    return {'units': len(per_unit), 'withRepeats': len(groups), 'passes': max(len(v) for v in groups.values()), 'noiseSd': sd, 'noiseBand95': 1.96 * sd,
            'meanAbsPairDiff': statistics.mean(pair_diffs), 'range': statistics.mean(max(vs) - min(vs) for vs in groups.values()),
            'mdeJudgeOnly': {str(n): 2.8 * sd * math.sqrt(2 / n) for n in mde_sizes}}


def agreement_of(compared):
    """(agreement, comparisons without a tie, ties) of [(a, b)] pairs of signed values: a pair agrees when sign(a) = sign(b) != 0, a pair with a 0 is a tie."""
    decided = [(a, b) for a, b in compared if sign(a) and sign(b)]
    return (sum(sign(a) == sign(b) for a, b in decided) / len(decided) if decided else None), len(decided), len(compared) - len(decided)


def absolute_agreement(per_unit):
    """Sign agreement of every pair of units across every pair of passes that judged both (see the module docstring)."""
    passes = sorted({k for by_pass in per_unit.values() for k in by_pass})
    units = sorted(per_unit)
    compared = []
    for i, p in enumerate(passes):
        for q in passes[i + 1:]:
            both = [u for u in units if p in per_unit[u] and q in per_unit[u]]
            compared += [(per_unit[u][p] - per_unit[v][p], per_unit[u][q] - per_unit[v][q]) for j, u in enumerate(both) for v in both[j + 1:]]
    return agreement_of(compared)


def record(form, unit, per_unit, agreement):
    """One family's record of one form."""
    value, comparisons, ties = agreement
    return {'form': form, 'scale': SCALE, 'unit': unit, **band_numbers(per_unit), 'agreement': value, 'comparisons': comparisons, 'ties': ties}


def read_lines(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def pass_files(verdict_dir, bench):
    """{pass number: file} of <bench>.p<k>.jsonl."""
    found = {}
    for f in verdict_dir.glob(f'{bench}.p[0-9]*.jsonl'):
        k = f.name[len(bench) + 2:-len('.jsonl')]
        if k.isdigit():
            found[int(k)] = f
    return dict(sorted(found.items()))


def absolute_units(verdict_dir, bench, field, scale):
    """{unit: {pass: score / scale}} of the rcb / drb verdict files."""
    per_unit = {}
    for k, f in pass_files(verdict_dir, bench).items():
        for row in read_lines(f):
            per_unit.setdefault(row['key'], {})[k] = float(row.get(field) or 0) / scale
    return per_unit


def question_units(verdict_dir, bench):
    """({unit: {pass: share correct}}, questions, question flip rate) of a family judged by questions: the share over the questions a unit (a capsule, a rewrite) has a verdict for in
    every pass that judged it. The question id is what follows the last `#`: a remapped run key can hold one of its own (`#r<repeat>`)."""
    verdicts = {}  # (capsule, question) -> {pass: 1.0 | 0.0}
    for k, f in pass_files(verdict_dir, bench).items():
        for row in read_lines(f):
            capsule, _, question = row['key'].rpartition('#')
            verdicts.setdefault((capsule, question), {})[k] = 1.0 if row.get('verdict') == 'correct' else 0.0
    by_capsule = {}
    for (capsule, question), by_pass in verdicts.items():
        by_capsule.setdefault(capsule, {})[question] = by_pass
    per_unit = {}
    for capsule, questions in by_capsule.items():
        passes = sorted({k for by_pass in questions.values() for k in by_pass})
        kept = [q for q, by_pass in questions.items() if all(k in by_pass for k in passes)]
        if kept:
            per_unit[capsule] = {k: statistics.mean(questions[q][k] for q in kept) for k in passes}
    repeated = [by_pass for by_pass in verdicts.values() if len(by_pass) >= 2]
    flip = sum(len(set(by_pass.values())) > 1 for by_pass in repeated) / len(repeated) if repeated else None
    return per_unit, len(verdicts), flip


def pairwise_units(pairs):
    """({comparison: {pass: share}}, [(s of pass 2j-1, s of pass 2j)]) of drb_pairwise order files and their verdict lines."""
    import drb_pairwise  # noqa: E402 (beside this file)
    per_unit, couples, excluded = {}, [], []
    for order_file, verdict_files in pairs:
        result = drb_pairwise.aggregate(order_file, verdict_files)
        excluded += result['excluded']
        for task in result['tasks']:
            totals = {int(k): v['total'] for k, v in task['perPass'].items()}
            per_unit[f'{pathlib.Path(order_file).parent.name}/{task["task"]}'] = {k: (3 + s) / 6 for k, s in totals.items()}
            couples += [(totals[k], totals[k + 1]) for k in totals if k % 2 == 1 and k + 1 in totals]
    if excluded:
        raise SystemExit('noise_sample: pairwise tasks excluded by drb_pairwise.aggregate: ' + '; '.join(e['reason'] for e in excluded[:5]))
    return per_unit, couples


def band(verdict_dir, pairwise=()):
    """The measurement, `judge-noise/2`: per family and form, on the 0-1 scale of the verdict the lab scores (module docstring)."""
    families = {}
    for bench, field, scale, unit in (('rcb', 'score', 100.0, 'report'), ('drb', 'race', 1.0, 'report')):
        per_unit = absolute_units(verdict_dir, bench, field, scale)
        if per_unit:
            families.setdefault(bench, {})['absolute'] = record('absolute', unit, per_unit, absolute_agreement(per_unit))
    for bench, unit in (('bixbench', 'capsule'), ('frontier-source', 'rewrite')):
        per_unit, questions, flip = question_units(verdict_dir, bench)
        if per_unit:
            families[bench] = {'absolute': {**record('absolute', unit, per_unit, absolute_agreement(per_unit)), 'questions': questions, 'questionFlipRate': flip}}
    if pairwise:
        per_unit, couples = pairwise_units(pairwise)
        families.setdefault('drb', {})['pairwise'] = record('pairwise', 'comparison', per_unit, agreement_of(couples))
    return {'schema': SCHEMA, 'scale': SCALE, 'families': families}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='command', required=True)
    p = sub.add_parser('packets')
    p.add_argument('--passes', type=int, default=3)
    p.add_argument('--out')
    p.add_argument('--bix-scope', choices=['llm', 'unsettled'], default='llm')
    b = sub.add_parser('band')
    b.add_argument('--verdicts')
    b.add_argument('--pairwise', nargs='+', action='append', default=[], metavar='FILE',
                   help='a drb_pairwise.py order.json and the pairwise verdict files judged over it (repeatable)')
    b.add_argument('--out')
    a = ap.parse_args()
    if a.command == 'packets':
        out = pathlib.Path(a.out) if a.out else root() / 'judge' / 'packets-noise'
        made = build(out, a.passes, a.bix_scope)
        for bench, dirs in made.items():
            print(f'{bench}: {len(dirs) // max(1, a.passes)} packets x {a.passes} passes under {out / bench}/p<k>/')
        print(f'verdict files to write: {root() / "judge" / "noise"}/<bench>.p<k>.jsonl (k = 1..{a.passes})')
    else:
        if any(len(group) < 2 for group in a.pairwise):
            ap.error('--pairwise takes an order file and at least one verdict file')
        d = pathlib.Path(a.verdicts) if a.verdicts else root() / 'judge' / 'noise'
        text = json.dumps(band(d, [(group[0], group[1:]) for group in a.pairwise]), ensure_ascii=False, indent=1) + '\n'
        if a.out:
            pathlib.Path(a.out).write_text(text, encoding='utf-8')
        else:
            sys.stdout.write(text)


if __name__ == '__main__':
    main()
