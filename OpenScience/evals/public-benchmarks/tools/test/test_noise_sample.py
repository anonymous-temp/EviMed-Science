"""Tests of tools/noise_sample.py: the sample, the packets of every pass, and the noise band.

Run: python3 -I -m unittest discover -s tools/test -p 'test_noise_sample.py'   (from evals/public-benchmarks)
"""
import json
import math
import os
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import judge_packets  # noqa: E402
import noise_sample as ns  # noqa: E402
import report  # noqa: E402
import judging_fixture as fx  # noqa: E402


class Noise(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='noise-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = fx.make_root(self.tmp.name)
        self.old = (os.environ.get('BENCH_ROOT'), judge_packets.ROOT, report.ROOT)
        os.environ['BENCH_ROOT'] = str(self.root)
        self.addCleanup(self.restore)

    def restore(self):
        if self.old[0] is None:
            os.environ.pop('BENCH_ROOT', None)
        else:
            os.environ['BENCH_ROOT'] = self.old[0]
        judge_packets.ROOT, report.ROOT = self.old[1], self.old[2]

    def test_sample_is_the_delivered_reports_the_named_tasks_and_the_answered_llm_questions(self):
        out = self.root / 'noise-packets'
        made = ns.build(out, 3)
        self.assertEqual({k: len(v) for k, v in made.items()}, {'rcb': 3, 'drb': 9, 'bixbench': 3})
        self.assertEqual(sorted(p.name for p in (out / 'rcb' / 'p1').iterdir()), ['Life_001'])        # Life_000 timed out: not delivered
        self.assertEqual(sorted(p.name for p in (out / 'drb' / 'p2').iterdir()), ['27', '3', '59'])   # the named tasks that exist here
        self.assertEqual(sorted(p.name for p in (out / 'bixbench' / 'p3').iterdir()), ['bix-1'])      # bix-2 timed out
        qs = json.loads((out / 'bixbench' / 'p3' / 'bix-1' / 'questions.json').read_text())['questions']
        self.assertEqual([q['qid'] for q in qs], ['bix-1-q2'])

    def test_every_pass_is_the_same_bytes_and_none_carries_a_verdict(self):
        out = self.root / 'noise-packets'
        ns.build(out, 3)
        for bench, name in (('drb', '59'), ('rcb', 'Life_001')):
            files = {k: sorted((p.name, p.read_bytes()) for p in (out / bench / f'p{k}' / name).iterdir() if p.is_file() and p.name != 'meta.json') for k in (1, 2, 3)}
            self.assertEqual(files[1], files[2])
            self.assertEqual(files[1], files[3])
        self.assertFalse(any('verdict' in p.name or p.suffix == '.jsonl' for p in out.rglob('*') if p.is_file()))

    def test_band_numbers_by_hand(self):
        # units: A [0.60, 0.64, 0.62] (var 0.0004), B [0.40, 0.40, 0.40] (var 0)
        b = ns.band_numbers({'A': {1: 0.60, 2: 0.64, 3: 0.62}, 'B': {1: 0.40, 2: 0.40, 3: 0.40}})
        self.assertAlmostEqual(b['noiseSd'], math.sqrt(0.0002))
        self.assertAlmostEqual(b['noiseBand95'], 1.96 * math.sqrt(0.0002))
        self.assertAlmostEqual(b['meanAbsPairDiff'], (0.04 + 0.02 + 0.02 + 0 + 0 + 0) / 6)
        self.assertAlmostEqual(b['range'], (0.04 + 0) / 2)
        self.assertAlmostEqual(b['mdeJudgeOnly']['10'], 2.8 * math.sqrt(0.0002) * math.sqrt(2 / 10))
        self.assertEqual((b['units'], b['withRepeats'], b['passes']), (2, 2, 3))

    def test_one_pass_has_no_band(self):
        self.assertIsNone(ns.band_numbers({'A': {1: 0.6}})['noiseSd'])

    def test_every_record_is_on_the_verdicts_0_1_scale_of_its_family_and_form(self):
        d = self.root / 'noise'
        fx.write_jsonl(d / 'rcb.p1.jsonl', [{'key': 'r/A', 'score': 60.0}, {'key': 'r/B', 'score': 20.0}])
        fx.write_jsonl(d / 'rcb.p2.jsonl', [{'key': 'r/A', 'score': 64.0}, {'key': 'r/B', 'score': 22.0}])
        fx.write_jsonl(d / 'drb.p1.jsonl', [{'key': 'drb/1', 'race': 0.5}])
        fx.write_jsonl(d / 'bixbench.p1.jsonl', [{'key': 'b/1#q', 'verdict': 'correct'}, {'key': 'b/1#r', 'verdict': 'correct'}, {'key': 'b/2#q', 'verdict': 'incorrect'}])
        fx.write_jsonl(d / 'bixbench.p2.jsonl', [{'key': 'b/1#q', 'verdict': 'correct'}, {'key': 'b/1#r', 'verdict': 'incorrect'}, {'key': 'b/2#q', 'verdict': 'incorrect'}])
        out = ns.band(d)
        self.assertEqual((out['schema'], out['scale']), ('judge-noise/2', 'verdict-0-1'))
        rcb = out['families']['rcb']['absolute']
        self.assertEqual((rcb['form'], rcb['scale'], rcb['unit']), ('absolute', 'verdict-0-1', 'report'))
        # rubric points are read as the lab reads them, score / 100: A [0.60, 0.64] and B [0.20, 0.22], variances 0.0008 and 0.0002
        self.assertAlmostEqual(rcb['noiseSd'], math.sqrt(0.0005))
        self.assertAlmostEqual(rcb['noiseBand95'], 1.96 * math.sqrt(0.0005))
        self.assertEqual((rcb['agreement'], rcb['comparisons'], rcb['ties']), (1.0, 1, 0))  # A above B in both passes
        self.assertIsNone(out['families']['drb']['absolute']['noiseSd'])  # one pass
        self.assertNotIn('pairwise', out['families']['drb'])
        # a capsule scores the share of its questions judged correct: b/1 [1.0, 0.5], b/2 [0.0, 0.0]
        bix = out['families']['bixbench']['absolute']
        self.assertEqual((bix['unit'], bix['questions'], bix['questionFlipRate']), ('capsule', 3, 1 / 3))
        self.assertAlmostEqual(bix['noiseSd'], math.sqrt((0.125 + 0) / 2))
        self.assertEqual(bix['agreement'], 1.0)
        self.assertEqual(ns.band(self.root / 'nothing')['families'], {})

    def test_absolute_agreement_is_the_order_of_two_units_kept_by_a_second_judging_and_a_constant_judge_has_none(self):
        # three reports, two passes: (A, B) and (A, C) keep their order, (B, C) is reversed
        per_unit = {'A': {1: 0.9, 2: 0.8}, 'B': {1: 0.5, 2: 0.3}, 'C': {1: 0.4, 2: 0.35}}
        self.assertEqual(ns.absolute_agreement(per_unit), (2 / 3, 3, 0))
        # a judge that gives every report the same score orders nothing: every comparison is a tie, and there is no agreement to qualify on
        self.assertEqual(ns.absolute_agreement({u: {1: 0.5, 2: 0.5, 3: 0.5} for u in 'ABC'}), (None, 0, 9))

    def test_pairwise_agreement_is_the_sign_across_swapped_orders_and_a_tie_only_judge_has_none(self):
        import drb_pairwise as dp
        criteria = dp.synthetic_criteria()
        crit = self.root / 'c.json'
        crit.write_text(json.dumps(criteria))
        (self.root / 'a.md').write_text('a')
        (self.root / 'b.md').write_text('b')

        def measured(toward_a, name):
            out = self.root / name
            order, _ = dp.build_packets('7', self.root / 'a.md', self.root / 'b.md', 'baseline', 'cand', 4, 11, out, crit)
            lines = []
            for k, v in order['tasks']['7']['passes'].items():
                pref = toward_a[int(k) - 1] if v['first'] == 'a' else -toward_a[int(k) - 1]
                lines.append({'key': f'drb-pair/7/p{k}', 'scores': {dim: [{'idx': i, 'pref': pref} for i in range(len(lst))] for dim, lst in criteria['criterions'].items()}})
            fx.write_jsonl(out / 'v.jsonl', lines)
            return ns.band(self.root / 'none', [(out / 'order.json', [out / 'v.jsonl'])])['families']['drb']['pairwise']

        # couples (1, 2) and (3, 4): the first agrees (A better twice), the second does not
        record = measured((2, 1, 1, -1), 'p1')
        self.assertEqual((record['form'], record['scale'], record['unit'], record['passes']), ('pairwise', 'verdict-0-1', 'comparison', 4))
        self.assertEqual((record['agreement'], record['comparisons'], record['ties']), (0.5, 2, 0))
        shares = [(3 + s) / 6 for s in (2, 1, 1, -1)]
        mean = sum(shares) / 4
        self.assertAlmostEqual(record['noiseSd'], math.sqrt(sum((x - mean) ** 2 for x in shares) / 3))
        # a judge that only ever says "equal" has no agreement (drb_pairwise counted 0 == 0 as agreeing: 1.0)
        tie = measured((0, 0, 0, 0), 'p2')
        self.assertEqual((tie['agreement'], tie['comparisons'], tie['ties']), (None, 0, 2))
        self.assertEqual(tie['noiseSd'], 0.0)


if __name__ == '__main__':
    unittest.main()
