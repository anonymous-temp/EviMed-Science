"""Tests of export_harness_arms.py over synthetic bench-driver result folders (never real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_export_harness_arms.py'   (from evals/public-benchmarks)
"""
import contextlib
import hashlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import drb_pairwise as dp  # noqa: E402
import export_harness_arms as eha  # noqa: E402

IMAGE_ID = 'lane-image-1'
IMAGE_DIGEST = 'ab' * 32
IMAGE = {'id': IMAGE_ID, 'digest': IMAGE_DIGEST}
BUNDLE_ONE = {'guidanceSupplement': 'Give a first answer early, then refine it.',
              'skills': [{'name': 'closure', 'description': 'Use for long tasks.', 'body': 'Deliver a provisional result first.'}]}
BUNDLE_TWO = {'guidanceSupplement': '', 'skills': [{'name': 'conventions', 'description': 'State the conventions used.', 'body': 'Say which normalisation applied.'}]}
ARM_ONE = f'cand-{eha.harness_patch_digest(BUNDLE_ONE, IMAGE)[:12]}'
ARM_TWO = f'cand-{eha.harness_patch_digest(BUNDLE_TWO, IMAGE)[:12]}'
GOLD_MARK = '7.7777'


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode('utf-8')).hexdigest()


def medcalc_item(row, repeat=None):
    return {'key': f'medcalc-rsi/base/{row}', 'bench': 'medcalc-rsi', 'id': f'{row}#r{repeat}' if repeat is not None else str(row), 'group': 'rsi-base',
            'prompt': 'synthetic', 'gold': {'calculator_id': 2 + int(row) % 3, 'answer': GOLD_MARK, 'lower': '7.0', 'upper': '8.5', 'output_type': 'decimal'},
            'meta': {'calculator': 'synthetic'}}


class Lab:
    """A scratch directory with item files, result folders and an exporter call."""

    def __init__(self, test):
        self.tmp = tempfile.TemporaryDirectory(prefix='export-harness-test-')
        test.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.test = test
        self.bundles = self.dir / 'bundles.json'
        self.bundles.write_text(json.dumps({'candidates': [{'title': 'closure', 'bundle': BUNDLE_ONE}, {'title': 'conventions', 'bundle': BUNDLE_TWO}]}))

    def items(self, rows, name='items.jsonl', make=medcalc_item):
        path = self.dir / name
        path.write_text(''.join(json.dumps(make(r)) + '\n' for r in rows))
        return path

    def result(self, arm, key, status='succeeded', answer='Final answer: 7.8', cost=0.01, **extra):
        """A bench-driver/3 result folder for `key` under the arm's results directory."""
        folder = self.dir / 'results' / arm / re.sub(r'[^A-Za-z0-9_.-]', '_', key.replace('/', '__'))
        folder.mkdir(parents=True, exist_ok=True)
        record = {'key': key, 'status': status, 'runId': f'run-{arm}-{abs(hash(key)) % 10**6}', 'errorCode': None,
                  'cost': {'cost': cost, 'openCost': 0, 'uncertain': 0}}
        record.update(extra)
        if cost is None:
            record['cost'] = {'cost': 0.5, 'openCost': 0.1, 'uncertain': 1}
        elif cost == 'absent':
            del record['cost']
        (folder / 'result.json').write_text(json.dumps(record))
        if answer is not None:
            (folder / 'answer.md').write_text(answer)
        elif (folder / 'answer.md').exists():
            (folder / 'answer.md').unlink()
        return folder

    def fill(self, arm, rows, repeats=1, token=None, bench='medcalc-rsi', **kw):
        token = token or ('base' if arm == 'baseline' else arm)
        for row in rows:
            for repeat in range(repeats):
                self.result(arm, f'{bench}/{token}/{row}' + (f'#r{repeat}' if repeats > 1 else ''), **kw)

    def dirof(self, arm):
        return self.dir / 'results' / arm

    def argv(self, role='development', arms=('baseline',), rows=('1', '2', '3'), repeats=1, out='development.json', benchmark='medcalc-bench', extra=()):
        args = ['--role', role, '--benchmark', benchmark, '--items', str(self.items(rows)), '--bundles', str(self.bundles),
                '--image-id', IMAGE_ID, '--image-digest', IMAGE_DIGEST, '--bench-key', 'medcalc-rsi', '--repeats', str(repeats),
                '--out', str(self.dir / out)]
        for arm in arms:
            args += ['--arm', f'{arm}={self.dirof(arm)}']
        return args + list(extra)

    def run(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = eha.main(argv)
        return code, out.getvalue(), err.getvalue()

    def load(self, name='development.json'):
        return json.loads((self.dir / name).read_text(encoding='utf-8'))

    def assert_checksum(self, name):
        path = self.dir / name
        line = (self.dir / f'{name}.sha256').read_text()
        self.test.assertEqual(line, f'{sha(path.read_bytes())}  {name}\n')


class CandidateForm(unittest.TestCase):
    def test_digest_binds_the_patch_and_the_image_and_sorts_skills(self):
        skills = [{'name': 'b-skill', 'description': 'd', 'body': 'b'}, {'name': 'a-skill', 'description': 'd', 'body': 'b'}]
        one = eha.harness_patch_digest({'guidanceSupplement': 'g', 'skills': skills}, IMAGE)
        self.assertEqual(one, eha.harness_patch_digest({'guidanceSupplement': 'g', 'skills': list(reversed(skills))}, IMAGE))
        self.assertNotEqual(one, eha.harness_patch_digest({'guidanceSupplement': 'g', 'skills': skills}, {'id': 'other', 'digest': IMAGE_DIGEST}))
        self.assertNotEqual(one, eha.harness_patch_digest({'guidanceSupplement': 'g2', 'skills': skills}, IMAGE))
        canonical = json.dumps({'guidanceSupplement': 'g', 'image': IMAGE, 'skills': sorted(skills, key=lambda s: s['name'])}, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        self.assertEqual(one, sha(canonical))

    def test_sizes_count_utf16_units(self):
        chars, always = eha.harness_patch_sizes({'guidanceSupplement': '\U0001F680', 'skills': [{'name': 'ab', 'description': 'c', 'body': 'dd'}]})
        self.assertEqual((chars, always), (2 + 2 + 1 + 2, 2 + 2 + 1))

    def test_invalid_bundles_and_images_are_refused(self):
        bad = [{}, {'guidanceSupplement': 'g'}, {'guidanceSupplement': '', 'skills': []}, {'guidanceSupplement': 'g', 'skills': [], 'extra': 1},
               {'guidanceSupplement': 'g', 'skills': [{'name': 'Bad Name', 'description': 'd', 'body': 'b'}]},
               {'guidanceSupplement': 'g', 'skills': [{'name': 'x', 'description': 'd', 'body': 'b'}, {'name': 'x', 'description': 'd', 'body': 'b'}]},
               {'guidanceSupplement': 'g', 'skills': [{'name': 'x', 'description': 'd'}]}, {'guidanceSupplement': 7, 'skills': []},
               {'guidanceSupplement': 'lone \ud800 surrogate', 'skills': []}]
        for bundle in bad:
            with self.assertRaises(eha.ExportError, msg=json.dumps(bundle)[:60]):
                eha.harness_patch_digest(bundle, IMAGE)
        for image in [{}, {'id': 'x', 'digest': 'AB' * 32}, {'id': '', 'digest': IMAGE_DIGEST}, {'id': 'x', 'digest': 'ab' * 31}, {'id': 'x', 'digest': IMAGE_DIGEST, 'extra': 1}]:
            with self.assertRaises(eha.ExportError):
                eha.harness_patch_digest(BUNDLE_ONE, image)


class RowsFromItems(unittest.TestCase):
    def test_rows_of_every_benchmark(self):
        med = eha.row_from_item('medbrowsecomp', {'id': '15', 'gold': {'task_name': 'Ingredient', 'answer': 'X'}, 'meta': {'task_name': 'Ingredient'}})
        self.assertEqual(med, {'id': '15', 'task': 'Ingredient', 'gold': {'task_name': 'Ingredient', 'answer': 'X'}})
        bix = eha.row_from_item('bixbench', {'id': 'bix-1', 'meta': {'topic': 'other_stats'}, 'gold': {'questions': [
            {'n': 1, 'qid': 'bix-1-q1', 'question': 'text that must not travel', 'ideal': '(1,2)', 'eval_mode': 'range_verifier', 'range': [1, 2], 'distractors': ['x']}]}})
        self.assertEqual(bix['gold']['questions'], [{'n': 1, 'qid': 'bix-1-q1', 'eval_mode': 'range_verifier', 'ideal': '(1,2)', 'range': [1, 2]}])
        self.assertEqual(bix['topic'], 'other_stats')
        deep = {'id': 'deep-1', 'meta': {'category': 'CV'}, 'gold': {'type': 'deep', 'titles': ['t'], 'arxiv_ids': ['2201.00001'], 'is_none': False}}
        self.assertEqual(eha.row_from_item('autoresearchbench-deep', deep)['category'], 'CV')
        self.assertIsNone(eha.row_from_item('autoresearchbench-wide', deep))
        self.assertEqual(eha.row_from_item('deepresearchbench', {'id': '8', 'meta': {'topic': 'Science'}, 'gold': {'criteria': 'x'}}), {'id': '8', 'category': 'Science'})
        self.assertEqual(eha.row_from_item('researchclawbench', {'id': 'Life_000', 'meta': {'domain': 'Life'}}), {'id': 'Life_000', 'category': 'Life'})
        calc = eha.row_from_item('medcalc-bench', medcalc_item(5, repeat=2))
        self.assertEqual(calc['id'], '5')
        self.assertEqual(calc['gold'], {'answer': GOLD_MARK, 'lower': '7.0', 'upper': '8.5'})


class Development(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)

    def test_complete_medcalc_shaped_development_source(self):
        lab = self.lab
        for arm in ('baseline', 'aa', ARM_ONE):
            lab.fill(arm, ['1', '2', '3'])
        code, out, err = lab.run(lab.argv(arms=('baseline', 'aa', ARM_ONE), rows=('1', '2', '3', '3')))  # an id given twice is one row
        self.assertEqual(code, 0, err)
        source = lab.load()
        self.assertEqual((source['kind'], source['schema'], source['role'], source['benchmark']), ('harness-arms', 1, 'development', 'medcalc-bench'))
        self.assertEqual(source['image'], IMAGE)
        self.assertEqual(source['repeats'], 1)
        self.assertEqual([r['id'] for r in source['rows']], ['1', '2', '3'])
        self.assertTrue(all(isinstance(r['calculatorId'], int) and r['gold']['answer'] == GOLD_MARK for r in source['rows']))
        self.assertEqual(list(source['arms']), ['baseline', 'aa', ARM_ONE])
        self.assertEqual(source['arms']['baseline'], {'harness': None})
        self.assertEqual(source['arms']['aa'], {'harness': None, 'control': 'A/A'})
        harness = source['arms'][ARM_ONE]['harness']
        self.assertEqual(harness['digest'], eha.harness_patch_digest(BUNDLE_ONE, IMAGE))
        self.assertEqual((harness['chars'], harness['alwaysOnChars']), eha.harness_patch_sizes(BUNDLE_ONE))
        self.assertEqual((harness['title'], harness['bundle']), ('closure', BUNDLE_ONE))
        self.assertEqual(len(source['runs']), 9)
        run = source['runs'][0]
        self.assertEqual((run['row'], run['arm'], run['repeat'], run['status'], run['answer'], run['cost']), ('1', 'baseline', 0, 'succeeded', 'Final answer: 7.8', 0.01))
        self.assertTrue(run['runId'])
        self.assertNotIn('score', json.dumps(source).lower().replace('scored', ''))
        lab.assert_checksum('development.json')
        self.assertFalse((lab.dir / 'development.gold.json').exists())
        summary = json.loads(out.splitlines()[-1])
        self.assertEqual((summary['runs'], summary['expectedRuns'], summary['incomplete']), (9, 9, 0))

    def test_arm_id_must_be_the_digest_of_a_bundle_on_this_image(self):
        lab = self.lab
        lab.fill('baseline', ['1'])
        lab.fill('cand-000000000000', ['1'])
        code, _, err = lab.run(lab.argv(arms=('baseline', 'cand-000000000000'), rows=('1',)))
        self.assertEqual(code, 2)
        self.assertIn('unknown candidate arm cand-000000000000', err)
        self.assertFalse((lab.dir / 'development.json').exists())
        # the same bundle measured on another image is another arm id
        other = eha.harness_patch_digest(BUNDLE_ONE, {'id': 'other-image', 'digest': IMAGE_DIGEST})
        self.assertNotEqual(f'cand-{other[:12]}', ARM_ONE)
        lab.fill(f'cand-{other[:12]}', ['1'])
        code, _, err = lab.run(lab.argv(arms=('baseline', f'cand-{other[:12]}'), rows=('1',)))
        self.assertEqual(code, 2)

    def test_the_baseline_is_required_and_an_arm_is_given_once(self):
        lab = self.lab
        lab.fill(ARM_ONE, ['1'])
        self.assertEqual(lab.run(lab.argv(arms=(ARM_ONE,), rows=('1',)))[0], 2)
        lab.fill('baseline', ['1'])
        argv = lab.argv(arms=('baseline',), rows=('1',)) + ['--arm', f'baseline={lab.dirof("baseline")}']
        self.assertEqual(lab.run(argv)[0], 2)

    def test_row_ids_must_equal_the_registered_rows(self):
        lab = self.lab
        lab.fill('baseline', ['1', '2'])
        ids = lab.dir / 'ids.json'
        ids.write_text(json.dumps({'rows': ['1', '2']}))
        self.assertEqual(lab.run(lab.argv(rows=('1', '2'), extra=['--row-ids', str(ids)]))[0], 0)
        ids.write_text(json.dumps({'rows': {'development': ['1', '2', '9'], 'confirmation': ['1']}}))
        code, _, err = lab.run(lab.argv(rows=('1', '2'), extra=['--row-ids', str(ids)]))
        self.assertEqual(code, 2)
        self.assertIn('missing', err)
        ids.write_text(json.dumps({'rows': {'development': ['1', '2'], 'confirmation': ['1']}}))
        self.assertEqual(lab.run(lab.argv(rows=('1', '2'), extra=['--row-ids', str(ids)]))[0], 0)

    def test_an_uncertain_cost_keeps_the_ledger_sum_and_is_listed_beside_the_source(self):
        lab = self.lab
        lab.fill('baseline', ['1', '2'])
        lab.result('baseline', 'medcalc-rsi/base/2', cost=None, costSettle={'waitedMs': 90000, 'reads': 10, 'settled': False})
        code, out, _ = lab.run(lab.argv(rows=('1', '2')))
        self.assertEqual(code, 0)
        runs = lab.load()['runs']
        self.assertEqual([r['cost'] for r in runs], [0.01, 0.5], 'the settled sum of the ledger, not null and not the reservation')
        summary = json.loads(out.splitlines()[-1])
        self.assertEqual((summary['unsettled'], summary['uncertainCosts']), (0, 1))
        sidecar = (lab.dir / 'development.json.uncertain-costs.json')
        self.assertTrue(sidecar.exists() and Path(f'{sidecar}.sha256').exists())
        note = json.loads(sidecar.read_text())
        self.assertEqual((note['kind'], note['role'], len(note['runs'])), ('harness-uncertain-costs', 'development', 1))
        listed = note['runs'][0]
        self.assertEqual((listed['arm'], listed['row'], listed['repeat'], listed['cost'], listed['openCost'], listed['uncertain']), ('baseline', '2', 0, 0.5, 0.1, 1))
        self.assertEqual(listed['driverSaw']['waitedMs'], 90000)
        self.assertIn('lower bound', note['note'])
        self.assertNotIn('uncertain', json.dumps(lab.load()), 'the source itself carries no new field')

    def test_a_run_with_no_cost_record_is_null_not_zero(self):
        lab = self.lab
        lab.fill('baseline', ['1', '2'])
        lab.result('baseline', 'medcalc-rsi/base/2', cost='absent')
        code, out, _ = lab.run(lab.argv(rows=('1', '2')))
        self.assertEqual(code, 0)
        self.assertEqual([r['cost'] for r in lab.load()['runs']], [0.01, None])
        summary = json.loads(out.splitlines()[-1])
        self.assertEqual((summary['unsettled'], summary['uncertainCosts']), (1, 0))
        self.assertFalse((lab.dir / 'development.json.uncertain-costs.json').exists(), 'nothing uncertain, no sidecar')

    def test_a_record_that_never_says_whether_it_is_closed_is_listed_as_uncertain(self):
        lab = self.lab
        lab.fill('baseline', ['1'])
        folder = lab.result('baseline', 'medcalc-rsi/base/1')
        record = json.loads((folder / 'result.json').read_text())
        record['cost'] = {'cost': 0.02}
        (folder / 'result.json').write_text(json.dumps(record))
        code, out, _ = lab.run(lab.argv(rows=('1',)))
        self.assertEqual(code, 0)
        self.assertEqual(lab.load()['runs'][0]['cost'], 0.02)
        self.assertEqual(json.loads(out.splitlines()[-1])['uncertainCosts'], 1)

    def test_repeats_use_the_hash_suffix_in_keys(self):
        lab = self.lab
        lab.fill('baseline', ['1', '2'], repeats=3)
        code, _, err = lab.run(lab.argv(rows=('1', '2'), repeats=3))
        self.assertEqual(code, 0, err)
        self.assertEqual([(r['row'], r['repeat']) for r in lab.load()['runs']][:4], [('1', 0), ('1', 1), ('1', 2), ('2', 0)])


class Classification(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        lab = self.lab
        lab.fill('baseline', ['1', '2', '3', '4', '5', '6', '7', '8'])
        # kept as delivery outcomes: the solver's own non-delivery
        lab.result('baseline', 'medcalc-rsi/base/1', status='timeout', answer=None, errorCode='runtime_canceled')
        lab.result('baseline', 'medcalc-rsi/base/2', status='failed', answer=None, errorCode='runtime_session_error')
        lab.result('baseline', 'medcalc-rsi/base/3', status='failed', answer='partial', errorCode=None)
        # infrastructure, never scored
        lab.result('baseline', 'medcalc-rsi/base/4', status='dispatch_refused', answer=None, errorCode='internal_error', infrastructureFailure=True)
        lab.result('baseline', 'medcalc-rsi/base/5', status='failed', answer=None, errorCode='runtime_stopped')
        lab.result('baseline', 'medcalc-rsi/base/6', status='canceled', answer=None)
        lab.result('baseline', 'medcalc-rsi/base/7', status='driver_error', answer=None)
        (lab.dirof('baseline') / 'medcalc-rsi__base__8' / 'result.json').unlink()  # missing

    def test_infrastructure_stops_the_export_before_anything_is_written(self):
        lab = self.lab
        rows = tuple(str(i) for i in range(1, 9))
        code, out, err = lab.run(lab.argv(rows=rows))
        self.assertEqual(code, 3)
        self.assertEqual(out, '')
        self.assertIn('5 runs are missing or infrastructure failures', err)
        for key, reason in (('base/4', 'infrastructureFailure'), ('base/5', 'errorCode runtime_stopped'), ('base/6', 'status canceled'), ('base/7', 'status driver_error'), ('base/8', 'missing')):
            self.assertRegex(err, re.escape(key) + '.*' + re.escape(reason))
        self.assertEqual(list(lab.dir.glob('development*')), [])

    def test_allow_incomplete_writes_the_source_without_them_and_still_exits_3(self):
        lab = self.lab
        rows = tuple(str(i) for i in range(1, 9))
        code, out, err = lab.run(lab.argv(rows=rows, extra=['--allow-incomplete']))
        self.assertEqual(code, 3)
        source = lab.load()
        by_row = {r['row']: r for r in source['runs']}
        self.assertEqual(sorted(by_row, key=int), ['1', '2', '3'], 'only the solver\'s own outcomes are in the source')
        self.assertEqual((by_row['1']['status'], by_row['1']['answer']), ('timeout', None))
        self.assertEqual((by_row['2']['status'], by_row['2']['answer']), ('failed', None))
        self.assertEqual((by_row['3']['status'], by_row['3']['answer']), ('failed', 'partial'))
        self.assertFalse(any(isinstance(r.get('score'), (int, float)) for r in source['runs']), 'nothing is zero-filled or scored')
        incomplete = json.loads((lab.dir / 'development.json.incomplete.json').read_text())
        self.assertEqual(sorted(e['row'] for e in incomplete), ['4', '5', '6', '7', '8'])
        self.assertEqual({e['row']: e['reason'] for e in incomplete}['8'], 'missing')
        self.assertEqual(json.loads(out.splitlines()[-1])['incomplete'], 5)
        lab.assert_checksum('development.json')
        lab.assert_checksum('development.json.incomplete.json')

    def test_extra_infrastructure_codes_are_honoured(self):
        lab = self.lab
        code, _, err = lab.run(lab.argv(rows=('2',), extra=['--infrastructure-code', 'runtime_session_error']))
        self.assertEqual(code, 3)
        self.assertIn('errorCode runtime_session_error', err)

    def test_a_delivered_run_whose_answer_was_not_captured_is_incomplete(self):
        lab = self.lab
        lab.result('baseline', 'medcalc-rsi/base/1', status='succeeded', answer=None, capture={'transcript': 'failed', 'cost': 'ok'})
        code, _, err = lab.run(lab.argv(rows=('1',)))
        self.assertEqual(code, 3)
        self.assertIn('transcript capture failed', err)
        # captured, and genuinely empty, it is a run that scores 0; a timeout does not need its transcript at all
        lab.result('baseline', 'medcalc-rsi/base/1', status='succeeded', answer=None, capture={'transcript': 'ok'})
        self.assertEqual(lab.run(lab.argv(rows=('1',)))[0], 0)
        lab.result('baseline', 'medcalc-rsi/base/1', status='timeout', answer=None, capture={'transcript': 'failed'}, errorCode='runtime_canceled')
        self.assertEqual(lab.run(lab.argv(rows=('1',)))[0], 0)

    def test_an_unreadable_result_is_incomplete(self):
        lab = self.lab
        (lab.dirof('baseline') / 'medcalc-rsi__base__1' / 'result.json').write_text('{not json')
        code, _, err = lab.run(lab.argv(rows=('1',)))
        self.assertEqual(code, 3)
        self.assertIn('unreadable', err)


class Confirmation(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        lab = self.lab
        lab.fill('baseline', ['1', '2', '3'], repeats=3)
        lab.fill(ARM_ONE, ['1', '2', '3'], repeats=3)
        lab.fill(ARM_TWO, ['1', '2', '3'], repeats=3)
        lab.fill('aa', ['1', '2', '3'], repeats=3)

    def argv(self, arms, **kw):
        return self.lab.argv(role='confirmation', arms=arms, repeats=3, out='confirmation.json', **kw)

    def test_the_sealed_source_carries_no_gold_and_nothing_is_scored(self):
        lab = self.lab
        code, out, err = lab.run(self.argv(('baseline', ARM_ONE)))
        self.assertEqual(code, 0, err)
        text = (lab.dir / 'confirmation.json').read_text()
        self.assertNotIn(GOLD_MARK, text)
        source = json.loads(text)
        self.assertEqual(source['role'], 'confirmation')
        self.assertTrue(all('gold' not in row and 'calculatorId' in row for row in source['rows']))
        self.assertEqual(len(source['runs']), 3 * 2 * 3)
        gold = json.loads((lab.dir / 'confirmation.gold.json').read_text())
        self.assertEqual((gold['kind'], gold['schema'], gold['benchmark']), ('harness-gold', 1, 'medcalc-bench'))
        self.assertEqual(sorted(gold['gold']), ['1', '2', '3'])
        self.assertEqual(gold['gold']['1'], {'answer': GOLD_MARK, 'lower': '7.0', 'upper': '8.5'})
        lab.assert_checksum('confirmation.json')
        lab.assert_checksum('confirmation.gold.json')
        self.assertNotIn(GOLD_MARK, out + err)
        self.assertNotRegex(out.lower(), r'accuracy|correct|score')

    def test_the_control_arm_and_a_second_candidate_are_refused(self):
        lab = self.lab
        code, _, err = lab.run(self.argv(('baseline', 'aa', ARM_ONE)))
        self.assertEqual(code, 2)
        self.assertIn('A/A', err)
        code, _, err = lab.run(self.argv(('baseline', ARM_ONE, ARM_TWO)))
        self.assertEqual(code, 2)
        self.assertIn('exactly one candidate', err)
        code, _, _ = lab.run(self.argv(('baseline',)))
        self.assertEqual(code, 2)
        self.assertEqual(list(lab.dir.glob('confirmation*')), [])

    def test_a_development_export_keeps_gold_in_the_rows(self):
        lab = self.lab
        code, _, err = lab.run(lab.argv(arms=('baseline', 'aa', ARM_ONE, ARM_TWO), repeats=3))
        self.assertEqual(code, 0, err)
        self.assertTrue(all(row['gold']['answer'] == GOLD_MARK for row in lab.load()['rows']))
        self.assertFalse((lab.dir / 'development.gold.json').exists())


# ---------------------------------------------------------------------------------------------------------------- judged

def report_item(row):
    return {'key': f'rcb-rsi/base/{row}', 'bench': 'rcb-rsi', 'id': str(row), 'group': 'g', 'prompt': 'synthetic', 'meta': {'domain': 'Life'}}


class JudgedAbsolute(unittest.TestCase):
    ROWS = ('Life_000', 'Life_001')

    def setUp(self):
        self.lab = Lab(self)
        lab = self.lab
        for arm in ('baseline', ARM_ONE):
            lab.fill(arm, self.ROWS, bench='rcb-rsi', answer='short reply, the report is a file')
            for row in self.ROWS:
                key = f'rcb-rsi/{"base" if arm == "baseline" else arm}/{row}'
                folder = lab.result(arm, key, answer='short reply')
                (folder / 'files' / 'report').mkdir(parents=True)
                (folder / 'files' / 'report' / 'report.md').write_text(f'# Report of {arm} on {row}\nbody')
        # the candidate's run on the second row timed out: the judge must not score it
        lab.result(ARM_ONE, f'rcb-rsi/{ARM_ONE}/Life_001', status='timeout', answer=None, errorCode='runtime_canceled')
        self.items_path = lab.items(self.ROWS, name='rcb.jsonl', make=report_item)

    def keys(self):
        return {(arm, row): f'rcb-rsi/{"base" if arm == "baseline" else arm}/{row}' for arm in ('baseline', ARM_ONE) for row in self.ROWS}

    def verdict_files(self, passes=3, skip=(), extra_lines=(), score=lambda arm, row, k: 40 + 10 * k, judge='claude-judge-1'):
        files = []
        for k in range(1, passes + 1):
            path = self.lab.dir / ('rcb.verdicts.jsonl' if k == 1 else f'rcb.verdicts.p{k}.jsonl')
            lines = []
            for (arm, row), key in self.keys().items():
                if (arm, row) in skip:
                    continue
                lines.append({'key': key, 'score': score(arm, row, k), 'judge': judge})
            lines += [dict(l) for l in extra_lines if l.get('_pass', k) == k]
            path.write_text(''.join(json.dumps({a: b for a, b in l.items() if a != '_pass'}) + '\n' for l in lines))
            files.append(str(path))
        return files

    def argv(self, files, **kw):
        extra = ['--verdicts', *files, '--dialect', kw.get('dialect', 'percent'), '--judge-id', kw.get('judge_id', 'claude-judge-1'),
                 '--judge-provider', kw.get('provider', 'anthropic'), '--judge-form', 'absolute', '--judge-passes', str(kw.get('passes', 3))]
        return ['--role', 'development', '--benchmark', 'researchclawbench', '--items', str(self.items_path), '--arm', f'baseline={self.lab.dirof("baseline")}',
                '--arm', f'{ARM_ONE}={self.lab.dirof(ARM_ONE)}', '--bundles', str(self.lab.bundles), '--image-id', IMAGE_ID, '--image-digest', IMAGE_DIGEST,
                '--bench-key', 'rcb-rsi', '--repeats', '1', '--out', str(self.lab.dir / 'development.json'), *extra]

    def test_three_passes_become_digested_records_and_the_source_names_the_judge(self):
        lab = self.lab
        files = self.verdict_files(skip={(ARM_ONE, 'Life_001')})
        code, out, err = lab.run(self.argv(files))
        self.assertEqual(code, 0, err)
        source = lab.load()
        self.assertTrue(all(r['answer'] is None for r in source['runs']))
        by = {(r['arm'], r['row']): r for r in source['runs']}
        self.assertEqual(by[('baseline', 'Life_000')]['answerChars'], len('# Report of baseline on Life_000\nbody'))
        self.assertEqual(by[('baseline', 'Life_000')]['reportSha256'], sha('# Report of baseline on Life_000\nbody'))
        judged = source['judged']
        self.assertEqual(judged['schema'], 1)
        self.assertEqual(judged['judge'], {'id': 'claude-judge-1', 'provider': 'anthropic', 'form': 'absolute', 'passes': 3})
        self.assertEqual(judged['cost']['settledCny'], 0)
        self.assertIn('not metered in CNY', judged['cost']['note'])
        self.assertEqual(judged['calls'], 9, '3 succeeded runs x 3 passes')
        self.assertEqual([f['name'] for f in judged['files']], ['rcb.verdicts.jsonl', 'rcb.verdicts.p2.jsonl', 'rcb.verdicts.p3.jsonl'])
        for entry, path in zip(judged['files'], files):
            self.assertEqual((entry['sha256'], entry['lines']), (sha(Path(path).read_bytes()), 3))
        records_path = lab.dir / 'development.verdicts.jsonl'
        lines = records_path.read_text().splitlines()
        records = [json.loads(l) for l in lines]
        self.assertEqual(len(records), 9)
        self.assertEqual(judged['recordsFile'], {'name': 'development.verdicts.jsonl', 'sha256': sha(records_path.read_bytes()), 'lines': 9})
        self.assertEqual(records[0], {'row': 'Life_000', 'arm': 'baseline', 'repeat': 0, 'pass': 1, 'score': 0.5, 'judge': 'claude-judge-1'})
        self.assertEqual(list(records[0]), ['row', 'arm', 'repeat', 'pass', 'score', 'judge'])
        order = [(r['row'], r['arm'], r['repeat'], r['pass']) for r in records]
        self.assertEqual(order, sorted(order, key=lambda t: (eha.natural_key(t[0]), t[1], t[2], t[3])))
        self.assertFalse(any(r['arm'] == ARM_ONE and r['row'] == 'Life_001' for r in records), 'no verdict for the timed-out run')
        lab.assert_checksum('development.verdicts.jsonl')
        lab.assert_checksum('development.json')

    def test_the_deepseek_family_is_refused_as_a_judge(self):
        files = self.verdict_files(skip={(ARM_ONE, 'Life_001')}, judge='DeepSeek-V4')
        code, _, err = self.lab.run(self.argv(files, judge_id='DeepSeek-V4'))
        self.assertEqual(code, 2)
        self.assertIn('solver', err)
        code, _, err = self.lab.run(self.argv(self.verdict_files(skip={(ARM_ONE, 'Life_001')}), provider='deepseek'))
        self.assertEqual(code, 2)
        self.assertFalse((self.lab.dir / 'development.json').exists())

    def test_a_verdict_for_a_run_that_did_not_succeed_is_refused(self):
        code, _, err = self.lab.run(self.argv(self.verdict_files()))
        self.assertEqual(code, 2)
        self.assertRegex(err, r'run did not succeed \(timeout\)')

    def test_a_missing_pass_is_refused(self):
        files = self.verdict_files(passes=2, skip={(ARM_ONE, 'Life_001')})
        code, _, err = self.lab.run(self.argv(files, passes=3))
        self.assertEqual(code, 2)
        self.assertIn('lacks pass [3]', err)

    def test_an_unknown_key_is_an_error_with_its_line_never_dropped(self):
        files = self.verdict_files(skip={(ARM_ONE, 'Life_001')}, extra_lines=[{'key': 'rcb-rsi/base/Life_999', 'score': 50}])
        code, _, err = self.lab.run(self.argv(files))
        self.assertEqual(code, 2)
        self.assertRegex(err, r'rcb\.verdicts\.jsonl:4: unknown verdict key')

    def test_judge_pass_and_score_must_agree_with_the_registration(self):
        skip = {(ARM_ONE, 'Life_001')}
        for line, needle in (({'key': 'rcb-rsi/base/Life_000', 'score': 50, 'judge': 'someone-else', '_pass': 1}, 'is not'),
                             ({'key': 'rcb-rsi/base/Life_000', 'score': 50, 'pass': 2, '_pass': 1}, 'disagrees with the file name'),
                             ({'key': 'rcb-rsi/base/Life_000', 'score': 140, '_pass': 1}, 'no score in [0, 1]'),
                             ({'key': 'rcb-rsi/base/Life_000', 'score': 'high', '_pass': 1}, 'no score in [0, 1]')):
            code, _, err = self.lab.run(self.argv(self.verdict_files(skip=skip, extra_lines=[line])))
            self.assertEqual(code, 2, line)
            self.assertIn(needle, err)

    def test_a_different_duplicate_is_refused_and_an_identical_one_is_counted_once(self):
        skip = {(ARM_ONE, 'Life_001')}
        same = {'key': 'rcb-rsi/base/Life_000', 'score': 50, '_pass': 1}
        code, _, err = self.lab.run(self.argv(self.verdict_files(skip=skip, extra_lines=[{**same, 'score': 51}])))
        self.assertEqual(code, 2)
        self.assertIn('different verdict', err)
        code, _, err = self.lab.run(self.argv(self.verdict_files(skip=skip, extra_lines=[same])))
        self.assertEqual(code, 0, err)
        source = self.lab.load()
        self.assertEqual(source['judged']['calls'], 10)
        self.assertEqual(source['judged']['recordsFile']['lines'], 9)

    def test_other_dialects_and_misuse(self):
        skip = {(ARM_ONE, 'Life_001')}
        files = self.verdict_files(skip=skip, score=lambda a, r, k: 0.25 * k)
        self.assertEqual(self.lab.run(self.argv(files, dialect='unit'))[0], 0)
        self.assertEqual(json.loads(self.lab.dir.joinpath('development.verdicts.jsonl').read_text().splitlines()[0])['score'], 0.25)
        race = []
        for path in files:
            lines = [json.loads(l) for l in Path(path).read_text().splitlines()]
            Path(path).write_text(''.join(json.dumps({'key': l['key'], 'race': l['score'] / 2, 'judge': l['judge']}) + '\n' for l in lines))
            race.append(path)
        self.assertEqual(self.lab.run(self.argv(race, dialect='race'))[0], 0)
        # verdict files belong to judged benchmarks only
        argv = self.argv(files, dialect='unit')
        argv[argv.index('researchclawbench')] = 'medcalc-bench'
        self.assertEqual(self.lab.run(argv)[0], 2)

    def test_the_confirmation_export_prints_counts_and_no_score(self):
        lab = self.lab
        files = self.verdict_files(skip={(ARM_ONE, 'Life_001')}, score=lambda a, r, k: 61)
        argv = self.argv(files)
        argv[argv.index('development')] = 'confirmation'
        argv[argv.index(str(lab.dir / 'development.json'))] = str(lab.dir / 'confirmation.json')
        code, out, err = lab.run(argv)
        self.assertEqual(code, 0, err)
        self.assertNotIn('0.61', out + err)
        summary = json.loads(out.splitlines()[-1])
        self.assertEqual(summary['records'], 9)
        self.assertFalse((lab.dir / 'confirmation.gold.json').exists(), 'a judged benchmark has no gold')


class JudgedPairwise(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        lab = self.lab
        lab.bundles.write_text(json.dumps({'candidates': [{'title': 'closure', 'bundle': BUNDLE_ONE}]}))
        self.rows = ('1', '2', '3')
        for arm in ('baseline', ARM_ONE):
            for row in self.rows:
                token = 'base' if arm == 'baseline' else arm
                lab.result(arm, f'drb-rsi/{token}/{row}', answer=f'report of {arm} on {row}')
        lab.result(ARM_ONE, f'drb-rsi/{ARM_ONE}/3', status='failed', answer=None, errorCode='runtime_session_error')
        self.items_path = lab.items(self.rows, name='drb.jsonl', make=lambda r: {'key': f'drb-rsi/base/{r}', 'id': str(r), 'meta': {'topic': 'Science'}})
        (lab.dir / 'criteria.json').write_text(json.dumps(dp.synthetic_criteria()))
        self.out = lab.dir / 'pairs'

    def packets(self, task, arm_a, arm_b, a_text, b_text, out=None):
        d = self.lab.dir
        (d / f'{task}-a.md').write_text(a_text)
        (d / f'{task}-b.md').write_text(b_text)
        order, out_dir = dp.build_packets(task, d / f'{task}-a.md', d / f'{task}-b.md', arm_a, arm_b, 2, 5, out or self.out, d / 'criteria.json')
        return order

    def verdicts(self, order, task, candidate_pref, candidate_is_a):
        """The lines of a judge that prefers the candidate by `candidate_pref` in both orders."""
        lines = []
        for k in (1, 2):
            first = order['tasks'][task]['passes'][str(k)]['first']
            candidate_first = (first == 'a') == candidate_is_a
            p = candidate_pref if candidate_first else -candidate_pref
            lines.append({'key': f'drb-pair/{task}/p{k}', 'scores': {'comprehensiveness': [{'idx': 0, 'pref': p}, {'idx': 1, 'pref': p}], 'insight': [{'idx': 0, 'pref': p}]}})
        return lines

    def argv(self, orders, files, pair_map):
        pm = self.lab.dir / 'pair-map.json'
        pm.write_text(json.dumps(pair_map))
        argv = ['--role', 'development', '--benchmark', 'deepresearchbench', '--items', str(self.items_path), '--arm', f'baseline={self.lab.dirof("baseline")}',
                '--arm', f'{ARM_ONE}={self.lab.dirof(ARM_ONE)}', '--bundles', str(self.lab.bundles), '--image-id', IMAGE_ID, '--image-digest', IMAGE_DIGEST,
                '--bench-key', 'drb-rsi', '--repeats', '1', '--out', str(self.lab.dir / 'development.json'), '--verdicts', *files, '--dialect', 'pairwise',
                '--judge-id', 'claude-judge-1', '--judge-provider', 'anthropic', '--judge-form', 'pairwise', '--judge-passes', '2', '--pair-map', str(pm)]
        for order in orders:
            argv += ['--pairwise-order', str(order)]
        return argv

    def write(self, name, lines):
        path = self.lab.dir / name
        path.write_text(''.join(json.dumps(l) + '\n' for l in lines))
        return str(path)

    def test_candidate_shares_come_from_the_signed_pairwise_totals(self):
        arm = ARM_ONE
        order = self.packets('1', 'baseline', arm, 'baseline report 1', 'candidate report 1')
        order = self.packets('2', 'baseline', arm, 'baseline report 2', 'candidate report 2')
        # the same order file serves tasks 1 and 2; task 3 (candidate failed) has no packets
        lines = self.verdicts(order, '1', 3, candidate_is_a=False) + self.verdicts(order, '2', 0, candidate_is_a=False)
        # a second comparison with the candidate as arm A, from its own order file
        other = self.lab.dir / 'pairs-b'
        order_b = self.packets('x1', arm, 'baseline', 'candidate report', 'baseline report', out=other)
        lines += self.verdicts(order_b, 'x1', -3, candidate_is_a=True)
        files = [self.write('pair.jsonl', lines)]
        pair_map = {'1': {'row': '1', 'repeat': 0, 'arm': arm}, '2': {'row': '2', 'repeat': 0, 'arm': arm}, 'x1': {'row': '3', 'repeat': 0, 'arm': arm}}
        # row 3's candidate run failed, so its pair must not be given
        code, _, err = self.lab.run(self.argv([self.out / 'order.json', other / 'order.json'], files, pair_map))
        self.assertEqual(code, 2)
        self.assertIn('did not succeed', err)
        pair_map.pop('x1')
        files = [self.write('pair.jsonl', lines[:4])]
        code, out, err = self.lab.run(self.argv([self.out / 'order.json'], files, pair_map))
        self.assertEqual(code, 0, err)
        records = [json.loads(l) for l in (self.lab.dir / 'development.verdicts.jsonl').read_text().splitlines()]
        self.assertEqual([(r['row'], r['arm'], r['pass'], r['score']) for r in records],
                         [('1', arm, 1, 1.0), ('1', arm, 2, 1.0), ('2', arm, 1, 0.5), ('2', arm, 2, 0.5)])
        self.assertEqual({r['judge'] for r in records}, {'claude-judge-1'})
        judged = self.lab.load()['judged']
        self.assertEqual((judged['judge']['form'], judged['calls'], judged['recordsFile']['lines']), ('pairwise', 4, 4))
        self.assertEqual(len(judged['files']), 1)
        self.assertTrue(all(r['arm'] != 'baseline' for r in records), 'the baseline has no pairwise record')

    def test_the_candidate_on_side_a_is_negated_and_scores_map_to_the_unit_interval(self):
        arm = ARM_ONE
        self.lab.result(ARM_ONE, f'drb-rsi/{ARM_ONE}/3', status='succeeded', answer='report')
        order_a = self.packets('1', 'baseline', arm, 'b1', 'c1')
        order_b = self.packets('3', arm, 'baseline', 'c3', 'b3', out=self.lab.dir / 'pairs-b')
        lines = self.verdicts(order_a, '1', -3, candidate_is_a=False) + self.verdicts(order_b, '3', 2, candidate_is_a=True)
        files = [self.write('pair.jsonl', lines)]
        pair_map = {'1': {'row': '1', 'repeat': 0, 'arm': arm}, '3': {'row': '3', 'repeat': 0, 'arm': arm}}
        # row 2's candidate run succeeded and has no pair: a succeeded run without its passes is refused
        code, _, err = self.lab.run(self.argv([self.out / 'order.json', self.lab.dir / 'pairs-b' / 'order.json'], files, pair_map))
        self.assertEqual(code, 2)
        self.assertIn('lacks pass [1, 2]', err)
        order_c = self.packets('2', 'baseline', arm, 'b2', 'c2')
        lines += self.verdicts(order_c, '2', 0, candidate_is_a=False)
        files = [self.write('pair.jsonl', lines)]
        pair_map['2'] = {'row': '2', 'repeat': 0, 'arm': arm}
        code, _, err = self.lab.run(self.argv([self.out / 'order.json', self.lab.dir / 'pairs-b' / 'order.json'], files, pair_map))
        self.assertEqual(code, 0, err)
        records = {(r['row'], r['pass']): r['score'] for r in map(json.loads, (self.lab.dir / 'development.verdicts.jsonl').read_text().splitlines())}
        self.assertEqual(records, {('1', 1): 0.0, ('1', 2): 0.0, ('2', 1): 0.5, ('2', 2): 0.5, ('3', 1): (3 + 2) / 6, ('3', 2): (3 + 2) / 6})

    def test_excluded_tasks_unmapped_tasks_and_wrong_arms_are_errors(self):
        arm = ARM_ONE
        order = self.packets('1', 'baseline', arm, 'b1', 'c1')
        good = self.verdicts(order, '1', 2, candidate_is_a=False)
        # a pass without a verdict excludes the task from the aggregate
        files = [self.write('pair.jsonl', good[:1])]
        code, _, err = self.lab.run(self.argv([self.out / 'order.json'], files, {'1': {'row': '1', 'repeat': 0, 'arm': arm}}))
        self.assertEqual(code, 2)
        self.assertIn('pass 2 has no verdict', err)
        files = [self.write('pair.jsonl', good)]
        code, _, err = self.lab.run(self.argv([self.out / 'order.json'], files, {}))
        self.assertEqual(code, 2)
        self.assertIn('not in --pair-map', err)
        code, _, err = self.lab.run(self.argv([self.out / 'order.json'], files, {'1': {'row': '1', 'repeat': 0, 'arm': 'cand-ffffffffffff'}}))
        self.assertEqual(code, 2)
        self.assertIn('--pair-map says arm', err)
        # an order file without the baseline arm
        self.packets('9', 'one', 'two', 'x', 'y', out=self.lab.dir / 'pairs-c')
        code, _, err = self.lab.run(self.argv([self.lab.dir / 'pairs-c' / 'order.json'], files, {'9': {'row': '1', 'repeat': 0, 'arm': arm}}))
        self.assertEqual(code, 2)
        self.assertIn("must be named 'baseline'", err)

    def test_form_and_dialect_go_together(self):
        order = self.packets('1', 'baseline', ARM_ONE, 'b1', 'c1')
        files = [self.write('pair.jsonl', self.verdicts(order, '1', 2, candidate_is_a=False))]
        argv = self.argv([self.out / 'order.json'], files, {'1': {'row': '1', 'repeat': 0, 'arm': ARM_ONE}})
        argv[argv.index('--judge-form') + 1] = 'absolute'
        code, _, err = self.lab.run(argv)
        self.assertEqual(code, 2)
        argv = self.argv([self.out / 'order.json'], files, {'1': {'row': '1', 'repeat': 0, 'arm': ARM_ONE}})
        argv[argv.index('--judge-passes') + 1] = '3'
        self.assertEqual(self.lab.run(argv)[0], 2)


TOOL_CODE = {'image': {'id': 'lane-image-1-delta', 'digest': 'cd' * 32}, 'patchSha256': 'ef' * 32,
             'files': [{'path': 'runtime/mcp/evimed-research/tool.py', 'sha256': '12' * 32}, {'path': 'runtime/mcp/evimed-research/data/index.json', 'sha256': '34' * 32}],
             'toolCatalogueChars': 420}


class ToolPatchCandidates(unittest.TestCase):
    """A candidate that holds code: the `tool-patch` surface (the digest binds the code; the two surfaces never share candidates)."""

    def bundles(self, entries):
        tmp = tempfile.TemporaryDirectory(prefix='tool-patch-test-')
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / 'bundles.json'
        path.write_text(json.dumps({'candidates': entries}))
        return str(path)

    def test_the_code_is_bound_into_the_digest_and_counted_in_the_always_on_growth(self):
        text = {'guidanceSupplement': 'Call the scale tool for any named score.', 'skills': []}
        path = self.bundles([{'title': 'scales', 'bundle': text, 'code': TOOL_CODE}])
        (arm, record), = eha.candidate_arms(path, IMAGE, 'tool-patch').items()
        self.assertEqual(record['digest'], eha.harness_patch_digest(text, IMAGE, TOOL_CODE))
        self.assertNotEqual(record['digest'], eha.harness_patch_digest(text, IMAGE), 'the same text without its code is another candidate')
        self.assertEqual(arm, f'cand-{record["digest"][:12]}')
        self.assertEqual(record['alwaysOnChars'], len(text['guidanceSupplement']) + 420)
        self.assertEqual(record['code']['files'][0]['path'], 'runtime/mcp/evimed-research/data/index.json', 'files are sorted by path')
        for change in ({'patchSha256': '00' * 32}, {'toolCatalogueChars': 421}, {'image': {'id': 'lane-image-1-delta', 'digest': 'ce' * 32}},
                       {'files': TOOL_CODE['files'][:1]}):
            other = eha.harness_patch_digest(text, IMAGE, {**TOOL_CODE, **change})
            self.assertNotEqual(other, record['digest'], change)

    def test_a_tool_patch_may_have_no_text_a_harness_patch_may_not(self):
        empty = {'guidanceSupplement': '', 'skills': []}
        (_, record), = eha.candidate_arms(self.bundles([{'title': 't', 'bundle': empty, 'code': TOOL_CODE}]), IMAGE, 'tool-patch').items()
        self.assertEqual(record['alwaysOnChars'], 420)
        with self.assertRaises(eha.ExportError):
            eha.candidate_arms(self.bundles([{'title': 't', 'bundle': empty}]), IMAGE, 'harness-patch')

    def test_the_surfaces_refuse_each_others_candidates_and_a_malformed_code(self):
        text = {'guidanceSupplement': 'g', 'skills': []}
        with self.assertRaisesRegex(eha.ExportError, 'has no code'):
            eha.candidate_arms(self.bundles([{'title': 't', 'bundle': text}]), IMAGE, 'tool-patch')
        with self.assertRaisesRegex(eha.ExportError, 'holds code'):
            eha.candidate_arms(self.bundles([{'title': 't', 'bundle': text, 'code': TOOL_CODE}]), IMAGE, 'harness-patch')
        for bad in ({**TOOL_CODE, 'extra': 1}, {**TOOL_CODE, 'files': []}, {**TOOL_CODE, 'patchSha256': 'XYZ'}, {**TOOL_CODE, 'toolCatalogueChars': -1},
                    {**TOOL_CODE, 'files': [{'path': '../etc/passwd', 'sha256': '12' * 32}]}, {**TOOL_CODE, 'files': [{'path': '/abs/x.py', 'sha256': '12' * 32}]},
                    {**TOOL_CODE, 'files': TOOL_CODE['files'] * 2}):
            with self.assertRaises(eha.ExportError, msg=str(bad)[:60]):
                eha.candidate_arms(self.bundles([{'title': 't', 'bundle': text, 'code': bad}]), IMAGE, 'tool-patch')

    def test_the_exported_source_carries_the_code_on_the_arm(self):
        tmp = tempfile.TemporaryDirectory(prefix='tool-patch-export-')
        self.addCleanup(tmp.cleanup)
        lab = Lab(self)
        text = {'guidanceSupplement': 'Call the scale tool.', 'skills': []}
        bundles = Path(tmp.name) / 'bundles.json'
        bundles.write_text(json.dumps({'candidates': [{'title': 'scales', 'bundle': text, 'code': TOOL_CODE}]}))
        (arm, record), = eha.candidate_arms(str(bundles), IMAGE, 'tool-patch').items()
        lab.fill('baseline', ['1', '2'])
        lab.fill(arm, ['1', '2'])
        code, _, err = lab.run(lab.argv(arms=('baseline', arm), rows=('1', '2'), extra=['--surface', 'tool-patch']) + ['--bundles', str(bundles)])
        self.assertEqual(code, 0, err)
        self.assertEqual(lab.load()['arms'][arm]['harness']['code'], record['code'])
        # the same arm directory exported as a harness patch is refused
        code, _, err = lab.run(lab.argv(arms=('baseline', arm), rows=('1', '2'), out='again.json') + ['--bundles', str(bundles)])
        self.assertEqual(code, 2)
        self.assertIn('holds code', err)


if __name__ == '__main__':
    unittest.main()
