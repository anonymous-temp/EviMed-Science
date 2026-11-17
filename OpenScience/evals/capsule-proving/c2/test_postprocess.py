"""Recorded DA-Code post-process failures, reproduced with a fake official adapter and no subprocess."""
import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import score_dacode as score

class Tests(unittest.TestCase):
    def test_normalizes_vendor_shell_typo_and_records_original_command(self):
        container = score.SandboxContainer('/work/space', '/fake/sandbox', '/fake/python', 1)
        run = type('Run', (), {'returncode': 0, 'stdout': '', 'stderr': ''})()
        with patch.object(score.subprocess, 'run', return_value=run) as execute:
            container.exec_run(['basch', '-c', 'cd /workspace && python draw.py'])
        script = execute.call_args.args[0][-1]
        self.assertNotIn('basch', script)
        self.assertIn('draw.py', script)
        self.assertNotIn('cd /workspace', script)
        self.assertEqual(container.log[0]['originalCmd'][0], 'basch')
        self.assertTrue(container.log[0]['normalizations'])
    def run_fixture(self, exit_code):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parents[4] / '.lane/tmp') as temp:
            root = Path(temp)
            (root / 'workspace').mkdir()
            (root / 'workspace/result.png').write_bytes(b'PNG already produced by the agent')
            (root / 'task.json').write_text(json.dumps({'id': 'plot', 'sourceDir': str(root / 'source'), 'postProcess': ['plot_process'], 'eval': {'id': 'plot'}}))
            (root / 'meta.json').write_text(json.dumps({'finished': True, 'trajectory': []}))
            (root / 'reply.txt').write_text('Saved result.png')
            class Terminate:
                @staticmethod
                def parse_action_from_text(text): return None
            class Evaluator:
                def __init__(self, **kwargs): pass
                def evaluate(self, file): return [{'total_score': 0, 'info': 'Incorrect plotted values'}]
            def post(workspace, controller):
                controller.container.exec_run('basch -c "cd /workspace && python draw.py"')
                return [], None
            args = argparse.Namespace(repo='fake', task_file=str(root / 'task.json'), workspace=str(root / 'workspace'), reply_file=str(root / 'reply.txt'),
                meta_file=str(root / 'meta.json'), runner='fake', python_bin='fake', post_timeout=1, out_root=str(root / 'output'), gold_dir='fake', timeout_seconds=1, verdict_out=str(root / 'verdict.json'))
            run = type('Run', (), {'returncode': exit_code, 'stdout': '', 'stderr': 'basch: command not found' if exit_code else ''})()
            with patch.object(score, 'official', return_value=(Terminate, post, Evaluator)), patch.object(score.subprocess, 'run', return_value=run):
                score.one(args)
            return json.loads((root / 'verdict.json').read_text())
    def test_postprocess_exit_is_not_an_analysis_zero_but_a_real_bad_plot_still_fails(self):
        failed = self.run_fixture(127)
        self.assertIsNone(failed['score'])
        self.assertEqual(failed['outcome'], 'post-process-failed')
        self.assertIn('post-process failed:', failed['error'])
        self.assertIn('result.png', failed['added'])
        wrong = self.run_fixture(0)
        self.assertEqual(wrong['score'], 0)
        self.assertFalse(wrong['pass'])
        self.assertEqual(wrong['outcome'], 'task-failed')
if __name__ == '__main__': unittest.main()
