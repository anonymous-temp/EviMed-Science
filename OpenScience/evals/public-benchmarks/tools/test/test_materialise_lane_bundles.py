"""Tests of materialise_lane_bundles.py over synthetic lane bundles (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_materialise_lane_bundles.py'   (from evals/public-benchmarks)
"""
import contextlib
import hashlib
import io
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import export_harness_arms as eha  # noqa: E402
import materialise_lane_bundles as mlb  # noqa: E402
import round_fixture as fx  # noqa: E402

CAND = 'cand-0123456789ab'
ROWS = ['101', '102', '103']


def tree_digest(root):
    root = pathlib.Path(root)
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()}


class Materialise(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='materialise-test-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        self.inbox = self.dir / 'inbox'
        self.archive = self.inbox / 'archive'
        self.out = self.dir / 'out'
        self.registration = self.dir / 'registration.json'
        self.write_registration(ROWS, 1)

    def write_registration(self, rows, repeats):
        self.registration.write_text(json.dumps({'family': 'medcalc', 'digest': 'a' * 64, 'rows': {'development': rows, 'confirmation': ['900']},
                                                 'repeats': {'development': repeats, 'confirmation': 3}}))

    def bundle(self, prefix, row, repeat=0, form='dev', confirmation_prefix='cf', **kw):
        rid = f'{prefix}.medcalc.{row}.r{repeat}' if form == 'dev' else f'{confirmation_prefix}.medcalc.{row}.{prefix}.r{repeat}'
        kw.setdefault('answer', f'Final answer: {row}')
        return fx.bundle(kw.pop('inbox', self.inbox), rid, 'medcalc', row, **kw)

    def run_tool(self, *arms, extra=(), role='development', form='dev'):
        argv = ['--registration', str(self.registration), '--role', role, '--domain', 'medcalc', '--bench-key', 'medcalc-rsi', '--form', form,
                '--inbox', str(self.inbox), '--inbox', str(self.archive), '--out', str(self.out), *extra]
        for arm in arms:
            argv += ['--arm', arm]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mlb.main(argv)
        return code, out.getvalue(), err.getvalue()

    def report(self):
        return json.loads((self.out / 'materialised.json').read_text())

    def fill(self, prefixes=('s1', 'aa', 'cs')):
        for prefix in prefixes:
            for row in ROWS:
                self.bundle(prefix, row)

    # ------------------------------------------------------------------------------------------------ the layout the exporter reads

    def test_the_folders_are_the_ones_the_exporter_names_and_the_export_runs_on_them(self):
        self.fill()
        code, out, err = self.run_tool('baseline=s1', 'aa=aa', f'{CAND}=cs')
        self.assertEqual((code, err), (0, ''))
        self.assertIn('baseline (s1): 3/3 materialised', out)
        for arm, token in (('baseline', 'base'), ('aa', 'aa'), (CAND, CAND)):
            self.assertTrue((self.out / arm / f'medcalc-rsi__{token}__101' / 'result.json').is_file(), arm)
            self.assertTrue((self.out / arm / f'medcalc-rsi__{token}__101' / 'answer.md').is_file(), arm)
        rows = self.dir / 'rows.json'
        rows.write_text(json.dumps({'rows': [{'id': r, 'calculatorId': 2, 'gold': {'answer': '1', 'lower': '0', 'upper': '2'}} for r in ROWS]}))
        bundles = self.dir / 'bundles.json'
        image = {'id': 'img-1', 'digest': 'b' * 64}
        bundles.write_text(json.dumps({'candidates': [{'title': 'x', 'bundle': {'guidanceSupplement': 'a rule', 'skills': []}}]}))
        arm = next(iter(eha.candidate_arms(str(bundles), image)))
        # the exporter finds every run through the same folder names
        code, out, err = self.run_tool('baseline=s1', 'aa=aa', f'{arm}=cs')
        self.assertEqual(code, 0, err)
        target = self.dir / 'development.json'
        argv = ['--role', 'development', '--benchmark', 'medcalc-bench', '--rows', str(rows), '--row-ids', str(self.registration), '--bundles', str(bundles),
                '--image-id', image['id'], '--image-digest', image['digest'], '--bench-key', 'medcalc-rsi', '--repeats', '1', '--out', str(target),
                '--arm', f'baseline={self.out}/baseline', '--arm', f'aa={self.out}/aa', '--arm', f'{arm}={self.out}/{arm}']
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            code = eha.main(argv)
        self.assertEqual(code, 0, err.getvalue())
        source = json.loads(target.read_text())
        self.assertEqual((len(source['runs']), sorted(source['arms'])), (9, sorted(['baseline', 'aa', arm])))

    def test_repeats_and_the_confirmation_form(self):
        for prefix in ('base', 'cstar'):
            for repeat in range(3):
                self.bundle(prefix, '900', repeat, form='confirmation')
        code, out, err = self.run_tool('baseline=base', f'{CAND}=cstar', role='confirmation', form='confirmation')
        self.assertEqual((code, err), (0, ''))
        self.assertTrue((self.out / 'baseline' / 'medcalc-rsi__base__900_r2' / 'result.json').is_file())
        self.assertTrue((self.out / CAND / f'medcalc-rsi__{CAND}__900_r0' / 'result.json').is_file())
        self.assertEqual(self.report()['repeats'], 3)

    def test_a_round_that_submitted_under_its_own_confirmation_prefix_names_it(self):
        for prefix in ('base', 'cstar'):
            for repeat in range(3):
                self.bundle(prefix, '900', repeat, form='confirmation', confirmation_prefix='cf2')
        code, out, err = self.run_tool('baseline=base', f'{CAND}=cstar', role='confirmation', form='confirmation')
        self.assertEqual(code, 3)  # the default `cf` finds none of them
        self.assertEqual(self.report()['arms']['baseline']['materialised'], 0)
        code, out, err = self.run_tool('baseline=base', f'{CAND}=cstar', role='confirmation', form='confirmation', extra=('--confirmation-prefix', 'cf2'))
        self.assertEqual((code, err), (0, ''))
        report = self.report()
        self.assertEqual((report['arms']['baseline']['materialised'], report['arms'][CAND]['materialised'], report['ignoredPrefixes']), (3, 3, {}))
        self.assertTrue((self.out / 'baseline' / 'medcalc-rsi__base__900_r2' / 'result.json').is_file())

    # ------------------------------------------------------------------------------------------------ what is left alone

    def test_other_prefixes_are_ignored_counted_and_the_originals_are_never_touched(self):
        self.fill(('s1',))
        for row in ROWS:
            self.bundle('c3', row)
            self.bundle('c1', row, inbox=self.archive, archived=True)
        before = tree_digest(self.inbox)
        code, out, _ = self.run_tool('baseline=s1')
        self.assertEqual(code, 0)
        self.assertEqual(tree_digest(self.inbox), before)
        self.assertEqual(self.report()['ignoredPrefixes'], {'c1': 3, 'c3': 3})
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ['baseline', 'materialised.json'])
        self.assertIn('ignored prefixes of this domain: c1 (3), c3 (3)', out)

    def test_an_archived_bundle_is_found(self):
        for row in ROWS:
            self.bundle('s1', row, inbox=self.archive, archived=True)
        self.assertEqual(self.run_tool('baseline=s1')[0], 0)

    # ------------------------------------------------------------------------------------------------ what is not materialised

    def test_missing_corrupt_wrong_item_ambiguous_and_infrastructure_runs_are_reported_and_not_written(self):
        self.bundle('s1', '101')
        self.bundle('s1', '102', tamper=True)
        self.bundle('s1', '103', key='medcalc/999')
        self.fill(('aa',))
        self.bundle('aa', '101', inbox=self.archive, archived=True, answer='another answer')  # the same rid twice, different bytes
        (self.inbox / 's1.medcalc.104.r0.infra-failed.json').write_text('{}')
        self.write_registration(ROWS + ['104'], 1)
        code, out, err = self.run_tool('baseline=s1', 'aa=aa')
        self.assertEqual(code, 3)
        states = {x['rid']: x['state'] for entry in self.report()['arms'].values() for x in entry['notMaterialised']}
        self.assertEqual(states, {'s1.medcalc.102.r0': 'corrupt', 's1.medcalc.103.r0': 'corrupt', 's1.medcalc.104.r0': 'infra', 'aa.medcalc.101.r0': 'ambiguous',
                                  'aa.medcalc.104.r0': 'missing'})
        self.assertTrue((self.out / 'baseline' / 'medcalc-rsi__base__101' / 'result.json').is_file())
        for gone in ('102', '103', '104'):
            self.assertFalse((self.out / 'baseline' / f'medcalc-rsi__base__{gone}').exists(), gone)
        self.assertFalse((self.out / 'aa' / 'medcalc-rsi__aa__101').exists())
        # nothing is zero-filled: the exporter sees a missing run and refuses
        rows = self.dir / 'rows.json'
        rows.write_text(json.dumps({'rows': [{'id': r, 'calculatorId': 2, 'gold': {'answer': '1', 'lower': '0', 'upper': '2'}} for r in ROWS + ['104']]}))
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            code = eha.main(['--role', 'development', '--benchmark', 'medcalc-bench', '--rows', str(rows), '--image-id', 'i', '--image-digest', 'b' * 64, '--bench-key', 'medcalc-rsi',
                             '--repeats', '1', '--out', str(self.dir / 'dev.json'), '--arm', f'baseline={self.out}/baseline'])
        self.assertEqual(code, 3)
        self.assertFalse((self.dir / 'dev.json').exists())

    def test_a_hostile_bundle_writes_nothing_outside_its_folder(self):
        self.bundle('s1', '101', hostile=True)
        self.write_registration(['101'], 1)
        self.assertEqual(self.run_tool('baseline=s1')[0], 0)
        folder = self.out / 'baseline' / 'medcalc-rsi__base__101'
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ['.bundle.sha256', 'answer.md', 'lane.json', 'result.json'])
        self.assertFalse((self.dir / 'escape.txt').exists())
        self.assertFalse((self.out / 'escape.txt').exists())

    def test_a_second_run_reuses_what_it_wrote_and_a_changed_bundle_replaces_it(self):
        self.fill(('s1',))
        self.assertEqual(self.run_tool('baseline=s1')[0], 0)
        folder = self.out / 'baseline' / 'medcalc-rsi__base__101'
        (folder / 'marker.txt').write_text('mine')
        self.assertEqual(self.run_tool('baseline=s1')[0], 0)
        self.assertTrue((folder / 'marker.txt').exists())
        self.bundle('s1', '101', answer='a different answer')
        self.assertEqual(self.run_tool('baseline=s1')[0], 0)
        self.assertFalse((folder / 'marker.txt').exists())
        self.assertEqual((folder / 'answer.md').read_text(), 'a different answer')

    def test_an_arm_can_be_taken_from_a_later_repeat_of_a_prefix_as_a_development_ab_control(self):
        for row in ROWS:
            self.bundle('m2', row, repeat=0, answer=f'first {row}')
            self.bundle('m2', row, repeat=1, answer=f'second {row}')
            self.bundle('m2', row, repeat=2, answer=f'third {row}')
            self.bundle('t2', row, repeat=0, answer=f'tools {row}')
        code, out, err = self.run_tool('baseline=m2', 'aa=m2@1', f'{CAND}=t2')
        self.assertEqual((code, err), (0, ''))
        self.assertIn('aa (m2@1): 3/3 materialised', out)
        self.assertEqual((self.out / 'baseline' / 'medcalc-rsi__base__101' / 'answer.md').read_text(), 'first 101')
        self.assertEqual((self.out / 'aa' / 'medcalc-rsi__aa__101' / 'answer.md').read_text(), 'second 101', 'the second run stands as the target\'s only repeat')
        self.assertEqual((self.out / CAND / f'medcalc-rsi__{CAND}__101' / 'answer.md').read_text(), 'tools 101')
        runs = {x['rid'] for entry in self.report()['arms'].values() for x in entry['runs']}
        self.assertIn('m2.medcalc.101.r1', runs)
        self.assertNotIn('m2.medcalc.101.r2', runs, 'a repeat nobody asked for is not opened')
        # the same prefix at the same repeat twice is one arm twice: refused; a prefix at two repeats is two arms
        self.assertEqual(self.run_tool('baseline=m2', 'aa=m2')[0], 2)
        self.assertEqual(self.run_tool('baseline=m2', 'aa=m2@x')[0], 2)
        self.assertEqual(self.run_tool('baseline=m2@0', 'aa=m2@0')[0], 2)

    # ------------------------------------------------------------------------------------------------ a bad request

    def test_bad_requests_are_exit_2(self):
        self.fill()
        for arms, extra in ((['aa=aa'], ()), (['baseline=s1', 'cand-xyz=cs'], ()), (['baseline=s1', 'aa=s1'], ()), (['s1'], ()), (['baseline=s1'], ('--form', 'other'))):
            code, _, err = self.run_tool(*arms, extra=extra)
            self.assertEqual(code, 2, arms)
            self.assertIn('materialise_lane_bundles', err)
        self.assertEqual(self.run_tool('baseline=s1', extra=('--domain', 'nope'))[0], 2)  # argparse takes the last --domain


if __name__ == '__main__':
    unittest.main()
