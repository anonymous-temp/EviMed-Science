"""Tests of score_round.py over synthetic lane bundles and gold (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_score_round.py'   (from evals/public-benchmarks; needs node for the lab scorers)
"""
import contextlib
import io
import json
import pathlib
import shutil
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import build_round_gold as brg  # noqa: E402
import round_fixture as fx  # noqa: E402
import round_lib as rl  # noqa: E402
import score_round as sr  # noqa: E402

HAVE_NODE = shutil.which('node') is not None


@unittest.skipUnless(HAVE_NODE, 'node is needed for the lab scorers')
class Scoring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='score-round-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = fx.make_bench(self.tmp.name)
        self.rows_file = str(fx.write_rows(self.root / 'rows.json'))
        brg.build(self.root, rl.load_rows_files([self.rows_file]))
        self.inbox = self.root / 'inbox'
        self.archive = self.inbox / 'archive'
        self.cache = pathlib.Path(self.tmp.name) / 'cache'

    def score(self, *arms, domains=None, repeats=1, requests=None, extra=()):
        argv = ['--bench-root', str(self.root), '--rows', self.rows_file, '--inbox', str(self.inbox), '--inbox', str(self.archive), '--cache', str(self.cache),
                '--out', str(self.root / 'out.json'), '--requests', str(requests or self.root / 'none.jsonl'), '--repeats', str(repeats), *extra]
        for arm in arms:
            argv += ['--arm', arm]
        if domains:
            argv += ['--domains', domains]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sr.main(argv)
        self.assertEqual(code, 0, err.getvalue())
        return json.loads((self.root / 'out.json').read_text()), out.getvalue()

    def medcalc(self, arm_prefix, row, **kw):
        rid = f'{arm_prefix}.medcalc.{row}.r{kw.pop("repeat", 0)}'
        return fx.bundle(kw.pop('inbox', self.inbox), rid, 'medcalc', row, **kw)

    def arm(self, report, domain='medcalc', name='base'):
        return report['families'][domain]['arms'][name]

    # ------------------------------------------------------------------------------------------------ infrastructure is never a zero

    def test_an_infrastructure_failure_is_listed_apart_and_is_not_a_zero(self):
        self.medcalc('s1', '101', answer='Final answer: 8.0')
        self.medcalc('s1', '102', answer='Final answer: 3')
        self.medcalc('s1', '103', answer=None, status='driver_error', error_code=None, extra_result={'infrastructureFailure': True})
        report, text = self.score('base=s1', domains='medcalc')
        arm = self.arm(report)
        self.assertEqual((arm['runsOk'], arm['runsPresent'], [i['rid'] for i in arm['infra']]), (2, 3, ['s1.medcalc.103.r0']))
        self.assertEqual((arm['score']['mean'], arm['score']['n']), (1.0, 2))  # zero-filling the failure would give 0.667
        self.assertEqual(arm['perRow'], {'101': 1.0, '102': 1.0})
        self.assertIn('infrastructure (1): 103.r0 (infrastructureFailure)', text)

    def test_every_infrastructure_signal_the_exporter_knows_is_infrastructure(self):
        cases = [('101', dict(status='failed', error_code='runtime_stopped')), ('102', dict(status='interrupted')), ('103', dict(status='canceled'))]
        for row, kw in cases:
            self.medcalc('s1', row, answer=None, **kw)
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual((arm['runsOk'], len(arm['infra']), arm['score']['n']), (0, 3, 0))

    def test_a_succeeded_run_whose_transcript_was_not_captured_is_infrastructure(self):
        self.medcalc('s1', '101', extra_result={'capture': {'transcript': 'failed'}})
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual((arm['runsOk'], len(arm['infra'])), (0, 1))

    def test_a_genuine_non_delivery_scores_zero_even_with_a_correct_looking_answer_file(self):
        self.medcalc('s1', '101', status='failed', error_code='model_error', answer='Final answer: 8.0')
        self.medcalc('s1', '102', answer='Final answer: 3')
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual((arm['runsOk'], arm['status'], arm['perRow']), (2, {'failed': 1, 'succeeded': 1}, {'101': 0.0, '102': 1.0}))
        self.assertEqual(arm['score']['mean'], 0.5)

    def test_a_timeout_is_zero_strict_and_its_draft_is_scored_apart(self):
        self.medcalc('s1', '101', status='timeout', answer='Final answer: 8.0', extra_result={'deliveredWithinCap': False, 'lastReport': {'path': 'report/draft.md', 'bytes': 9, 'saved': True}})
        self.medcalc('s1', '102', answer='Final answer: 3')
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual((arm['timeouts'], arm['perRow']['101'], arm['scoreAtCap']['mean']), (1, 0.0, 1.0))
        self.assertEqual((arm['atCap']['withDraft'], arm['atCap']['withSavedDraft'], arm['delivered'], arm['deliveredRate']), (1, 1, 1, 0.5))

    def test_missing_runs_are_listed_and_distinguished_from_runs_never_requested(self):
        self.medcalc('s1', '101')
        requests = self.root / 'requests.jsonl'
        requests.write_text(json.dumps(fx.request('s1.medcalc.101.r0', 'medcalc', '101', 'q')) + '\n' + json.dumps(fx.request('s1.medcalc.102.r0', 'medcalc', '102', 'q')) + '\n')
        report, text = self.score('base=s1', domains='medcalc', requests=requests)
        arm = self.arm(report)
        self.assertEqual((arm['runsOk'], arm['missing'], arm['notRequested']), (1, ['s1.medcalc.102.r0', 's1.medcalc.103.r0'], ['s1.medcalc.103.r0']))
        self.assertEqual(report['totals'], {'expected': 3, 'ok': 1, 'missing': 2, 'infra': 0, 'corrupt': 0})
        self.assertIn('missing (2): 102.r0, 103.r0', text)

    def test_an_altered_bundle_or_another_item_in_it_is_corrupt_not_scored(self):
        self.medcalc('s1', '101', tamper=True)
        self.medcalc('s1', '102', key='medcalc/777')
        self.medcalc('s1', '103')
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual((arm['runsOk'], sorted(c['rid'] for c in arm['corrupt']), arm['score']['n']), (1, ['s1.medcalc.101.r0', 's1.medcalc.102.r0'], 1))

    def test_archived_bundles_are_found(self):
        self.medcalc('s1', '101', inbox=self.archive, archived=True)
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual(arm['runsOk'], 1)

    def test_a_bundle_that_has_left_the_inbox_still_counts_once_it_was_unpacked(self):
        path = self.medcalc('s1', '101')
        self.score('base=s1', domains='medcalc')
        path.unlink()
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual((arm['runsOk'], len(arm['missing'])), (1, 2))

    def test_hostile_archive_members_are_never_extracted(self):
        fx.bundle(self.inbox, 's1.medcalc.101.r0', 'medcalc', '101', hostile=True)
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual(arm['runsOk'], 1)
        extracted = sorted(p.relative_to(self.cache.parent).as_posix() for p in self.cache.parent.rglob('*') if p.name in ('escape.txt', 'link', 'other-run'))
        self.assertEqual(extracted, [])

    def test_bundles_for_rows_nobody_asked_for_are_reported(self):
        self.medcalc('s1', '101')
        self.medcalc('s1', '999')
        report, text = self.score('base=s1', domains='medcalc')
        self.assertEqual(report['unexpected'], {'base': ['s1.medcalc.999.r0']})
        self.assertIn('bundles in the inbox for rows not in the rows files (1)', text)

    # ------------------------------------------------------------------------------------------------ the numbers

    def test_scores_are_the_lab_scorers_and_slices_follow_the_calculator(self):
        self.medcalc('s1', '101', answer='Final answer: 8.0')
        self.medcalc('s1', '102', answer='Final answer: 4')
        self.medcalc('s1', '103', answer='Final answer: 12.5')
        report, text = self.score('base=s1', domains='medcalc')
        self.assertEqual(self.arm(report)['perRow'], {'101': 1.0, '102': 0.0, '103': 1.0})
        slices = report['families']['medcalc']['slices']['base']
        self.assertEqual(slices['2 Creatinine Clearance'], {'n': 2, 'mean': 1.0})
        self.assertEqual(slices['4 Some Score'], {'n': 1, 'mean': 0.0})
        self.assertIn('### medcalc by calculatorId', text)

    def test_paired_difference_is_over_rows_scored_in_both_arms(self):
        for row, ans in (('101', 'Final answer: 8.0'), ('102', 'Final answer: 9'), ('103', 'Final answer: 12.5')):
            self.medcalc('s1', row, answer=ans, cost=0.02)
        for row, ans in (('101', 'Final answer: 8.0'), ('102', 'Final answer: 3'), ('103', 'Final answer: 99')):
            self.medcalc('s2', row, answer=ans, cost=0.04)
        report, text = self.score('base=s1', 'cand=s2', domains='medcalc')
        paired = report['families']['medcalc']['paired']['cand']
        self.assertEqual((paired['score']['rows'], paired['score']['mean'], (paired['score']['better'], paired['score']['same'], paired['score']['worse'])), (3, 0.0, (1, 1, 1)))
        self.assertEqual(len(paired['score']['ci95']), 2)
        self.assertAlmostEqual(paired['costCny']['mean'], 0.02)
        self.assertIn('| medcalc | cand | score | 3 |', text)

    def test_a_row_scored_by_one_arm_only_is_not_in_the_paired_difference(self):
        for row in ('101', '102'):
            self.medcalc('s1', row)
        self.medcalc('s2', '101')
        paired = self.score('base=s1', 'cand=s2', domains='medcalc')[0]['families']['medcalc']['paired']['cand']
        self.assertEqual(paired['score']['rows'], 1)

    def test_repeats_are_averaged_per_row_before_anything_else(self):
        self.medcalc('s1', '101', repeat=0, answer='Final answer: 8.0')
        self.medcalc('s1', '101', repeat=1, answer='Final answer: 1')
        arm = self.arm(self.score('base=s1', domains='medcalc', repeats=2)[0])
        self.assertEqual((arm['perRow'], arm['runsExpected'], arm['runsOk']), ({'101': 0.5}, 6, 2))

    def test_cost_time_tools_and_unsettled_cost(self):
        self.medcalc('s1', '101', cost=0.10, minutes=2.0)
        self.medcalc('s1', '102', cost=0.30, minutes=4.0, extra_result={'cost': {'cost': 9.9, 'openCost': 1, 'uncertain': 0}})
        self.medcalc('s1', '103', cost=0.20, minutes=6.0)
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertAlmostEqual(arm['costCny']['total'], 0.30)
        self.assertEqual((arm['costCny']['unsettled'], arm['costCny']['median']), (1, 0.15000000000000002))
        self.assertEqual((arm['minutes']['median'], arm['toolCalls']['median']), (4.0, 3))

    def test_language_mismatch_and_contamination_are_counted(self):
        self.medcalc('s1', '101', answer='最终答案：8.0。' + '这是一个很长的中文回答，说明了计算的过程和结果。' * 4,
                     lane={'contamination': {'count': 2, 'hits': [{'names': ['medcalc-bench']}, {'names': ['bixbench']}], 'names': [], 'scanned': True}})
        self.medcalc('s1', '102', answer='Final answer: 3. This is a long english answer explaining the calculation and its result in detail.')
        requests = self.root / 'requests.jsonl'
        requests.write_text(''.join(json.dumps(fx.request(f's1.medcalc.{r}.r0', 'medcalc', r, 'Here is the patient note with an English question that asks for a calculation of the score.')) + '\n' for r in ('101', '102')))
        arm = self.arm(self.score('base=s1', domains='medcalc', requests=requests)[0])
        self.assertEqual((arm['languageMismatch']['rids'], arm['contamination']['runs'], arm['contamination']['hits']), (['s1.medcalc.101.r0'], 1, 2))

    def test_the_json_keeps_one_line_per_run_with_numbers_and_no_text(self):
        self.medcalc('s1', '101', answer='Final answer: 8.0 SECRET-ANSWER-TEXT')
        self.medcalc('s1', '102', answer=None, status='driver_error', extra_result={'infrastructureFailure': True})
        runs = {r['row']: r for r in self.arm(self.score('base=s1', domains='medcalc')[0])['runs']}
        self.assertEqual((runs['101']['state'], runs['101']['score'], runs['101']['toolCalls'], runs['101']['delivered']), ('ok', 1.0, 3, True))
        self.assertEqual((runs['102']['state'], runs['102']['reason']), ('infra', 'infrastructureFailure'))
        self.assertEqual(runs['103']['state'], 'missing')
        self.assertNotIn('SECRET-ANSWER-TEXT', (self.root / 'out.json').read_text())

    def test_lane_flags_are_reported_but_the_run_stays_in_the_means(self):
        self.medcalc('s1', '101', lane={'claimLost': True, 'runtimeKeyless': {'ok': False, 'failures': ['x']}})
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertEqual((arm['runsOk'], arm['flags']), (1, [{'rid': 's1.medcalc.101.r0', 'flags': ['claimLost', 'runtimeNotKeyless']}]))

    # ------------------------------------------------------------------------------------------------ the other families

    def test_mbc_is_the_lab_scorer_and_a_case_for_a_judge_is_counted_not_credited(self):
        for row, ans in (('0', 'Ingredient: ASPIRIN SODIUM'), ('1', 'Company: Acme Pharma Inc.'), ('2', 'Date: 2031')):
            fx.bundle(self.inbox, f's1.mbc.{row}.r0', 'mbc', row, answer=ans)
        report, _ = self.score('base=s1', domains='mbc')
        arm = self.arm(report, 'mbc')
        self.assertEqual(arm['perRow'], {'0': 0.0, '1': 1.0, '2': 1.0})
        self.assertEqual(arm['mbc'], {'correct': 2, 'needsJudge': 1, 'incorrect': 0, 'upperRunShare': 1.0})

    def test_arb_deep_and_wide(self):
        fx.bundle(self.inbox, 's1.arb-deep.deep-0.r0', 'arb-deep', 'deep-0', answer='Final answer: Alpha Network For Graphs (arXiv:2401.00001)')
        fx.bundle(self.inbox, 's1.arb-deep.deep-1.r0', 'arb-deep', 'deep-1', answer='Final answer: Some Paper (arXiv:2401.99999)')
        fx.bundle(self.inbox, 's1.arb-wide.wide-3.r0', 'arb-wide', 'wide-3', answer='Final answer:\nOne Paper (arXiv:2401.00010)\nOther Paper (arXiv:2401.77777)')
        report, _ = self.score('base=s1', domains='arb-deep,arb-wide')
        self.assertEqual(self.arm(report, 'arb-deep')['perRow'], {'deep-0': 1.0, 'deep-1': 0.0})
        self.assertAlmostEqual(self.arm(report, 'arb-wide')['perRow']['wide-3'], 1 / 3)

    def test_bixbench_is_a_floor_judge_only_capsules_are_named_and_the_open_share_is_stated(self):
        fx.bundle(self.inbox, 's1.bixbench.bix-1.r0', 'bixbench', 'bix-1', answer='Final answers:\n1. SNP rs42\n2. 1.5\n3. enriched in T cells')
        fx.bundle(self.inbox, 's1.bixbench.bix-2.r0', 'bixbench', 'bix-2', answer='Final answers:\n1. a\n2. b')
        report, text = self.score('base=s1', domains='bixbench')
        arm = self.arm(report, 'bixbench')
        self.assertEqual(arm['perRow'], {'bix-1': 1.0})
        self.assertEqual(arm['judgeOnlyRuns'], ['s1.bixbench.bix-2.r0'])
        self.assertEqual({k: arm['bixbench'][k] for k in ('questions', 'deterministic', 'open', 'needsJudge')}, {'questions': 5, 'deterministic': 2, 'open': 3, 'needsJudge': 3})
        self.assertAlmostEqual(arm['bixbench']['needsJudgeShare'], 0.6)
        self.assertIn('3/5 questions need a judge', text)
        self.assertEqual(arm['scorerErrors'], [])
        capsules = report['families']['bixbench']['slices']['base']
        self.assertEqual({k: (v['mean'], v['note']) for k, v in capsules.items()}, {'bix-1 transcriptomics': (1.0, None), 'bix-2 transcriptomics': (None, 'judge-only'),
                                                                                  'bix-3 transcriptomics': (None, 'missing')})
        self.assertIn('### bixbench by capsule', text)
        self.assertIn('| bix-2 transcriptomics | judge-only |', text)

    def test_judged_families_get_delivery_time_and_cost_and_no_score(self):
        fx.bundle(self.inbox, 's1.drb.11.r0', 'drb', '11', answer='a report summary')
        fx.bundle(self.inbox, 's1.rcb.Earth_001.r0', 'rcb', 'Earth_001', answer='done', status='timeout', extra_result={'deliveredWithinCap': False})
        report, text = self.score('base=s1', domains='drb,rcb')
        drb, rcb = self.arm(report, 'drb'), self.arm(report, 'rcb')
        self.assertEqual((drb['score'], drb['runsOk'], drb['delivered'], rcb['timeouts']), (None, 1, 1, 1))
        self.assertIn('| drb | base | 1/2 | judged |', text)

    def test_drb_language_comes_from_the_registered_language_when_there_is_no_request(self):
        fx.bundle(self.inbox, 's1.drb.12.r0', 'drb', '12', answer='This report is written in English although the task is registered as Chinese. ' * 3)
        arm = self.arm(self.score('base=s1', domains='drb')[0], 'drb')
        self.assertEqual(arm['languageMismatch']['rids'], ['s1.drb.12.r0'])

    # ------------------------------------------------------------------------------------------------ integrity

    def test_a_confirmation_id_in_the_rows_file_is_refused_and_nothing_is_written(self):
        bad = fx.write_rows(self.root / 'bad.json', {'medcalc': ['101', '900']})
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sr.main(['--bench-root', str(self.root), '--rows', str(bad), '--arm', 'base=s1', '--inbox', str(self.inbox), '--cache', str(self.cache),
                            '--out', str(self.root / 'refused.json')])
        self.assertEqual(code, 2)
        self.assertIn('900 (on the confirmation list)', err.getvalue())
        self.assertFalse((self.root / 'refused.json').exists())
        self.assertFalse(self.cache.exists() and any(self.cache.iterdir()))

    def test_scoring_needs_the_gold_that_build_round_gold_wrote(self):
        shutil.rmtree(self.root / 'rsi/score/gold')
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sr.main(['--bench-root', str(self.root), '--rows', self.rows_file, '--arm', 'base=s1', '--inbox', str(self.inbox), '--cache', str(self.cache)])
        self.assertEqual(code, 2)
        self.assertIn('build_round_gold.py', err.getvalue())

    def test_no_question_and_no_gold_in_the_output(self):
        self.medcalc('s1', '101')
        fx.bundle(self.inbox, 's1.mbc.0.r0', 'mbc', '0', answer='Ingredient: ASPIRIN')
        fx.bundle(self.inbox, 's1.bixbench.bix-1.r0', 'bixbench', 'bix-1', answer='Final answers:\n1. SNP rs42\n2. 1.5\n3. x')
        report, text = self.score('base=s1')
        blob = text + (self.root / 'out.json').read_text()
        for secret in (fx.GOLD_MARK, fx.QUESTION_MARK, 'ASPIRIN', 'rs42', 'Alpha Network', 'enriched in T cells'):
            self.assertNotIn(secret, blob)

    def test_the_cache_is_reused_until_the_bundle_changes(self):
        path = self.medcalc('s1', '101', answer='Final answer: 8.0')
        self.score('base=s1', domains='medcalc')
        marker = self.cache / 's1.medcalc.101.r0' / '.sha256'
        before = marker.read_text()
        self.score('base=s1', domains='medcalc')
        self.assertEqual(marker.read_text(), before)
        self.medcalc('s1', '101', answer='Final answer: 1')
        arm = self.arm(self.score('base=s1', domains='medcalc')[0])
        self.assertNotEqual(marker.read_text(), before)
        self.assertEqual(arm['perRow'], {'101': 0.0})

    def test_arms_must_have_distinct_names_and_prefixes(self):
        for specs in (['a=s1', 'a=s2'], ['a=s1', 'b=s1'], ['nameonly']):
            with self.assertRaises(rl.RoundError):
                sr.parse_arms(specs)


if __name__ == '__main__':
    unittest.main()
