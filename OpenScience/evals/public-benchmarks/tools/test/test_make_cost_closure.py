"""Tests of make_cost_closure.py over synthetic result.json files and a synthetic confirmation source (never real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_make_cost_closure.py'   (from evals/public-benchmarks)
"""
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import make_cost_closure as mcc  # noqa: E402


class Closure(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cost-closure-test-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def result(self, name, run_id, cost, status='succeeded'):
        path = self.dir / f'{name}.json'
        record = {'runId': run_id, 'status': status}
        if cost is not None:
            record['cost'] = cost
        path.write_text(json.dumps(record))
        return path

    def source(self, runs, name='inputs.json', wrap=True):
        source = {'kind': 'harness-arms', 'role': 'confirmation', 'benchmark': 'medcalc-bench', 'runs': runs}
        path = self.dir / name
        path.write_text(json.dumps({'sources': {'development-2026-11': {'role': 'development', 'runs': []}, 'confirmation-2026-11': source}} if wrap else source))
        return path

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mcc.main(argv)
        return code, out.getvalue(), err.getvalue()

    def runs(self):
        return [{'row': '601', 'arm': 'baseline', 'repeat': 2, 'runId': 'run-a', 'status': 'succeeded', 'cost': None},
                {'row': '612', 'arm': 'baseline', 'repeat': 1, 'runId': 'run-b', 'status': 'succeeded', 'cost': None},
                {'row': '601', 'arm': 'baseline', 'repeat': 0, 'runId': 'run-c', 'status': 'succeeded', 'cost': 0.1}]

    def test_the_ledger_record_of_each_run_is_collected_with_its_digest(self):
        a = self.result('a', 'run-a', {'cost': 0.186506, 'openCost': 0.005, 'uncertain': 1, 'calls': 23})
        b = self.result('b', 'run-b', {'cost': 0.14203, 'openCost': 0.174, 'uncertain': 0, 'calls': 16})
        out = self.dir / 'cost-closure.json'
        code, stdout, err = self.run_main(['--benchmark', 'medcalc-bench', '--run', f'612:baseline:1={b}', '--run', f'601:baseline:2={a}', '--source', str(self.source(self.runs())), '--out', str(out)])
        self.assertEqual((code, err), (0, ''), err)
        document = json.loads(out.read_text())
        self.assertEqual((document['kind'], document['schema'], document['benchmark']), ('harness-cost-closure', 1, 'medcalc-bench'))
        self.assertEqual([(r['row'], r['arm'], r['repeat'], r['runId']) for r in document['runs']], [('601', 'baseline', 2, 'run-a'), ('612', 'baseline', 1, 'run-b')])
        self.assertEqual(document['runs'][0]['ledger'], {'cost': 0.186506, 'openCost': 0.005, 'uncertain': 1, 'calls': 23})
        self.assertEqual(document['runs'][0]['resultSha256'], hashlib.sha256(a.read_bytes()).hexdigest())
        self.assertEqual(out.with_name('cost-closure.json.sha256').read_text(), f'{hashlib.sha256(out.read_bytes()).hexdigest()}  cost-closure.json\n')
        self.assertNotIn('answer', json.dumps(document), 'only ledger numbers travel')

    def test_the_runs_must_be_exactly_the_runs_without_a_cost(self):
        a = self.result('a', 'run-a', {'cost': 0.1})
        b = self.result('b', 'run-b', {'cost': 0.1})
        c = self.result('c', 'run-c', {'cost': 0.1})
        source = str(self.source(self.runs()))
        base = ['--benchmark', 'medcalc-bench', '--source', source, '--out', str(self.dir / 'o.json')]
        for runs, needle in ((['601:baseline:2=%s' % a], 'not the runs without a cost'),
                             (['601:baseline:2=%s' % a, '612:baseline:1=%s' % b, '601:baseline:0=%s' % c], 'not the runs without a cost'),
                             (['601:baseline:2=%s' % b, '612:baseline:1=%s' % a], 'the source holds run')):
            code, _, err = self.run_main(base + [x for run in runs for x in ('--run', run)])
            self.assertEqual(code, 2, runs)
            self.assertIn(needle, err)
        self.assertFalse((self.dir / 'o.json').exists())
        code, _, err = self.run_main(['--benchmark', 'bixbench', '--run', f'601:baseline:2={a}', '--source', source, '--out', str(self.dir / 'o.json')])
        self.assertEqual(code, 2)
        self.assertIn('not bixbench', err)

    def test_a_result_with_no_settled_cost_a_malformed_run_or_a_duplicate_is_refused(self):
        none = self.result('none', 'run-a', None)
        nan = self.result('nan', 'run-a', {'cost': 'unknown'})
        neg = self.result('neg', 'run-a', {'cost': -1})
        killed = self.result('killed', 'run-a', {'cost': 0.1}, status='canceled')
        ok = self.result('ok', 'run-a', {'cost': 0.1})
        for spec in (f'601:baseline:2={none}', f'601:baseline:2={nan}', f'601:baseline:2={neg}', f'601:baseline:2={killed}', f'601:baseline=:{ok}', f'601:baseline:x={ok}', '601:baseline:2'):
            code, _, err = self.run_main(['--benchmark', 'medcalc-bench', '--run', spec, '--out', str(self.dir / 'o.json')])
            self.assertEqual(code, 2, spec)
        code, _, err = self.run_main(['--benchmark', 'medcalc-bench', '--run', f'601:baseline:2={ok}', '--run', f'601:baseline:2={ok}', '--out', str(self.dir / 'o.json')])
        self.assertEqual(code, 2)
        self.assertIn('named twice', err)
        code, _, err = self.run_main(['--benchmark', 'medcalc-bench', '--out', str(self.dir / 'o.json')])
        self.assertEqual(code, 2)

    def test_a_bare_export_is_a_source_too_and_a_development_source_is_not(self):
        a = self.result('a', 'run-a', {'cost': 0.2})
        b = self.result('b', 'run-b', {'cost': 0.3})
        bare = self.source(self.runs(), name='export.json', wrap=False)
        code, _, err = self.run_main(['--benchmark', 'medcalc-bench', '--run', f'601:baseline:2={a}', '--run', f'612:baseline:1={b}', '--source', str(bare), '--out', str(self.dir / 'o.json')])
        self.assertEqual(code, 0, err)
        development = self.dir / 'dev.json'
        development.write_text(json.dumps({'kind': 'harness-arms', 'role': 'development', 'runs': []}))
        code, _, err = self.run_main(['--benchmark', 'medcalc-bench', '--run', f'601:baseline:2={a}', '--source', str(development), '--out', str(self.dir / 'p.json')])
        self.assertEqual(code, 2)
        self.assertIn('not a confirmation', err)


if __name__ == '__main__':
    unittest.main()
