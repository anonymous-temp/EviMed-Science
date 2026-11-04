"""Tests of drb_confirmation_packets.py over synthetic runs and criteria (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_drb_confirmation_packets.py'   (from evals/public-benchmarks)
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import drb_confirmation_packets as dcp  # noqa: E402
import export_harness_arms as eha  # noqa: E402
import register_round as rr  # noqa: E402

CAND = 'cand-0123456789ab'
DEV = ['1', '2']
CONF = ['11', '12']


class Packets(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='drb-conf-packets-test-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / 'pools.json').write_text(json.dumps({'digest': 'p' * 64, 'bench': 'deepresearchbench', 'pools': {'main': {'development': DEV, 'confirmation': CONF}}}))
        self.registration = self.dir / 'registration.json'
        noise = self.dir / 'judge-noise.json'  # the judge's measurement (noise_sample.py band), pairwise DRB on the verdict's 0-1 scale
        noise.write_text(json.dumps({'schema': 'judge-noise/2', 'scale': 'verdict-0-1', 'families': {'drb': {'pairwise': {
            'form': 'pairwise', 'scale': 'verdict-0-1', 'agreement': 0.9, 'noiseSd': 0.01, 'noiseBand95': 0.02}}}}))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = rr.main(['--round', 'r', '--family', 'drb', '--benchmark', 'deepresearchbench', '--scorer', 'judged-verdicts', '--pools', str(self.dir / 'pools.json'),
                            '--salt', 's', '--repeats-confirmation', '2', '--failure-slice', 'Art', '--candidates-max', '1', '--out', str(self.registration),
                            '--judge-id', 'claude-judge', '--judge-provider', 'anthropic', '--judge-model', 'claude-sonnet-5-5', '--judge-effort', 'medium', '--judge-form', 'pairwise',
                            '--judge-passes', '2', '--judge-max-calls', '50', '--judge-noise', str(noise), '--judge-noise-key', 'drb'])
        self.assertEqual(code, 0)
        self.results = self.dir / 'results'
        self.criteria = self.dir / 'criteria'
        self.criteria.mkdir()
        for row in CONF:
            (self.criteria / f'{row}.json').write_text(json.dumps({'id': row, 'prompt': f'PROMPT-{row}', 'dimension_weight': {'d': 1}, 'criterions': {'d': [{'criterion': 'c', 'weight': 1}]}}))
        for row in CONF:
            for repeat in range(2):
                self.run_folder('baseline', row, repeat, f'BASE-REPORT-{row}-{repeat}')
                self.run_folder(CAND, row, repeat, f'CAND-REPORT-{row}-{repeat}')

    def run_folder(self, arm, row, repeat, text, status='succeeded'):
        key = eha.run_key(eha.DEFAULT_KEY_TEMPLATE, 'drb-rsi', arm, row, repeat, 2)
        folder = eha.result_folder(self.results / arm, key)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'result.json').write_text(json.dumps({'status': status}))
        (folder / 'answer.md').unlink(missing_ok=True)
        if text is not None:
            (folder / 'answer.md').write_text(text)
        return folder

    def run_tool(self, *extra):
        argv = ['--registration', str(self.registration), '--results', str(self.results), '--bench-key', 'drb-rsi', '--candidate', CAND, '--criteria-dir', str(self.criteria),
                '--out', str(self.dir / 'packets'), *extra]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = dcp.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_a_packet_per_pair_and_pass_with_the_operator_files_the_exporter_reads(self):
        code, out, err = self.run_tool()
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(out.strip(), '4 pairs x 2 passes = 8 packets; 0 pair(s) without a packet')
        judge = self.dir / 'packets' / 'judge' / 'drb-pair-1'
        self.assertEqual(sorted(p.name for p in judge.iterdir()), ['11r0', '11r1', '12r0', '12r1'])
        self.assertEqual(sorted(p.name for p in (judge / '11r0').iterdir()), ['pass1', 'pass2'])
        self.assertEqual((judge / '11r0' / 'pass1' / 'task.txt').read_text(), 'PROMPT-11')
        self.assertEqual(json.loads((judge / '11r0' / 'pass1' / 'meta.json').read_text()), {'key': 'drb-pair/11r0/p1', 'criteria': 1})
        operator = self.dir / 'packets' / 'operator'
        order = json.loads((operator / 'order' / 'drb-pair-1' / 'order.json').read_text())
        self.assertEqual(order['arms'], {'a': 'baseline', 'b': CAND})
        self.assertEqual(sorted(order['tasks']), ['11r0', '11r1', '12r0', '12r1'])
        self.assertTrue((operator / 'order' / 'drb-pair-1' / '11r0' / 'pass1' / 'criteria.json').is_file())
        self.assertEqual(json.loads((operator / 'pair-map' / 'drb-pair-1.json').read_text())['12r1'], {'row': '12', 'repeat': 1, 'arm': CAND})
        manifest = json.loads((operator / 'manifest.json').read_text())
        self.assertEqual((manifest['pairs'], manifest['packets'], manifest['skipped']), (4, 8, []))

    def test_the_judge_tree_names_no_arm_and_each_pair_shows_both_orders(self):
        self.run_tool()
        judge = self.dir / 'packets' / 'judge'
        seen = set()
        for path in judge.rglob('*'):
            if path.is_file():
                text = path.read_text()
                self.assertNotIn('baseline', text)
                self.assertNotIn(CAND, text)
                self.assertNotIn('drb-rsi', text)
        for label in ('11r0', '11r1', '12r0', '12r1'):
            firsts = {(judge / 'drb-pair-1' / label / f'pass{k}' / 'report_1.md').read_text().split('-')[0] for k in (1, 2)}
            seen.add(frozenset(firsts))
            self.assertEqual(firsts, {'BASE', 'CAND'}, label)  # the swapped couple shows each arm first once

    def test_a_candidate_that_did_not_deliver_has_no_packet_and_a_baseline_without_a_report_is_an_empty_report(self):
        self.run_folder(CAND, '11', 1, 'draft', status='timeout')
        self.run_folder('baseline', '12', 0, None, status='failed')
        code, out, _ = self.run_tool()
        self.assertEqual(code, 0)
        self.assertIn('3 pairs x 2 passes = 6 packets; 1 pair(s) without a packet', out)
        judge = self.dir / 'packets' / 'judge' / 'drb-pair-1'
        self.assertFalse((judge / '11r1').exists())
        texts = [(judge / '12r0' / f'pass{k}' / name).read_text() for k in (1, 2) for name in ('report_1.md', 'report_2.md')]
        self.assertEqual(sorted(t == '' for t in texts), [False, False, True, True])
        manifest = json.loads((self.dir / 'packets' / 'operator' / 'manifest.json').read_text())
        self.assertEqual(manifest['skipped'], [{'label': '11r1', 'why': 'candidate run did not deliver (timeout)'}])

    def test_a_run_that_is_not_there_or_a_registration_that_does_not_verify_stops_the_call(self):
        import shutil
        shutil.rmtree(eha.result_folder(self.results / CAND, eha.run_key(eha.DEFAULT_KEY_TEMPLATE, 'drb-rsi', CAND, '12', 1, 2)))
        code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn('not in --results', err)
        document = json.loads(self.registration.read_text())
        document['rows']['confirmation'].reverse()
        self.registration.write_text(json.dumps(document))
        code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn('does not verify', err)


if __name__ == '__main__':
    unittest.main()
