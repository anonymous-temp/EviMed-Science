"""Tests of build_round_gold.py over a synthetic work directory (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_build_round_gold.py'   (from evals/public-benchmarks; needs node for the row check)
"""
import contextlib
import io
import json
import os
import pathlib
import shutil
import stat
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import build_round_gold as brg  # noqa: E402
import export_harness_arms as eha  # noqa: E402
import round_fixture as fx  # noqa: E402
import round_lib as rl  # noqa: E402

HAVE_NODE = shutil.which('node') is not None


def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = brg.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class Refusal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='round-gold-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = fx.make_bench(self.tmp.name)
        self.gold = self.root / 'rsi' / 'score' / 'gold'

    def rows(self, rows):
        return str(fx.write_rows(self.root / 'rows.json', rows))

    def test_a_confirmation_id_is_refused_by_name_and_nothing_is_written(self):
        code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows({'medcalc': ['101', '900']}))
        self.assertEqual(code, 2)
        self.assertIn('900 (on the confirmation list)', err)
        self.assertFalse(self.gold.exists())

    def test_one_refusal_stops_every_domain(self):
        code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows({'medcalc': ['101', '102'], 'arb-deep': ['deep-0', 'deep-2']}))
        self.assertEqual(code, 2)
        self.assertIn('deep-2 (on the confirmation list)', err)
        self.assertFalse(self.gold.exists(), 'the valid medcalc rows must not be written when another domain is refused')

    def test_every_pool_is_checked_not_only_the_first(self):
        for domain, bad in (('mbc', '3'), ('arb-wide', 'wide-4'), ('bixbench', 'bix-9'), ('drb', '13'), ('rcb', 'Earth_002')):
            with self.subTest(domain=domain):
                code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows({domain: [bad]}))
                self.assertEqual((code, f'{bad} (on the confirmation list)' in err), (2, True))

    def test_dropped_baseline_and_unknown_ids_are_refused_with_their_reason(self):
        code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows({'medcalc': ['901', '902', '5555']}))
        self.assertEqual(code, 2)
        for fragment in ('901 (dropped from confirmation)', '902 (baseline v1 row, not a development row)', '5555 (not in the pool)'):
            self.assertIn(fragment, err)

    def test_the_library_raises_the_named_refusal(self):
        with self.assertRaises(rl.Refused) as caught:
            rl.check_development(self.root, 'medcalc', ['101', '900'])
        self.assertEqual(caught.exception.problems, {'900': 'on the confirmation list'})

    def test_the_refusal_message_never_lists_the_pool_only_the_ids_asked_for(self):
        _, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows({'medcalc': ['900']}))
        self.assertNotIn('901', err)
        self.assertNotIn('102', err)


@unittest.skipUnless(HAVE_NODE, 'node is needed for the lab scorers\' row check')
class Build(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='round-gold-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = fx.make_bench(self.tmp.name)
        self.gold = self.root / 'rsi' / 'score' / 'gold'
        self.rows = str(fx.write_rows(self.root / 'rows.json'))

    def build(self, *extra):
        code, out, err = run_cli('--bench-root', str(self.root), '--rows', self.rows, *extra)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def items(self, domain):
        return [json.loads(l) for l in (self.gold / f'{domain}.items.jsonl').read_text().splitlines()]

    def test_every_domain_is_written_in_the_shape_the_exporter_reads(self):
        summary = self.build()
        self.assertEqual({d: summary[d]['rows'] for d in fx.ROWS}, {d: len(v) for d, v in fx.ROWS.items()})
        rows = {d: json.loads((self.gold / f'{d}.rows.json').read_text())['rows'] for d in fx.ROWS}
        self.assertEqual(rows['medcalc'][0], {'id': '101', 'calculatorId': 2, 'gold': {'answer': fx.GOLD_MARK, 'lower': '7.0', 'upper': '8.5'}})
        self.assertEqual({r['task'] for r in rows['mbc']}, {'Ingredient', 'Applicant_Full_Name', 'Patent_Expire_Date_Text'})
        self.assertEqual(rows['arb-deep'][1]['gold']['is_none'], True)
        self.assertEqual([r['id'] for r in rows['arb-wide']], ['wide-3'])
        self.assertEqual(sorted(rows['drb'][0]), ['category', 'id'])
        self.assertEqual(rows['rcb'], [{'id': 'Earth_001', 'category': 'Earth'}])
        bix = {r['id']: r for r in rows['bixbench']}
        self.assertEqual([q['n'] for q in bix['bix-1']['gold']['questions']], [1, 2, 3])
        self.assertEqual(bix['bix-1']['gold']['questions'][1]['range'], [1.0, 2.0])

    def test_items_are_the_bench_driver_shape_with_gold_and_no_prompt_for_code_families(self):
        self.build()
        item = self.items('medcalc')[0]
        self.assertEqual((item['key'], item['bench'], item['id'], item['scorer']), ('medcalc/101', 'medcalc', '101', 'medcalc'))
        self.assertNotIn('prompt', item)
        self.assertEqual(self.items('mbc')[0]['gold'], {'task_name': 'Ingredient', 'answer': 'ASPIRIN'})
        self.assertIn('prompt', self.items('drb')[0])  # the DRB query is public, and the judge packet takes its task text from it

    def test_the_exporter_reads_both_files_to_the_same_rows(self):
        self.build()
        for domain in fx.ROWS:
            benchmark = rl.BENCHMARK[domain]
            via_items = eha.load_rows(benchmark, [str(self.gold / f'{domain}.items.jsonl')], None)
            via_rows = eha.load_rows(benchmark, None, str(self.gold / f'{domain}.rows.json'))
            self.assertEqual(via_items, via_rows, domain)
            self.assertEqual([r['id'] for r in via_items], sorted(fx.ROWS[domain], key=rl.natural_key), domain)

    def test_idempotent_and_private(self):
        self.build()
        first = {p.name: p.read_bytes() for p in self.gold.iterdir()}
        self.build()
        self.assertEqual(first, {p.name: p.read_bytes() for p in self.gold.iterdir()})
        self.assertEqual(stat.S_IMODE(self.gold.stat().st_mode), 0o700)
        for path in self.gold.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path.name)

    def test_the_manifest_binds_the_pool_digest_and_the_outputs(self):
        self.build()
        manifest = json.loads((self.gold / 'manifest.json').read_text())
        self.assertEqual((manifest['role'], manifest['domains']['medcalc']['poolDigest']), ('development', 'd' * 64))
        self.assertEqual(manifest['domains']['medcalc']['itemsSha256'], rl.hashlib.sha256((self.gold / 'medcalc.items.jsonl').read_bytes()).hexdigest())
        self.assertEqual(manifest['domains']['medcalc']['ids'], ['101', '102', '103'])

    def test_a_second_call_for_other_domains_keeps_the_manifest_of_the_first(self):
        self.build('--domains', 'medcalc')
        code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows, '--domains', 'mbc')
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(json.loads((self.gold / 'manifest.json').read_text())['domains']), ['mbc', 'medcalc'])

    def test_bixbench_rows_code_cannot_score_are_kept_and_said_why(self):
        summary = self.build()
        self.assertEqual(summary['bixbench']['unscorableByCode'], 2)
        listed = json.loads((self.gold / 'manifest.json').read_text())['domains']['bixbench']['unscorableByCode']
        self.assertEqual(listed, {'bix-2': 'every question is for a judge', 'bix-3': 'a range with lower > upper in the dataset'})

    def test_reversed_ranges_are_swapped_only_on_request_and_recorded(self):
        self.build('--fix-reversed-ranges')
        item = next(i for i in self.items('bixbench') if i['id'] == 'bix-3')
        self.assertEqual(item['gold']['questions'][0]['range'], [4.0, 5.0])
        self.assertEqual(item['meta']['rangesSwapped'], ['bix-3-q1'])
        listed = json.loads((self.gold / 'manifest.json').read_text())['domains']['bixbench']['unscorableByCode']
        self.assertNotIn('bix-3', listed)

    def test_medcalc_rows_whose_verified_record_differs_are_listed(self):
        self.assertEqual(self.build()['notes']['medcalc'], {'verifiedRecordDiffers': ['103']})

    def test_a_bad_row_of_a_code_family_stops_the_build(self):
        data = self.root / 'data/medcalc/test_data.csv'
        data.write_text(data.read_text().replace('101,2,', '101,999,'))  # a calculator id the scorer does not know
        code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows)
        self.assertEqual(code, 2)
        self.assertIn('medcalc:101', err)

    def test_drb_criteria_for_another_prompt_is_refused(self):
        path = self.root / 'rsi/score/assets/drb/criteria/11.json'
        data = json.loads(path.read_text())
        data['prompt'] = 'another prompt'
        path.write_text(json.dumps(data))
        code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows)
        self.assertEqual(code, 2)
        self.assertIn('another prompt', err)

    def test_missing_judge_material_without_fetch_is_an_error_not_a_network_call(self):
        shutil.rmtree(self.root / 'rsi/score/assets/drb')
        code, _, err = run_cli('--bench-root', str(self.root), '--rows', self.rows, '--domains', 'drb')
        self.assertEqual(code, 2)
        self.assertIn('--fetch', err)

    def test_rcb_rubric_and_images_are_copied_for_the_development_task_only(self):
        self.build()
        base = self.root / 'rsi/score/assets/rcb'
        self.assertEqual(sorted(p.name for p in base.iterdir()), ['Earth_001'])
        self.assertTrue((base / 'Earth_001/images/fig1.png').is_file())
        item = self.items('rcb')[0]
        self.assertEqual(item['gold']['rubric'], 'assets/rcb/Earth_001/checklist.json')
        self.assertEqual((item['meta']['rubric_items'], item['meta']['rubric_image']), (2, 1))


if __name__ == '__main__':
    unittest.main()
