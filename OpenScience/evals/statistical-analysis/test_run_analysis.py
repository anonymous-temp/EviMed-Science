"""Execution provenance checks; no claim that hashes establish scientific validity."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[2] / 'capabilities/statistical-analysis/scripts/run_analysis.py'


class AnalysisExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data.csv').write_text('x\n1\n2\n')

    def run_script(self, source, *args):
        (self.root / 'analysis.py').write_text(source)
        return subprocess.run([sys.executable, str(HELPER), '--workspace', str(self.root),
            '--interpreter', 'python', '--script', 'analysis.py', '--input', 'data.csv',
            '--results', 'analysis-results.json', '--receipt', 'analysis-run.json', *args],
            capture_output=True, text=True)

    def receipt(self):
        return json.loads((self.root / 'analysis-run.json').read_text())['executions']

    def test_executes_records_real_hashes_and_normalizes_only_nonfinite_fields(self):
        result = self.run_script("from pathlib import Path\nPath('analysis-results.json').write_text('{\"analyses\":[{\"estimate\":2},{\"estimate\":Infinity}]}')")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((self.root / 'analysis-results.json').read_text())
        self.assertEqual([x['estimate'] for x in data['analyses']], [2, None])
        attempt = self.receipt()[0]
        self.assertEqual(attempt['inputs'][0]['sha256'], hashlib.sha256((self.root / 'data.csv').read_bytes()).hexdigest())
        self.assertEqual(attempt['script']['sha256'], hashlib.sha256((self.root / 'analysis.py').read_bytes()).hexdigest())
        self.assertEqual(attempt['argv'][0], sys.executable)
        self.assertTrue(attempt['versions']['interpreter'])
        self.assertEqual(attempt['output']['observation'], 'created')
        self.assertIn('Infinity', (self.root / attempt['output']['raw']['path']).read_text())
        self.assertEqual(attempt['warnings'][0]['field'], '$.analyses[1].estimate')

    def test_failed_followup_preserves_receipt_and_stale_output_without_certifying_it(self):
        self.assertEqual(self.run_script("from pathlib import Path\nPath('analysis-results.json').write_text('{\"analyses\":[{\"estimate\":3}]}')").returncode, 0)
        first = self.receipt()[0]
        result = self.run_script('raise ImportError("optional package missing")', '--parent', first['id'])
        self.assertNotEqual(result.returncode, 0)
        attempts = self.receipt()
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], first)
        self.assertEqual(attempts[1]['parent'], first['id'])
        self.assertEqual(attempts[1]['output']['observation'], 'unchanged')
        self.assertFalse(attempts[1]['output']['observedWrite'])
        self.assertEqual(json.loads((self.root / 'analysis-results.json').read_text())['analyses'][0]['estimate'], 3)
        self.assertNotIn('Traceback', (self.root / 'analysis-run.json').read_text())

    def test_partial_failure_keeps_new_finite_output_and_source_changes_are_visible(self):
        original = (self.root / 'data.csv').read_bytes()
        source = "from pathlib import Path\nPath('analysis-results.json').write_text('{\"analyses\":[{\"estimate\":5}]}')\nraise RuntimeError('plot failed')"
        self.assertNotEqual(self.run_script(source).returncode, 0)
        self.assertEqual(self.receipt()[0]['output']['observation'], 'created')
        self.assertEqual((self.root / 'data.csv').read_bytes(), original)
        (self.root / 'data.csv').write_text('x\n1\n2\n3\n')
        self.run_script(source)
        self.assertNotEqual(self.receipt()[0]['inputs'], self.receipt()[1]['inputs'])

    def test_rejects_escaping_and_symlink_paths_before_execution(self):
        for flag in ('--script', '--input', '--results', '--receipt', '--transform'):
            result = self.run_script("raise AssertionError('must not run')", flag, '../outside')
            self.assertNotEqual(result.returncode, 0)
        (self.root / 'escape').symlink_to(self.root.parent, target_is_directory=True)
        self.assertNotEqual(self.run_script('print(1)', '--results', 'escape/out.json').returncode, 0)
        self.assertFalse((self.root / 'analysis-run.json').exists())

    def test_changed_transform_hash_and_same_bytes_rewrite_recorded(self):
        (self.root / 'state.json').write_text('{"scale":2}')
        source = "from pathlib import Path\nPath('analysis-results.json').write_text('{\"analyses\":[{\"estimate\":2}]}')"
        self.run_script(source, '--transform', 'state.json')
        (self.root / 'state.json').write_text('{"scale":3}')
        self.run_script(source, '--transform', 'state.json')
        attempts = self.receipt()
        self.assertNotEqual(attempts[0]['transforms'], attempts[1]['transforms'])
        self.assertEqual(attempts[1]['output']['observation'], 'rewritten_same_bytes')
        self.assertTrue(attempts[1]['output']['observedWrite'])

    def test_refuses_overlapping_outputs_and_does_not_replace_invalid_receipt(self):
        result = self.run_script('print(1)', '--results', 'data.csv')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'data.csv').read_text(), 'x\n1\n2\n')
        (self.root / 'analysis-run.json').write_text('{broken')
        result = self.run_script('print(1)')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'analysis-run.json').read_text(), '{broken')


if __name__ == '__main__':
    unittest.main()
