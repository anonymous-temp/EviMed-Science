"""Tests of judged_packets_round.py over synthetic lane bundles (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_judged_packets_round.py'   (from evals/public-benchmarks; needs node)
"""
import contextlib
import io
import json
import pathlib
import re
import shutil
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import build_round_gold as brg  # noqa: E402
import drb_pairwise as dp  # noqa: E402
import judged_packets_round as jpr  # noqa: E402
import round_fixture as fx  # noqa: E402
import round_lib as rl  # noqa: E402

HAVE_NODE = shutil.which('node') is not None
ARM_WORDS = re.compile(r'\bs[12]\.|\bbase(line)?\b|\bcand\b|\bs[12]\b', re.I)


@unittest.skipUnless(HAVE_NODE, 'node is needed for the lab scorers')
class Packets(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='judged-packets-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = fx.make_bench(self.tmp.name)
        self.rows_file = str(fx.write_rows(self.root / 'rows.json'))
        brg.build(self.root, rl.load_rows_files([self.rows_file]))
        self.inbox = self.root / 'inbox'
        self.cache = pathlib.Path(self.tmp.name) / 'cache'
        self.out = self.root / 'packets'

    def run_packets(self, *arms, benchmarks='drb,rcb,bixbench', extra=(), expect=0, rows=None):
        argv = ['--bench-root', str(self.root), '--rows', rows or self.rows_file, '--inbox', str(self.inbox), '--cache', str(self.cache), '--out', str(self.out),
                '--requests', str(self.root / 'none.jsonl'), '--benchmarks', benchmarks, *extra]
        for arm in arms:
            argv += ['--arm', arm]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = jpr.main(argv)
        self.assertEqual(code, expect, err.getvalue())
        manifest = self.out / 'operator' / 'manifest.json'
        return json.loads(manifest.read_text()) if manifest.exists() else None, err.getvalue()

    def drb(self, prefix, row, text, **kw):
        return fx.bundle(self.inbox, f'{prefix}.drb.{row}.r0', 'drb', row, answer='short reply', files={'report/report.md': text}, **kw)

    def judge_files(self):
        return [p for p in (self.out / 'judge').rglob('*') if p.is_file()]

    def read_all(self):
        return {p.relative_to(self.out / 'judge').as_posix(): p.read_text(encoding='utf-8', errors='replace') for p in self.judge_files()}

    # ------------------------------------------------------------------------------------------------ drb pairwise

    def make_pair(self):
        self.drb('s1', '11', 'AAA-REPORT-ELEVEN')
        self.drb('s2', '11', 'BBB-REPORT-ELEVEN')
        self.drb('s1', '12', 'AAA-REPORT-TWELVE')
        fx.bundle(self.inbox, 's2.drb.12.r0', 'drb', '12', answer=None, status='failed', error_code='model_error')

    def test_pairwise_packets_are_blinded_swapped_and_the_order_stays_with_the_operator(self):
        self.make_pair()
        manifest, _ = self.run_packets('base=s1', 'cand=s2', benchmarks='drb')
        packets = {p['packet']: p for p in manifest['packets']}
        self.assertEqual((packets['drb-pair-1']['tasks'], packets['drb-pair-1']['passes']), (1, 6))
        texts = self.read_all()
        for name, text in texts.items():
            self.assertIsNone(ARM_WORDS.search(name), name)
            self.assertIsNone(ARM_WORDS.search(text), name)
        first = [json.loads(texts[f'drb-pair-1/11/pass{k}/meta.json'])['key'] for k in (1, 2)]
        self.assertEqual(first, ['drb-pair/11/p1', 'drb-pair/11/p2'])
        shown = [(texts[f'drb-pair-1/11/pass{k}/report_1.md'], texts[f'drb-pair-1/11/pass{k}/report_2.md']) for k in range(1, 7)]
        for a, b in shown:
            self.assertEqual({a, b}, {'AAA-REPORT-ELEVEN', 'BBB-REPORT-ELEVEN'})
        for couple in ((0, 1), (2, 3), (4, 5)):
            self.assertEqual(shown[couple[0]], shown[couple[1]][::-1], 'a couple of passes shows the two orders')
        self.assertFalse(any(n.endswith('order.json') for n in texts), 'the order is not in the judge tree')
        order = json.loads((self.out / 'operator/order/drb-pair-1/order.json').read_text())
        self.assertEqual(order['arms'], {'a': 'baseline', 'b': 'cand'})
        self.assertEqual(json.loads((self.out / 'operator/pair-map/drb-pair-1.json').read_text()), {'11': {'row': '11', 'repeat': 0, 'arm': 'cand'}})

    def test_the_operator_tree_aggregates_verdicts_back_to_the_arms(self):
        self.make_pair()
        self.run_packets('base=s1', 'cand=s2', benchmarks='drb', extra=['--passes', '2'])
        order_file = self.out / 'operator/order/drb-pair-1/order.json'
        order = json.loads(order_file.read_text())
        first = {k: order['tasks']['11']['passes'][str(k)]['first'] for k in (1, 2)}
        criteria = json.loads((self.out / 'judge/drb-pair-1/11/pass1/criteria.json').read_text())
        lines = []
        for k in (1, 2):
            # A judge who always prefers the candidate by 2, whichever report is shown first.
            pref = -2 if first[k] == 'a' else 2  # 'a' is the baseline arm
            lines.append(json.dumps({'key': f'drb-pair/11/p{k}', 'scores': {dim: [{'idx': i, 'pref': pref} for i in range(len(items))] for dim, items in criteria['criterions'].items()}}))
        verdicts = self.root / 'verdicts.jsonl'
        verdicts.write_text('\n'.join(lines) + '\n')
        result = dp.aggregate(order_file, [verdicts])
        self.assertEqual((result['excluded'], len(result['tasks'])), ([], 1))
        self.assertEqual(result['summary']['armA'], 'baseline')
        self.assertAlmostEqual(result['tasks'][0]['total'], -2.0)  # positive favours arm A, the baseline

    def test_a_candidate_that_did_not_deliver_has_no_packet_and_is_listed(self):
        self.make_pair()
        manifest, _ = self.run_packets('base=s1', 'cand=s2', benchmarks='drb')
        skipped = {s['rid']: s['why'] for s in manifest['packets'][0]['skipped']}
        self.assertEqual(skipped, {'s2.drb.12.r0': '12: not delivered (failed)'})
        self.assertFalse(any('/12/' in n for n in self.read_all()))

    def test_infrastructure_or_missing_runs_are_skipped_not_written_as_empty_reports(self):
        self.drb('s1', '11', 'AAA')
        fx.bundle(self.inbox, 's2.drb.11.r0', 'drb', '11', answer=None, status='driver_error', extra_result={'infrastructureFailure': True})
        fx.bundle(self.inbox, 's2.drb.12.r0', 'drb', '12', answer='x', files={'report/report.md': 'BBB'})  # the reference run of 12 is missing
        manifest, _ = self.run_packets('base=s1', 'cand=s2', benchmarks='drb')
        self.assertEqual(manifest['packets'][0]['tasks'], 0)
        whys = {s['rid']: s['why'] for s in manifest['packets'][0]['skipped']}
        self.assertTrue(whys['s2.drb.11.r0'].startswith('11: infra'))
        self.assertEqual(self.judge_files(), [])

    def test_a_run_whose_bundle_has_left_the_inbox_cannot_be_packed_and_is_listed(self):
        path = self.drb('s1', '11', 'AAA')
        self.run_packets('base=s1', benchmarks='drb')  # unpacks it into the cache
        path.unlink()
        manifest, _ = self.run_packets('base=s1', benchmarks='drb', extra=['--replace'])
        self.assertEqual((manifest['packets'][0]['tasks'], manifest['packets'][0]['skipped'][0]['why']), (0, 'the bundle has left the inbox and its files are not at hand'))

    def test_an_undelivered_reference_gives_an_empty_report_to_compare_against(self):
        fx.bundle(self.inbox, 's1.drb.11.r0', 'drb', '11', answer=None, status='failed', error_code='model_error')
        self.drb('s2', '11', 'BBB-REPORT')
        self.run_packets('base=s1', 'cand=s2', benchmarks='drb', extra=['--passes', '2'])
        texts = self.read_all()
        self.assertEqual(sorted([texts['drb-pair-1/11/pass1/report_1.md'], texts['drb-pair-1/11/pass1/report_2.md']]), ['', 'BBB-REPORT'])

    def test_each_candidate_gets_its_own_pair_against_the_reference(self):
        self.drb('s1', '11', 'AAA')
        self.drb('s2', '11', 'BBB')
        self.drb('s3', '11', 'CCC')
        manifest, _ = self.run_packets('base=s1', 'c1=s2', 'c2=s3', benchmarks='drb', extra=['--passes', '2'])
        self.assertEqual([p['packet'] for p in manifest['packets']], ['drb-pair-1', 'drb-pair-2'])
        orders = [json.loads((self.out / f'operator/order/drb-pair-{k}/order.json').read_text())['arms'] for k in (1, 2)]
        self.assertEqual(orders, [{'a': 'baseline', 'b': 'c1'}, {'a': 'baseline', 'b': 'c2'}])

    def test_an_odd_number_of_pairwise_passes_is_refused(self):
        self.make_pair()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = jpr.main(['--bench-root', str(self.root), '--rows', self.rows_file, '--arm', 'base=s1', '--arm', 'cand=s2', '--benchmarks', 'drb', '--passes', '3',
                             '--inbox', str(self.inbox), '--cache', str(self.cache), '--out', str(self.out)])
        self.assertEqual(code, 2)
        self.assertIn('even', err.getvalue())

    # ------------------------------------------------------------------------------------------------ absolute

    def test_one_arm_gets_absolute_packets_with_the_reference_and_opaque_keys(self):
        self.drb('s1', '11', 'AAA-REPORT')
        manifest, _ = self.run_packets('base=s1', benchmarks='drb')
        self.assertEqual([(p['packet'], p['tasks'], p['passes']) for p in manifest['packets']], [('drb-abs', 1, 3)])
        keys = json.loads((self.out / 'operator/keys.json').read_text())
        (key, record), = keys.items()
        self.assertRegex(key, r'^drb-abs/[0-9a-f]{10}$')
        self.assertEqual((record['arm'], record['rid'], record['row']), ('base', 's1.drb.11.r0', '11'))
        d = self.out / 'judge' / key / 'pass2'
        self.assertEqual((d / 'target.md').read_text(), 'AAA-REPORT')
        self.assertEqual((d / 'reference.md').read_text(), 'reference article 11')
        self.assertEqual(json.loads((d / 'meta.json').read_text())['key'], key)
        self.assertEqual(json.loads((d / 'criteria.json').read_text())['dimension_weight'], {'comprehensiveness': 0.5, 'insight': 0.5})
        self.assertIsNone(ARM_WORDS.search('\n'.join(self.read_all().values())))

    def test_both_forms_write_both_kinds(self):
        self.make_pair()
        manifest, _ = self.run_packets('base=s1', 'cand=s2', benchmarks='drb', extra=['--drb-form', 'both', '--passes', '2'])
        self.assertEqual(sorted(p['packet'] for p in manifest['packets']), ['drb-abs', 'drb-pair-1'])

    def test_pairwise_needs_two_arms(self):
        self.drb('s1', '11', 'AAA')
        self.run_packets('base=s1', benchmarks='drb', extra=['--drb-form', 'pairwise'], expect=2)

    # ------------------------------------------------------------------------------------------------ rcb

    def test_rcb_packet_holds_the_report_the_rubric_and_the_figures_and_later_passes_link_the_trees(self):
        fx.bundle(self.inbox, 's1.rcb.Earth_001.r0', 'rcb', 'Earth_001', answer='done', files={
            'report/report.md': '# the research report', 'report/images/f1.png': 'PNGDATA', 'code/analysis.py': 'print(1)', 'outputs/big.bin': 'x' * 10})
        manifest, _ = self.run_packets('base=s1', benchmarks='rcb')
        self.assertEqual((manifest['packets'][0]['tasks'], manifest['packets'][0]['passes']), (1, 3))
        (key,) = [k for k in json.loads((self.out / 'operator/keys.json').read_text())]
        p1, p2 = (self.out / 'judge' / key / f'pass{m}' for m in (1, 2))
        self.assertEqual((p1 / 'report.md').read_text(), '# the research report')
        self.assertTrue((p1 / 'target_study/checklist.json').is_file())
        self.assertEqual((p1 / 'target_study/images/fig1.png').read_bytes(), b'\x89PNG-target')
        self.assertEqual((p1 / 'run_files/report/images/f1.png').read_text(), 'PNGDATA')
        self.assertTrue((p1 / 'run_files/code/analysis.py').is_file())
        self.assertTrue((p2 / 'target_study').is_symlink() and (p2 / 'run_files').is_symlink())
        self.assertEqual((p2 / 'target_study/checklist.json').read_text(), (p1 / 'target_study/checklist.json').read_text())
        meta = json.loads((p1 / 'meta.json').read_text())
        self.assertEqual((meta['delivery'], meta['pass']), ('complete', 1))

    def test_the_links_are_relative_so_a_moved_packet_directory_still_reads(self):
        self.drb('s1', '11', 'AAA')
        self.drb('s2', '11', 'BBB')
        fx.bundle(self.inbox, 's1.rcb.Earth_001.r0', 'rcb', 'Earth_001', answer='done', files={'report/report.md': 'r'})
        self.run_packets('base=s1', 'cand=s2', benchmarks='drb,rcb', extra=['--passes', '2'])
        moved = pathlib.Path(self.tmp.name) / 'moved'
        shutil.move(str(self.out), str(moved))
        (key,) = [k for k in json.loads((moved / 'operator/keys.json').read_text()) if k.startswith('rcb/')]
        self.assertTrue((moved / 'judge' / key / 'pass2/target_study/checklist.json').is_file())
        self.assertTrue((moved / 'operator/order/drb-pair-1/11/pass1/criteria.json').is_file())

    def test_a_timed_out_draft_is_packed_only_when_asked_and_marked_at_cap(self):
        extra = {'lastReport': {'path': 'report/draft.md', 'bytes': 5, 'saved': True}, 'deliveredWithinCap': False}
        fx.bundle(self.inbox, 's1.rcb.Earth_001.r0', 'rcb', 'Earth_001', answer='', status='timeout', files={'report/draft.md': 'A DRAFT'}, extra_result=extra)
        manifest, _ = self.run_packets('base=s1', benchmarks='rcb')
        self.assertEqual((manifest['packets'][0]['tasks'], manifest['packets'][0]['skipped'][0]['why']), (0, 'not delivered (timeout)'))
        shutil.rmtree(self.out)
        manifest, _ = self.run_packets('base=s1', benchmarks='rcb', extra=['--at-cap'])
        self.assertEqual((manifest['packets'][0]['tasks'], manifest['atCapRids']), (1, ['s1.rcb.Earth_001.r0']))
        (key,) = json.loads((self.out / 'operator/keys.json').read_text())
        self.assertEqual(json.loads((self.out / 'judge' / key / 'pass1/meta.json').read_text())['delivery'], 'at-cap')
        self.assertEqual((self.out / 'judge' / key / 'pass1/report.md').read_text(), 'A DRAFT')

    def test_a_file_the_bundle_dropped_is_said_in_the_meta_not_hidden(self):
        fx.bundle(self.inbox, 's1.rcb.Earth_001.r0', 'rcb', 'Earth_001', answer='done', files={'report/report.md': 'r'},
                  lane={'dropped': [{'path': 'report/images/f9.png', 'bytes': 99999999, 'reason': 'over the per-file cap'}]})
        self.run_packets('base=s1', benchmarks='rcb')
        (key,) = json.loads((self.out / 'operator/keys.json').read_text())
        self.assertEqual(json.loads((self.out / 'judge' / key / 'pass1/meta.json').read_text())['bundle_dropped_files'], 1)

    # ------------------------------------------------------------------------------------------------ bixbench, mbc

    def test_bixbench_packets_hold_only_the_questions_code_leaves_to_a_judge(self):
        fx.bundle(self.inbox, 's1.bixbench.bix-1.r0', 'bixbench', 'bix-1', answer='Final answers:\n1. something else entirely\n2. 1.5\n3. enriched in T cells')
        fx.bundle(self.inbox, 's1.bixbench.bix-2.r0', 'bixbench', 'bix-2', answer='Final answers:\n1. a\n2.')
        manifest, _ = self.run_packets('base=s1', benchmarks='bixbench')
        self.assertEqual((manifest['packets'][0]['tasks'], manifest['packets'][0]['questions']), (2, 3))
        keys = json.loads((self.out / 'operator/keys.json').read_text())
        by_row = {v['row']: k for k, v in keys.items()}
        q1 = json.loads((self.out / 'judge' / by_row['bix-1'] / 'pass1/questions.json').read_text())
        self.assertEqual([q['qid'] for q in q1['questions']], ['bix-1-q1', 'bix-1-q3'])  # q2 is a range code settled as correct
        self.assertEqual(keys[by_row['bix-1']]['questions'], {'bix-1-q1': 'str_verifier', 'bix-1-q3': 'llm_verifier'})
        q2 = json.loads((self.out / 'judge' / by_row['bix-2'] / 'pass1/questions.json').read_text())
        self.assertEqual([q['qid'] for q in q2['questions']], ['bix-2-q1'], 'an unanswered question is incorrect, not for a judge')
        self.assertIn('enriched in T cells', (self.out / 'judge' / by_row['bix-1'] / 'pass1/answer.md').read_text())
        self.assertEqual(json.loads((self.out / 'judge' / by_row['bix-1'] / 'pass3/meta.json').read_text())['questions'], ['bix-1-q1', 'bix-1-q3'])

    def test_a_capsule_code_settled_completely_has_no_packet(self):
        fx.bundle(self.inbox, 's1.bixbench.bix-1.r0', 'bixbench', 'bix-1', answer='Final answers:\n1. SNP rs42\n2. 1.5\n3.')
        manifest, _ = self.run_packets('base=s1', benchmarks='bixbench')
        self.assertEqual(manifest['packets'][0]['tasks'], 0)

    def test_mbc_cases_for_a_judge_are_one_line_each(self):
        fx.bundle(self.inbox, 's1.mbc.0.r0', 'mbc', '0', answer='Ingredient: ASPIRIN SODIUM')
        fx.bundle(self.inbox, 's1.mbc.1.r0', 'mbc', '1', answer='Company: Acme Pharma')
        self.run_packets('base=s1', benchmarks='mbc')
        lines = [json.loads(l) for l in (self.out / 'judge/mbc.needs_judge.jsonl').read_text().splitlines()]
        self.assertEqual(len(lines), 1)
        self.assertEqual((lines[0]['gold'], lines[0]['extracted']), ('ASPIRIN', 'ASPIRIN SODIUM'))
        self.assertRegex(lines[0]['key'], r'^mbc/[0-9a-f]{10}$')

    # ------------------------------------------------------------------------------------------------ integrity

    def test_a_confirmation_row_is_refused_and_nothing_is_written(self):
        bad = fx.write_rows(self.root / 'bad.json', {'drb': ['11', '13']})
        self.run_packets('base=s1', benchmarks='drb', rows=str(bad), expect=2)
        self.assertFalse(self.out.exists())

    def test_packets_of_another_run_are_not_mixed_in_without_replace(self):
        self.drb('s1', '11', 'AAA')
        self.run_packets('base=s1', benchmarks='drb')
        _, err = self.run_packets('base=s1', benchmarks='drb', expect=2)
        self.assertIn('--replace', err)
        manifest, _ = self.run_packets('base=s1', benchmarks='drb', extra=['--replace'])
        self.assertEqual(manifest['packets'][0]['tasks'], 1)

    def test_keys_are_stable_and_hash_the_rid_with_the_seed(self):
        self.drb('s1', '11', 'AAA')
        self.run_packets('base=s1', benchmarks='drb')
        (key,) = json.loads((self.out / 'operator/keys.json').read_text())
        self.assertEqual(key, f'drb-abs/{jpr.opaque(jpr.DEFAULT_SEED, "drb-abs", "s1.drb.11.r0")}')

    def test_the_manifest_names_the_protocol_and_the_verdict_line_of_each_benchmark(self):
        self.drb('s1', '11', 'AAA')
        manifest, _ = self.run_packets('base=s1', benchmarks='drb')
        self.assertEqual(manifest['protocols']['rcb']['protocol'], 'judge/rcb.md')
        self.assertEqual(len(manifest['keysSha256']), 64)


if __name__ == '__main__':
    unittest.main()
