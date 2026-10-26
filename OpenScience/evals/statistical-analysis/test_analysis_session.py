"""Selective reuse is provenance, not proof that an analysis is scientifically valid."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[2] / 'capabilities/statistical-analysis/scripts/analysis_session.py'
COPY = Path(__file__).resolve().parents[2] / 'capability-skills/statistical-analysis/scripts/analysis_session.py'


class AnalysisSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data.csv').write_text('x\n1\n2\n')
        (self.root / 'other.csv').write_text('x\n5\n')
        self.steps = [self.step('fit', ['data.csv']), self.step('other', ['other.csv']),
                      self.step('report', ['fit.json'], ['fit'], {'unit': 'mg'})]
        self.write_spec()

    def step(self, name, inputs, dependencies=None, context=None):
        (self.root / f'{name}.py').write_text(
            "import json\nfrom pathlib import Path\n"
            f"Path('{name}.json').write_text(json.dumps({{'value': 3}}))\n")
        return {'id': name, 'script': f'{name}.py', 'interpreter': 'python',
                'inputs': inputs, 'outputs': [f'{name}.json'], 'results': f'{name}.json',
                'dependsOn': dependencies or [], 'context': context or {}}

    def write_spec(self):
        (self.root / 'session.json').write_text(json.dumps({'schemaVersion': 1, 'steps': self.steps}))

    def command(self, command='status', *extra):
        return subprocess.run([sys.executable, str(HELPER), command, '--workspace', str(self.root),
                               '--spec', 'session.json', '--state', 'state.json', *extra],
                              capture_output=True, text=True)

    def run_step(self, name, *extra):
        result = self.command('run', '--step', name, *extra)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return json.loads(result.stdout)

    def status(self):
        result = self.command()
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def flags(self):
        return {item['id']: item['reusable'] for item in self.status()['steps']}

    def complete(self):
        for step in ('fit', 'other', 'report'):
            self.run_step(step)

    def state(self):
        return json.loads((self.root / 'state.json').read_text())

    def test_missing_state_never_reuses_existing_outputs(self):
        (self.root / 'fit.json').write_text('{"value":3}')
        self.assertEqual(self.status()['state'], 'missing')
        self.assertFalse(any(self.flags().values()))

    def test_actual_execution_receipt_and_skip_then_force(self):
        first = self.run_step('fit')
        state = self.state()
        self.assertEqual(first['action'], 'executed')
        record = state['steps']['fit']
        receipt = json.loads((self.root / record['receipt']).read_text())['executions'][-1]
        self.assertEqual(record['executionId'], receipt['id'])
        self.assertTrue(receipt['output']['observedWrite'])
        self.assertEqual(record['outputs']['fit.json']['sha256'], hashlib.sha256((self.root / 'fit.json').read_bytes()).hexdigest())
        self.assertEqual(self.run_step('fit')['action'], 'reused')
        self.assertEqual(self.state(), state)
        self.run_step('fit', '--force')
        self.assertEqual(len(self.state()['history']), 2)
        self.assertNotEqual(self.state()['steps']['fit']['executionId'], record['executionId'])

    def test_report_unit_change_only_invalidates_report(self):
        self.complete()
        self.steps[2]['context']['unit'] = 'mmol/L'
        self.write_spec()
        self.assertEqual(self.flags(), {'fit': True, 'other': True, 'report': False})

    def test_input_or_code_changes_invalidate_only_branch_and_descendants(self):
        self.complete()
        (self.root / 'data.csv').write_text('x\n1\n2\n3\n')
        self.assertEqual(self.flags(), {'fit': False, 'other': True, 'report': False})
        self.run_step('fit')
        self.run_step('report')
        (self.root / 'fit.py').write_text((self.root / 'fit.py').read_text() + '\n# Updated model\n')
        self.assertEqual(self.flags(), {'fit': False, 'other': True, 'report': False})

    def test_does_not_execute_with_stale_dependency(self):
        result = self.command('run', '--step', 'report')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'report.json').exists())
        self.assertFalse((self.root / 'fit.json').exists())

    def test_output_tampering_and_missing_receipt_prevent_reuse(self):
        self.complete()
        (self.root / 'fit.json').write_text('{"value":99}')
        self.assertEqual(self.flags(), {'fit': False, 'other': True, 'report': False})
        receipt = self.state()['steps']['other']['receipt']
        (self.root / receipt).unlink()
        self.assertFalse(self.flags()['other'])

    def test_older_state_cannot_reuse_after_a_newer_receipt_attempt(self):
        self.run_step('fit')
        old_state = (self.root / 'state.json').read_bytes()
        self.run_step('fit', '--force')
        (self.root / 'state.json').write_bytes(old_state)
        self.assertFalse(self.flags()['fit'])

    def test_dependency_output_change_invalidates_downstream_even_without_input_listing(self):
        self.steps[2]['inputs'] = []
        self.write_spec()
        (self.root / 'fit.py').write_text("import uuid\nfrom pathlib import Path\nPath('fit.json').write_text('{\"value\":\"' + uuid.uuid4().hex + '\"}')\n")
        self.complete()
        before = self.state()['steps']['fit']['signature']
        self.run_step('fit', '--force')
        self.assertEqual(self.state()['steps']['fit']['signature'], before)
        self.assertFalse(self.flags()['report'])

    def test_touching_identical_input_bytes_does_not_invalidate(self):
        self.complete()
        (self.root / 'data.csv').write_bytes((self.root / 'data.csv').read_bytes())
        self.assertTrue(all(self.flags().values()))

    def test_corrupt_state_is_reported_and_retained(self):
        self.complete()
        (self.root / 'state.json').write_text('{broken')
        self.assertEqual(self.status()['state'], 'invalid')
        self.assertFalse(any(self.flags().values()))
        self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
        self.assertEqual((self.root / 'state.json').read_text(), '{broken')

    def test_failed_followup_preserves_history_and_previous_results(self):
        self.run_step('fit')
        old = (self.root / 'fit.json').read_bytes()
        first = self.state()['history'][0]
        (self.root / 'fit.py').write_text("from pathlib import Path\nPath('fit.json').write_text('{broken')\nraise RuntimeError('failed')\n")
        self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
        state = self.state()
        self.assertEqual(state['history'][0], first)
        self.assertEqual(len(state['history']), 2)
        self.assertFalse(self.flags()['fit'])
        receipt = json.loads((self.root / state['steps']['fit']['receipt']).read_text())['executions'][-1]
        self.assertEqual((self.root / receipt['output']['beforeArtifact']['path']).read_bytes(), old)

    def test_success_requires_observed_finite_valid_output(self):
        for source in ('pass', "from pathlib import Path\nPath('fit.json').write_text('{\"x\":NaN}')",
                       "from pathlib import Path\nPath('fit.json').write_text('{broken')"):
            with self.subTest(source=source):
                (self.root / 'fit.py').write_text(source)
                result = self.command('run', '--step', 'fit', '--force')
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.flags()['fit'])

    def test_each_declared_output_must_be_rewritten(self):
        self.steps[0]['outputs'].append('plot.txt')
        self.write_spec()
        (self.root / 'plot.txt').write_text('stale plot')
        self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
        self.assertFalse(self.flags()['fit'])

    def test_context_or_source_change_during_execution_is_not_reusable(self):
        for mutation in ("Path('data.csv').write_text('x\\n9\\n')",
                         "p=Path('session.json'); s=json.loads(p.read_text()); s['steps'][0]['context']['unit']='g'; p.write_text(json.dumps(s))"):
            with self.subTest(mutation=mutation):
                (self.root / 'fit.py').write_text("import json\nfrom pathlib import Path\nPath('fit.json').write_text('{}')\n" + mutation)
                self.assertNotEqual(self.command('run', '--step', 'fit', '--force').returncode, 0)
                self.assertFalse(self.flags()['fit'])

    def test_rejects_cycles_unknown_dependencies_and_undeclared_output_dependency(self):
        for change in ('cycle', 'unknown', 'undeclared'):
            with self.subTest(change=change):
                original = json.loads(json.dumps(self.steps))
                if change == 'cycle':
                    self.steps[0]['dependsOn'] = ['report']
                elif change == 'unknown':
                    self.steps[0]['dependsOn'] = ['missing']
                else:
                    self.steps[2]['dependsOn'] = []
                self.write_spec()
                self.assertNotEqual(self.command().returncode, 0)
                self.steps = original

    def test_rejects_reserved_aliases_source_overwrite_and_shared_outputs(self):
        for destination in ('data.csv', 'session.json', 'state.json', 'fit.py', '../escape.json',
                            '.analysis-provenance/forged.json', '.analysis-session-receipts/fit.json', 'other.json'):
            with self.subTest(destination=destination):
                self.steps[0]['outputs'] = [destination]
                self.steps[0]['results'] = destination
                self.write_spec()
                self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
                self.assertFalse((self.root / 'state.json').exists())

    def test_rejects_hardlink_alias_to_source(self):
        os.link(self.root / 'data.csv', self.root / 'fit.json')
        self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
        self.assertEqual((self.root / 'data.csv').read_text(), 'x\n1\n2\n')

    def test_post_execution_alias_does_not_overwrite_source_and_is_not_reusable(self):
        original = (self.root / 'data.csv').read_bytes()
        (self.root / 'fit.py').write_text("from pathlib import Path\nPath('fit.json').symlink_to('data.csv')\n")
        self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
        self.assertEqual((self.root / 'data.csv').read_bytes(), original)
        self.assertTrue((self.root / 'state.json').exists())
        self.assertFalse(self.state()['steps']['fit']['reusable'])

    def test_secondary_output_cannot_alias_a_sibling_script(self):
        self.steps[0]['outputs'].append('plot.txt')
        self.write_spec()
        original = (self.root / 'other.py').read_bytes()
        (self.root / 'fit.py').write_text("from pathlib import Path\nPath('fit.json').write_text('{}')\nPath('plot.txt').symlink_to('other.py')\n")
        self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
        self.assertEqual((self.root / 'other.py').read_bytes(), original)
        self.assertFalse(self.state()['steps']['fit']['reusable'])

    def test_reserved_output_cannot_escape_through_an_internal_symlink(self):
        (self.root / 'ordinary').mkdir()
        (self.root / '.analysis-provenance').symlink_to('ordinary', target_is_directory=True)
        self.steps[0]['results'] = '.analysis-provenance/fit.json'
        self.steps[0]['outputs'] = [self.steps[0]['results']]
        self.write_spec()
        self.assertNotEqual(self.command('run', '--step', 'fit').returncode, 0)
        self.assertFalse((self.root / 'state.json').exists())

    def test_malformed_step_state_is_invalid_without_traceback(self):
        self.run_step('fit')
        state = self.state()
        state['steps']['fit']['outputs']['fit.json'] = {'sha256': 'anything'}
        (self.root / 'state.json').write_text(json.dumps(state))
        self.assertEqual(self.status()['state'], 'invalid')
        self.assertFalse(any(self.flags().values()))

    def test_state_modified_during_run_preserves_attempt_in_recovery_file(self):
        self.run_step('fit')
        (self.root / 'fit.py').write_text("from pathlib import Path\nPath('fit.json').write_text('{}')\nPath('state.json').write_text('{broken')\n")
        result = self.command('run', '--step', 'fit')
        self.assertNotEqual(result.returncode, 0)
        summary = json.loads(result.stdout)
        self.assertNotEqual(summary['state'], 'state.json')
        recovered = json.loads((self.root / summary['state']).read_text())
        self.assertEqual(len(recovered['history']), 2)
        self.assertFalse(recovered['steps']['fit']['reusable'])
        self.assertEqual((self.root / 'state.json').read_text(), '{broken')

    def test_versions_participate_in_signature(self):
        self.assertTrue(HELPER.is_file(), 'Continuity helper must exist')
        sys.path.insert(0, str(HELPER.parent))
        self.addCleanup(sys.path.remove, str(HELPER.parent))
        spec = importlib.util.spec_from_file_location('analysis_session_test', HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.object(module.run_analysis, 'versions', return_value={'interpreter': 'python', 'libraries': {'numpy': '1'}}):
            first = module.session_status(self.root, 'session.json', 'state.json')['steps'][0]['signature']
        with patch.object(module.run_analysis, 'versions', return_value={'interpreter': 'python', 'libraries': {'numpy': '2'}}):
            second = module.session_status(self.root, 'session.json', 'state.json')['steps'][0]['signature']
        self.assertNotEqual(first, second)

    @unittest.skipUnless(shutil.which('Rscript'), 'Native R is unavailable')
    def test_native_r_uses_existing_execution_runner(self):
        self.steps[0]['interpreter'] = 'r'
        self.steps[0]['script'] = 'fit.R'
        (self.root / 'fit.R').write_text("cat('{\"value\":3}', file='fit.json')")
        self.write_spec()
        self.run_step('fit')
        self.assertTrue(self.flags()['fit'])

    def test_injected_copy_is_identical(self):
        self.assertTrue(HELPER.is_file(), 'Continuity helper must exist')
        self.assertEqual(HELPER.read_bytes(), COPY.read_bytes())


if __name__ == '__main__':
    unittest.main()
