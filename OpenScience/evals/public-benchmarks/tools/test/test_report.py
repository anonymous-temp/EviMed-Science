"""Tests of tools/report.py: strict vs at-cap figures and repeated judging (mean, pooled SD).

Run: python3 -I -m unittest discover -s tools/test -p 'test_report.py'   (from evals/public-benchmarks)
"""
import json
import math
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import report  # noqa: E402
import judging_fixture as fx  # noqa: E402


class Report(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='report-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self._root = report.ROOT
        report.ROOT = self.root
        self.addCleanup(setattr, report, 'ROOT', self._root)

    def answers(self, queue, rows):
        fx.write_jsonl(self.root / 'answers' / f'{queue}.jsonl', rows)

    def verdicts(self, name, rows):
        fx.write_jsonl(self.root / 'judge' / name, rows)

    ROWS = [
        {'key': 'b/A', 'status': 'succeeded', 'cost': 1.0, 'durationMs': 60000, 'delivery': 'complete', 'deliveredWithinCap': True, 'firstReportAtMs': 20000},
        {'key': 'b/B', 'status': 'timeout', 'cost': 2.0, 'durationMs': 120000, 'delivery': 'at-cap', 'deliveredWithinCap': False, 'firstReportAtMs': 50000},
        {'key': 'b/C', 'status': 'succeeded', 'cost': 1.0, 'durationMs': 90000, 'delivery': 'complete', 'deliveredWithinCap': True, 'firstReportAtMs': None},
    ]

    def test_strict_counts_a_timeout_as_zero_and_at_cap_counts_what_was_judged(self):
        self.answers('q', self.ROWS)
        self.verdicts('x.jsonl', [{'key': 'b/A', 'score': 60.0}, {'key': 'b/B', 'score': 40.0}, {'key': 'b/C', 'score': 20.0}])
        r = report.continuous('x', 'q', 'x.jsonl', 'score')
        self.assertAlmostEqual(r['score'], (60 + 0 + 20) / 3)
        self.assertAlmostEqual(r['scoreAtCap'], 40.0)
        self.assertEqual((r['n'], r['timeouts'], r['atCapReports'], r['passes']), (3, 1, 1, 1))
        self.assertNotIn('judgeSd', r)            # one pass has no noise estimate, and says nothing rather than 0
        self.assertAlmostEqual(r['deliveredWithinCapRate'], 2 / 3, places=3)
        self.assertEqual(r['medianFirstReportSeconds'], 35.0)

    def test_without_a_judged_timeout_the_two_figures_are_one(self):
        self.answers('q', self.ROWS)
        self.verdicts('x.jsonl', [{'key': 'b/A', 'score': 60.0}, {'key': 'b/B', 'score': 0.0, 'judged': False}, {'key': 'b/C', 'score': 20.0}])
        r = report.continuous('x', 'q', 'x.jsonl', 'score')
        self.assertNotIn('scoreAtCap', r)

    def test_repeated_judging_mean_and_pooled_sd(self):
        self.answers('q', self.ROWS)
        self.verdicts('x.jsonl', [{'key': 'b/A', 'score': 60.0}, {'key': 'b/B', 'score': 40.0}, {'key': 'b/C', 'score': 20.0}])
        self.verdicts('x.p2.jsonl', [{'key': 'b/A', 'score': 64.0}, {'key': 'b/B', 'score': 40.0}, {'key': 'b/C', 'score': 26.0}])
        r = report.continuous('x', 'q', 'x.jsonl', 'score')
        # item means 62, 40, 23; variances (n-1) 8, 0, 18
        self.assertEqual(r['passes'], 2)
        self.assertAlmostEqual(r['judgeSd'], math.sqrt((8 + 0 + 18) / 3))
        self.assertAlmostEqual(r['score'], (62 + 0 + 23) / 3)
        self.assertAlmostEqual(r['scoreAtCap'], (62 + 40 + 23) / 3)

    def test_pass_files_are_ordered_numerically_and_a_later_line_replaces_an_earlier_one(self):
        for n in (2, 10, 3):
            self.verdicts(f'x.p{n}.jsonl', [{'key': 'k', 'score': float(n)}])
        self.verdicts('x.jsonl', [{'key': 'k', 'score': 1.0}, {'key': 'k', 'score': 5.0}])
        self.verdicts('xy.p2.jsonl', [{'key': 'k', 'score': 99.0}])
        names = [p.name for p in report.pass_files('x.jsonl')]
        self.assertEqual(names, ['x.jsonl', 'x.p2.jsonl', 'x.p3.jsonl', 'x.p10.jsonl'])
        self.assertEqual([row['score'] for row in report.read_passes('x.jsonl')['k']], [5.0, 2.0, 3.0, 10.0])

    def test_proportion_flip_rate_and_per_question_share(self):
        self.answers('q', [{'key': 'bix/1', 'status': 'succeeded'}, {'key': 'bix/2', 'status': 'timeout'}])
        self.verdicts('p.jsonl', [{'key': 'bix/1#a', 'verdict': 'correct'}, {'key': 'bix/1#b', 'verdict': 'incorrect'}, {'key': 'bix/2#a', 'verdict': 'incorrect'}])
        self.verdicts('p.p2.jsonl', [{'key': 'bix/1#a', 'verdict': 'correct'}, {'key': 'bix/1#b', 'verdict': 'correct'}, {'key': 'bix/2#a', 'verdict': 'correct'}])
        r = report.proportion('p', 'q', 'p.jsonl')
        # per-question share correct: a 1.0, b 0.5, bix/2#a 0.5 (a timeout: 0 strictly)
        self.assertAlmostEqual(r['score'], 1.5 / 3)
        self.assertAlmostEqual(r['scoreAtCap'], 2.0 / 3)
        self.assertAlmostEqual(r['flipRate'], 2 / 3)
        self.assertAlmostEqual(r['judgeSd'], math.sqrt((0 + 0.5 + 0.5) / 3))

    def test_single_pass_proportion_matches_the_old_figures(self):
        self.answers('q', [{'key': 'bix/1', 'status': 'succeeded'}])
        self.verdicts('p.jsonl', [{'key': 'bix/1#a', 'verdict': 'correct'}, {'key': 'bix/1#b', 'verdict': 'incorrect'}])
        r = report.proportion('p', 'q', 'p.jsonl')
        lo, hi = report.wilson(1, 2)
        self.assertEqual((r['score'], r['k'], r['n'], r['ci95']), (0.5, 1, 2, [lo, hi]))
        self.assertNotIn('judgeSd', r)

    def test_not_scored_without_a_verdict_file(self):
        self.assertEqual(report.continuous('x', 'q', 'missing.jsonl', 'score'), {'bench': 'x', 'status': 'not scored'})


if __name__ == '__main__':
    unittest.main()
