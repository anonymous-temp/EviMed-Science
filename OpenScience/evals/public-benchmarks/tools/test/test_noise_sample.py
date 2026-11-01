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
        # reports: A [60, 64, 62] (var 4), B [40, 40, 40] (var 0)
        b = ns.band_numbers({'A': [60.0, 64.0, 62.0], 'B': [40.0, 40.0, 40.0]})
        self.assertAlmostEqual(b['sd'], math.sqrt(2.0))
        self.assertAlmostEqual(b['band95'], 1.96 * math.sqrt(2.0))
        self.assertAlmostEqual(b['meanAbsPairDiff'], (4 + 2 + 2 + 0 + 0 + 0) / 6)
        self.assertAlmostEqual(b['range'], (4 + 0) / 2)
        self.assertAlmostEqual(b['mdeJudgeOnly']['10'], 2.8 * math.sqrt(2.0) * math.sqrt(2 / 10))
        self.assertEqual((b['reports'], b['withRepeats'], b['passes']), (2, 2, 3))

    def test_one_pass_has_no_band(self):
        self.assertIsNone(ns.band_numbers({'A': [60.0]})['sd'])

    def test_band_reads_the_verdict_files(self):
        d = self.root / 'noise'
        fx.write_jsonl(d / 'rcb.p1.jsonl', [{'key': 'r/A', 'score': 60.0}])
        fx.write_jsonl(d / 'rcb.p2.jsonl', [{'key': 'r/A', 'score': 64.0}])
        fx.write_jsonl(d / 'drb.p1.jsonl', [{'key': 'drb/1', 'race': 0.5}])
        fx.write_jsonl(d / 'bixbench.p1.jsonl', [{'key': 'b/1#q', 'verdict': 'correct'}, {'key': 'b/1#r', 'verdict': 'correct'}])
        fx.write_jsonl(d / 'bixbench.p2.jsonl', [{'key': 'b/1#q', 'verdict': 'correct'}, {'key': 'b/1#r', 'verdict': 'incorrect'}])
        out = ns.band(d)
        self.assertAlmostEqual(out['rcb']['sd'], math.sqrt(8))
        self.assertIsNone(out['drb']['sd'])
        self.assertEqual(out['bixbench']['flipRate'], 0.5)
        self.assertEqual(out['bixbench']['passAccuracies'], [1.0, 0.5])
        self.assertEqual(ns.band(self.root / 'nothing')['rcb'], {'status': 'no verdict files'})


if __name__ == '__main__':
    unittest.main()
