import hashlib
import json
import pathlib
import tempfile
import time
import unittest
from unittest.mock import patch
import prepare
import run
from gateway import cost, request_context


class RunnerTests(unittest.TestCase):
    def test_ml_verifier_is_not_started_without_its_declared_storage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'tests').mkdir()
            (root / 'tests/test.sh').write_text('uvx --with torch==2.1.2 pytest')
            (root / 'task.toml').write_text('[environment]\nstorage_mb=10240\n')
            task = {'bench': 'slb', 'path': tmp}
            with patch('run.shutil.disk_usage') as disk, patch('run.ROOT', root):
                disk.return_value.free = 4 * 1024**3
                self.assertIn('unchanged and unrun', run.resource_admission_issue(task))
                disk.return_value.free = 12 * 1024**3
                self.assertIsNone(run.resource_admission_issue(task))

    def test_logging_fix_still_redacts_credentials(self):
        import redaction_compat
        from benchflow.trajectories.types import redact_trajectory_text
        receipt = redaction_compat.apply()
        self.assertEqual(len(receipt['patterns']), 1)
        for carrier in ['GITHUB_TOKEN=', 'SLACK_SECRET:', '"custom_TOKEN": "']:
            output = redact_trajectory_text(carrier + 'example-value')
            self.assertNotIn('example-value', output)
            self.assertIn('REDACTED', output)

    def test_logging_fix_handles_long_noncredential_identifiers(self):
        import redaction_compat
        from benchflow.trajectories.types import redact_trajectory_text
        redaction_compat.apply()
        text = 'A' * 100_000
        started = time.perf_counter()
        self.assertEqual(redact_trajectory_text(text), text)
        self.assertLess(time.perf_counter() - started, 3)

    def test_outer_watchdog_outlives_the_native_agent_and_verifier(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'task.md').write_text('---\nagent:\n  timeout_sec: 3600\nverifier:\n  timeout_sec: 240\n---\nTask')
            self.assertEqual(run.sb_watchdog({'path': tmp}), 5040)

    def test_parallel_requests_keep_their_own_trial_attribution(self):
        a = {'bench': 'sb', 'id': 'task-a'}
        b = {'bench': 'slb', 'id': 'task-b'}
        for task, arm in [(a, 'none'), (b, 'learned')]:
            self.assertEqual(request_context(run.trial_gateway(task, arm) + '/chat/completions', None),
                             {'runId': f'{task["bench"]}-{arm}-1', 'task': task['id'], 'arm': arm})

    def test_legacy_single_slot_and_judge_attribution_remains_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = pathlib.Path(tmp) / 'current.json'
            current.write_text(json.dumps({'purpose': 'judge', 'task': 'a'}))
            self.assertEqual(request_context('/v1/responses', current), {'purpose': 'judge', 'task': 'a'})

    def test_retry_never_repeats_a_valid_failed_answer_or_timeout(self):
        self.assertFalse(run.infrastructure_record({'official': {'error': 'timeout', 'rewards': {'reward': 0}}}))
        self.assertFalse(run.infrastructure_record({'official': {'passed': False, 'reward': 0, 'verifier_exit': 0}}))
        self.assertTrue(run.infrastructure_record({'official': {'error': 'docker_build_failed', 'passed': False, 'verifier_exit': None}}))
        self.assertTrue(run.infrastructure_record({'official': {'verifier_error': 'container unavailable'}}))

    def test_pin_verification_rejects_wrong_revision_or_an_empty_pin(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            task_path = root / 'skillsbench/tasks/one'
            task_path.mkdir(parents=True)
            manifest = {'pins': prepare.PINS, 'tasks': [{'bench': 'sb', 'id': 'one', 'path': str(task_path)}], 'practice': []}
            source = root / 'sources.json'
            for revision in ['wrong', prepare.PINS['sb']]:
                source.write_text(json.dumps({'learning': {'skillsbench': {'revision': revision, 'files': []}}}))
                with self.assertRaises(ValueError):
                    prepare.verify(manifest, source)

    def test_capacity_subset_is_identical_across_arms_and_excludes_practice(self):
        manifest = {'tasks': [{'bench': 'slb', 'family': family, 'id': family + variant}
                              for family in ['a', 'b'] for variant in ['-3', '-2']],
                    'practice': [{'bench': 'slb', 'family': 'a', 'id': 'a-1'}]}
        self.assertEqual([t['id'] for t in run.active_tasks(manifest, 'slb', 1)], ['a-3', 'b-3'])
        self.assertEqual(len(run.active_tasks(manifest, 'slb', 0)), 4)

    def test_seed_order_is_stable(self):
        self.assertEqual(prepare.order('task', '20261111'), hashlib.sha256(b'20261111:task').hexdigest())
        self.assertNotEqual(prepare.order('task', 'different'), prepare.order('task', '20261111'))

    def test_feasibility_is_independent_of_skill_and_verifier_answers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'environment').mkdir()
            (root / 'environment/Dockerfile').write_text('FROM python:3.12-slim\nRUN pip install pandas==2.2.3\n')
            self.assertEqual(prepare.feasibility(root), [])
            (root / 'environment/Dockerfile').write_text('FROM python:3.12-slim\nRUN pip install torch\n')
            self.assertTrue(prepare.feasibility(root))

    def test_required_credentials_are_screened_before_sampling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'environment').mkdir()
            (root / 'environment/Dockerfile').write_text('FROM ubuntu:24.04\n')
            (root / 'task.toml').write_text('[environment]\nrequired_env=["GH_TOKEN"]\n')
            self.assertIn('external credentials required', prepare.feasibility(root))

    def test_verifier_changes_are_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'tests').mkdir()
            script = root / 'tests/test.sh'
            script.write_text('exit 0\n')
            task = {'path': str(root), 'bench': 'slb', 'id': 'one',
                    'verifierSha256': {'test.sh': hashlib.sha256(script.read_bytes()).hexdigest()}}
            run.check_verifier(task)
            script.write_text('exit 1\n')
            with self.assertRaises(ValueError):
                run.check_verifier(task)

    def test_learned_never_falls_back_to_human_skills(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(run, 'ROOT', pathlib.Path(tmp)):
            task = {'bench': 'slb', 'path': '/unused', 'family': 'one'}
            with self.assertRaises(RuntimeError):
                run.skills_for(task, 'learned')
            (pathlib.Path(tmp) / 'practice').mkdir()
            (pathlib.Path(tmp) / 'practice/complete.json').write_text('{"approved":0}')
            self.assertEqual(run.skills_for(task, 'learned'), pathlib.Path(tmp) / 'learned')
            self.assertIsNone(run.skills_for(task, 'none'))

    def test_usage_attribution_does_not_mix_tasks_or_arms(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(run, 'ROOT', pathlib.Path(tmp)):
            rows = [{'runId': 'sb-none-1', 'task': 'one'}, {'runId': 'sb-flat-1', 'task': 'one'},
                    {'runId': 'sb-none-1', 'task': 'two'}]
            (pathlib.Path(tmp) / 'usage.jsonl').write_text('\n'.join(map(json.dumps, rows)))
            self.assertEqual(run.usage('sb-none-1', 'one'), [rows[0]])

    def test_cached_tokens_are_inside_prompt_total(self):
        self.assertAlmostEqual(cost({'prompt_tokens': 100, 'prompt_cache_hit_tokens': 90, 'completion_tokens': 5}), .0000636)
        self.assertEqual(cost({'prompt_tokens': 100, 'prompt_cache_hit_tokens': 1000}), .000004)


if __name__ == '__main__':
    unittest.main()
