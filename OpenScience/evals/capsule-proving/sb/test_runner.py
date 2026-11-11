import hashlib
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import prepare
import run
from gateway import cost


class RunnerTests(unittest.TestCase):
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
