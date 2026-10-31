"""Tests of tools/drb_pairwise.py on a tiny synthetic fixture (no real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_drb_pairwise.py'   (from evals/public-benchmarks)
"""
import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import drb_pairwise as dp  # noqa: E402

ARM_A, ARM_B = 'armZZ', 'armQQ'


def criteria():
    return dp.synthetic_criteria()  # comprehensiveness [0.5, 0.5] x 0.6, insight [1.0] x 0.4


class Fixture:
    def __init__(self, test):
        self.tmp = tempfile.TemporaryDirectory(prefix='drb-pair-test-')
        test.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        (self.dir / 'c.json').write_text(json.dumps(criteria()))
        (self.dir / 'a.md').write_text('# Report one\nbody of the first arm')
        (self.dir / 'b.md').write_text('# Report two\nbody of the second arm, longer text')
        self.n = 0

    def packets(self, task='7', passes=2, seed=11, out=None):
        out = out or self.dir / 'out'
        order, out = dp.build_packets(task, self.dir / 'a.md', self.dir / 'b.md', ARM_A, ARM_B, passes, seed, out, self.dir / 'c.json')
        return order, pathlib.Path(out)

    def verdicts(self, rows):
        self.n += 1
        path = self.dir / f'v{self.n}.jsonl'
        path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        return path


def verdict_line(task, k, comp0, comp1, insight):
    return {'key': f'drb-pair/{task}/p{k}', 'scores': {'comprehensiveness': [{'idx': 0, 'pref': comp0}, {'idx': 1, 'pref': comp1}], 'insight': [{'idx': 0, 'pref': insight}]}}


def judge(order, task, toward_a=None, shown_first=None):
    """Verdict lines of a judge. `toward_a` = (c0, c1, i): preference for arm A in every pass (true preference).
    `shown_first` = (c0, c1, i): preference for whichever report is shown first in every pass (pure position bias)."""
    rows = []
    for k, v in sorted(order['tasks'][task]['passes'].items(), key=lambda kv: int(kv[0])):
        if toward_a is not None:
            sign = 1 if v['first'] == 'a' else -1
            rows.append(verdict_line(task, int(k), *(sign * x for x in toward_a)))
        else:
            rows.append(verdict_line(task, int(k), *shown_first))
    return rows


class PacketTests(unittest.TestCase):
    def test_packets_hide_arms_and_order(self):
        fx = Fixture(self)
        order, out = fx.packets()
        for p in (out / '7').rglob('*'):
            if p.is_file() and p.name not in ('report_1.md', 'report_2.md'):
                text = p.read_text()
                self.assertNotIn(ARM_A, text, p)
                self.assertNotIn(ARM_B, text, p)
        for k in (1, 2):
            d = out / '7' / f'pass{k}'
            self.assertEqual(sorted(f.name for f in d.iterdir()), ['criteria.json', 'meta.json', 'report_1.md', 'report_2.md', 'task.txt'])
            self.assertEqual(json.loads((d / 'meta.json').read_text()), {'key': f'drb-pair/7/p{k}', 'criteria': 3})
            self.assertEqual((d / 'task.txt').read_text(), 'Write about X.')
        # the order is in the separate file, and the reports sit where it says
        self.assertTrue((out / 'order.json').exists())
        for k in (1, 2):
            first = order['tasks']['7']['passes'][str(k)]['first']
            expected = (fx.dir / ('a.md' if first == 'a' else 'b.md')).read_text()
            self.assertEqual((out / '7' / f'pass{k}' / 'report_1.md').read_text(), expected)
        saved = json.loads((out / 'order.json').read_text())
        self.assertEqual(saved['arms'], {'a': ARM_A, 'b': ARM_B})
        self.assertEqual(saved['seed'], 11)

    def test_order_is_deterministic_and_swapped(self):
        fx = Fixture(self)
        o1, _ = fx.packets(passes=4, seed=3, out=fx.dir / 'o1')
        o2, _ = fx.packets(passes=4, seed=3, out=fx.dir / 'o2')
        self.assertEqual(o1['tasks']['7']['passes'], o2['tasks']['7']['passes'])
        passes = {int(k): v['first'] for k, v in o1['tasks']['7']['passes'].items()}
        self.assertEqual(sorted(passes), [1, 2, 3, 4])
        self.assertNotEqual(passes[1], passes[2])
        self.assertNotEqual(passes[3], passes[4])
        # the hash decides pass 1 and 3; over many tasks and seeds both orders occur
        seen = {dp.position_first(s, t, 1) for s in range(5) for t in range(20)}
        self.assertEqual(seen, {'a', 'b'})
        self.assertEqual(dp.position_first(5, '9', 2), 'b' if dp.position_first(5, '9', 1) == 'a' else 'a')

    def test_odd_or_single_pass_count_refused(self):
        fx = Fixture(self)
        for passes in (1, 3):
            with self.assertRaises(dp.PairwiseError):
                fx.packets(passes=passes)

    def test_another_seed_is_refused_in_the_same_out(self):
        fx = Fixture(self)
        fx.packets(task='7', seed=1)
        with self.assertRaises(dp.PairwiseError):
            fx.packets(task='8', seed=2)

    def test_two_tasks_share_one_order_file(self):
        fx = Fixture(self)
        fx.packets(task='7')
        fx.packets(task='8')
        self.assertEqual(sorted(json.loads((fx.dir / 'out' / 'order.json').read_text())['tasks']), ['7', '8'])

    def test_read_report_from_result_folder(self):
        fx = Fixture(self)
        run = fx.dir / 'run'
        (run / 'files' / 'report').mkdir(parents=True)
        (run / 'files' / 'report' / 'report.md').write_text('the report')
        (run / 'answer.md').write_text('only the reply')
        self.assertEqual(dp.read_report(run)[0], 'the report')
        late = fx.dir / 'late'
        (late / 'files' / 'drafts').mkdir(parents=True)
        (late / 'files' / 'drafts' / 'x.txt').write_text('draft')
        (late / 'result.json').write_text(json.dumps({'lastReport': {'path': 'drafts/x.txt'}}))
        (late / 'answer.md').write_text('reply')
        self.assertEqual(dp.read_report(late)[0], 'draft')
        reply = fx.dir / 'reply'
        reply.mkdir()
        (reply / 'answer.md').write_text('reply only')
        self.assertEqual(dp.read_report(reply)[0], 'reply only')
        empty = fx.dir / 'empty'
        empty.mkdir()
        self.assertEqual(dp.read_report(empty)[0], '')   # an empty folder reads empty, not an error
        with self.assertRaises(dp.PairwiseError):
            dp.read_report(fx.dir / 'missing.md')


class AggregateTests(unittest.TestCase):
    def test_true_preference_hand_computed(self):
        fx = Fixture(self)
        order, out = fx.packets()
        # A better by 2, 1 on the comprehensiveness criteria and 3 on insight: comp = 0.5*2+0.5*1 = 1.5; total = 0.6*1.5 + 0.4*3 = 2.1
        v = fx.verdicts(judge(order, '7', toward_a=(2, 1, 3)))
        result = dp.aggregate(out / 'order.json', [v])
        task = result['tasks'][0]
        self.assertEqual(task['dimensions'], {'comprehensiveness': 1.5, 'insight': 3.0})
        self.assertEqual(task['total'], 2.1)
        self.assertEqual(task['positionBias'], 0.0)
        self.assertEqual(task['agreement'], 1.0)
        self.assertEqual(task['contradiction'], 0.0)
        self.assertEqual(task['verdict'], 'A')
        self.assertEqual(result['excluded'], [])
        s = result['summary']
        self.assertEqual((s['armA'], s['armB'], s['tasks'], s['win'], s['tie'], s['loss']), (ARM_A, ARM_B, 1, 1, 0, 0))
        self.assertEqual(s['total']['mean'], 2.1)

    def test_true_preference_for_b_is_negative(self):
        fx = Fixture(self)
        order, out = fx.packets()
        result = dp.aggregate(out / 'order.json', [fx.verdicts(judge(order, '7', toward_a=(-3, -3, -3)))])
        self.assertEqual(result['tasks'][0]['total'], -3.0)
        self.assertEqual(result['summary']['loss'], 1)

    def test_pure_position_bias(self):
        fx = Fixture(self)
        order, out = fx.packets()
        # the judge always prefers whichever report comes first, by 1 on every criterion
        result = dp.aggregate(out / 'order.json', [fx.verdicts(judge(order, '7', shown_first=(1, 1, 1)))])
        task = result['tasks'][0]
        self.assertEqual(task['positionBias'], 1.0)
        self.assertEqual(task['total'], 0.0)
        self.assertEqual(task['agreement'], 0.0)
        self.assertEqual(task['contradiction'], 1.0)
        self.assertEqual(task['verdict'], 'tie')
        self.assertEqual(result['summary']['positionBias']['mean'], 1.0)

    def test_bias_and_preference_together_over_four_passes(self):
        fx = Fixture(self)
        order, out = fx.packets(passes=4, seed=5)
        rows = []
        for k, v in order['tasks']['7']['passes'].items():
            shown = 2 if v['first'] == 'a' else -2     # a true preference for A of 2, as the judge sees it in this order ...
            rows.append(verdict_line('7', int(k), *(shown + 1 for _ in range(3))))   # ... plus 1 for whichever report is first
        result = dp.aggregate(out / 'order.json', [fx.verdicts(rows)])
        task = result['tasks'][0]
        self.assertEqual(task['passes'], 4)
        self.assertEqual(task['total'], 2.0)
        self.assertEqual(task['positionBias'], 1.0)
        self.assertEqual(task['agreement'], 1.0)      # signed toward A the two orders read +3 and +1: same sign

    def test_arms_option_renames_only_the_display(self):
        fx = Fixture(self)
        order, out = fx.packets()
        result = dp.aggregate(out / 'order.json', [fx.verdicts(judge(order, '7', toward_a=(1, 1, 1)))], ['base', 'skill'])
        self.assertEqual((result['summary']['armA'], result['summary']['armB']), ('base', 'skill'))
        self.assertEqual(result['tasks'][0]['total'], 1.0)

    def test_win_tie_loss_dead_zone(self):
        fx = Fixture(self)
        order, out = None, None
        for task in ('1', '2', '3', '4', '5'):
            order, out = fx.packets(task=task)
        order, out = fx.packets(task='6', passes=4)
        # the same integer preference on every criterion, per pass toward A: the task total is the mean over its passes
        plan = {'1': (1, 0), '2': (0, 0), '3': (-1, 0), '4': (1, 1), '5': (-1, -1), '6': (1, 0, 0, 0)}   # toward A, per pass
        rows = []
        for task, per_pass in plan.items():
            for k, v in order['tasks'][task]['passes'].items():
                toward_a = per_pass[int(k) - 1]
                p = toward_a if v['first'] == 'a' else -toward_a
                rows.append(verdict_line(task, int(k), p, p, p))
        result = dp.aggregate(out / 'order.json', [fx.verdicts(rows)])
        verdicts = {t['task']: (t['total'], t['verdict']) for t in result['tasks']}
        self.assertEqual(verdicts, {'1': (0.5, 'A'), '2': (0.0, 'tie'), '3': (-0.5, 'B'), '4': (1.0, 'A'), '5': (-1.0, 'B'), '6': (0.25, 'tie')})   # exactly +0.25 is inside the dead zone
        s = result['summary']
        self.assertEqual((s['win'], s['tie'], s['loss']), (2, 2, 2))
        self.assertAlmostEqual(s['total']['mean'], 0.25 / 6)

    def test_missing_pass_excludes_the_task_and_is_listed(self):
        fx = Fixture(self)
        order, out = fx.packets(task='7')
        order, out = fx.packets(task='8')
        rows = judge(order, '8', toward_a=(1, 1, 1)) + judge(order, '7', toward_a=(2, 2, 2))[:1]
        result = dp.aggregate(out / 'order.json', [fx.verdicts(rows)])
        self.assertEqual([t['task'] for t in result['tasks']], ['8'])
        self.assertEqual(len(result['excluded']), 1)
        self.assertIn('task 7', result['excluded'][0]['reason'])
        self.assertIn('pass 2 has no verdict', result['excluded'][0]['reason'])
        self.assertEqual(result['summary']['total']['mean'], 1.0)   # the excluded task is not a zero
        self.assertEqual(result['summary']['excluded'], 1)

    def test_missing_extra_invalid_and_duplicate_criteria(self):
        fx = Fixture(self)
        order, out = fx.packets()
        good = judge(order, '7', toward_a=(1, 1, 1))

        def run(rows):
            return dp.aggregate(out / 'order.json', [fx.verdicts(rows)])

        missing = json.loads(json.dumps(good))
        missing[0]['scores']['insight'] = []
        self.assertIn('insight[0] missing', run(missing)['excluded'][0]['reason'])
        no_dim = json.loads(json.dumps(good))
        del no_dim[1]['scores']['insight']
        self.assertIn('dimension insight missing', run(no_dim)['excluded'][0]['reason'])
        out_of_scale = json.loads(json.dumps(good))
        out_of_scale[0]['scores']['comprehensiveness'][0]['pref'] = 4
        self.assertIn('not an integer in -3..3', run(out_of_scale)['excluded'][0]['reason'])
        fractional = json.loads(json.dumps(good))
        fractional[0]['scores']['comprehensiveness'][0]['pref'] = 1.5
        self.assertEqual(len(run(fractional)['excluded']), 1)
        extra = json.loads(json.dumps(good))
        extra[0]['scores']['insight'].append({'idx': 1, 'pref': 1})
        self.assertIn('does not list', run(extra)['excluded'][0]['reason'])
        twice = json.loads(json.dumps(good))
        twice[0]['scores']['insight'].append({'idx': 0, 'pref': 1})
        self.assertIn('scored twice', run(twice)['excluded'][0]['reason'])
        # the same verdict written twice is fine, two different ones are not
        self.assertEqual(len(run(good + good[:1])['tasks']), 1)
        changed = json.loads(json.dumps(good[0]))
        changed['scores']['insight'][0]['pref'] = -2
        self.assertIn('duplicate verdicts that differ', run(good + [changed])['excluded'][0]['reason'])
        self.assertEqual(run(good)['tasks'][0]['total'], 1.0)

    def test_summary_means_and_ci_are_deterministic(self):
        fx = Fixture(self)
        tasks = [str(n) for n in range(1, 8)]
        order = out = None
        for t in tasks:
            order, out = fx.packets(task=t)
        rows = []
        values = {'1': (1, 1, 0), '2': (2, 1, 1), '3': (0, 0, 1), '4': (3, 2, 1), '5': (-1, 0, 0), '6': (1, 2, 3), '7': (2, 2, 2)}
        for t in tasks:
            rows += judge(order, t, toward_a=values[t])
        v = fx.verdicts(rows)
        r1 = dp.aggregate(out / 'order.json', [v])
        r2 = dp.aggregate(out / 'order.json', [v])
        self.assertEqual(json.dumps(r1, sort_keys=True), json.dumps(r2, sort_keys=True))
        totals = [t['total'] for t in r1['tasks']]
        self.assertEqual(len(totals), 7)
        s = r1['summary']
        self.assertAlmostEqual(s['total']['mean'], sum(totals) / 7)
        lo, hi = s['total']['ci95']
        self.assertLessEqual(lo, s['total']['mean'])
        self.assertGreaterEqual(hi, s['total']['mean'])
        self.assertLessEqual(lo, hi)
        self.assertEqual(dp.bootstrap(totals), dp.bootstrap(totals))
        self.assertEqual(dp.bootstrap([]), [None, None])
        # per-dimension hand check for task 4: comp = (3+2)/2 = 2.5, insight = 1, total = .6*2.5+.4*1 = 1.9
        four = next(t for t in r1['tasks'] if t['task'] == '4')
        self.assertEqual((four['dimensions']['comprehensiveness'], four['dimensions']['insight'], four['total']), (2.5, 1.0, 1.9))

    def test_unmatched_verdict_keys_are_reported(self):
        fx = Fixture(self)
        order, out = fx.packets()
        rows = judge(order, '7', toward_a=(1, 1, 1)) + [verdict_line('99', 1, 1, 1, 1)]
        result = dp.aggregate(out / 'order.json', [fx.verdicts(rows)])
        self.assertEqual(result['unmatchedVerdictKeys'], ['drb-pair/99/p1'])

    def test_cli_round_trip(self):
        fx = Fixture(self)
        out = fx.dir / 'cli'
        with contextlib.redirect_stdout(io.StringIO()):
            code = dp.main(['packets', '--task', '7', '--a', str(fx.dir / 'a.md'), '--b', str(fx.dir / 'b.md'), '--arm-a', 'x', '--arm-b', 'y',
                            '--seed', '4', '--out', str(out), '--criteria', str(fx.dir / 'c.json')])
        self.assertEqual(code, 0)
        order = json.loads((out / 'order.json').read_text())
        v = fx.verdicts(judge(order, '7', toward_a=(1, 0, 2)))
        result_file = fx.dir / 'result.json'
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = dp.main(['aggregate', '--verdicts', str(v), '--order', str(out / 'order.json'), '--out', str(result_file)])
        self.assertEqual(code, 0)
        saved = json.loads(result_file.read_text())
        self.assertEqual(saved['summary']['armA'], 'x')
        self.assertIn('x vs y', err.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(dp.main(['packets', '--task', '7', '--a', str(fx.dir / 'nope.md'), '--b', str(fx.dir / 'b.md'), '--out', str(fx.dir / 'z'),
                                      '--criteria', str(fx.dir / 'c.json')]), 2)

    def test_selftest(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(dp.selftest(), 0)


if __name__ == '__main__':
    unittest.main()
