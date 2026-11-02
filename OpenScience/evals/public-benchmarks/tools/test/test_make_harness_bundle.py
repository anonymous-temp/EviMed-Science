"""Tests of make_harness_bundle.py over a throwaway git repository (never the real branches).

Run: python3 -I -m unittest discover -s tools/test -p 'test_make_harness_bundle.py'   (from evals/public-benchmarks)
"""
import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import export_harness_arms as eha  # noqa: E402
import make_harness_bundle as mhb  # noqa: E402

PATH = 'OpenScience/packages/socket/src/guidanceText.mjs'
BASE = "export const lines = [\n    '1. first',\n    '2. second',\n    `3. third ${x}`,\n]\n"


def run(*argv, cwd):
    subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True,
                   env={'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t', 'PATH': '/usr/bin:/bin', 'HOME': str(cwd)})


class Bundle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='harness-bundle-test-')
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / 'repo'
        (self.repo / PATH).parent.mkdir(parents=True)
        (self.repo / PATH).write_text(BASE)
        run('git', 'init', '-q', '-b', 'main', cwd=self.repo)
        run('git', 'add', '-A', cwd=self.repo)
        run('git', 'commit', '-q', '-m', 'base', cwd=self.repo)
        self.out = Path(self.tmp.name) / 'out' / 'bundles.json'

    def branch(self, name, text):
        run('git', 'checkout', '-q', '-b', name, 'main', cwd=self.repo)
        (self.repo / PATH).write_text(text)
        run('git', 'commit', '-q', '-am', name, cwd=self.repo)
        run('git', 'checkout', '-q', 'main', cwd=self.repo)

    def tool(self, patch, *extra):
        argv = ['--repo', str(self.repo), '--base', 'main', '--patch', patch, '--title', 't', '--image-id', 'img-1', '--image-artifact', 'artifact-1', '--out', str(self.out), *extra]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mhb.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_the_added_lines_in_file_order_then_the_note_and_the_identity_of_the_arm(self):
        self.branch('p1', BASE.replace("    '2. second',\n", "    '2. second',\n    '   **new rule**: do it',\n").replace('`3. third ${x}`,\n', "`3. third ${x}`,\n    '7. last rule',\n"))
        code, out, err = self.tool('p1', '--note', 'The clock changed.')
        self.assertEqual((code, err), (0, ''))
        document = json.loads(self.out.read_text())
        bundle = document['candidates'][0]['bundle']
        self.assertEqual(bundle, {'guidanceSupplement': '**new rule**: do it\n7. last rule\nThe clock changed.', 'skills': []})
        identity = json.loads((self.out.parent / 'bundles.identity.json').read_text())
        commit = subprocess.run(['git', '-C', str(self.repo), 'rev-parse', 'p1'], capture_output=True, text=True).stdout.strip()
        digest = hashlib.sha256(f'artifact-1|{commit}'.encode()).hexdigest()
        self.assertEqual(identity['image'], {'id': 'img-1', 'digest': digest, 'digestSource': identity['image']['digestSource']})
        self.assertIn('lane.json carries the image key only', identity['image']['digestSource'])
        arm = next(iter(eha.candidate_arms(str(self.out), {'id': 'img-1', 'digest': digest})))
        self.assertEqual(identity['arm'], arm)
        self.assertEqual((identity['patch']['commit'], identity['patch']['addedLines'], identity['patch']['removedLines']), (commit, 2, 0))

    def test_another_commit_is_another_image_identity_and_another_arm(self):
        self.branch('p1', BASE.replace("    '2. second',\n", "    '2. second',\n    '8. rule',\n"))
        self.branch('p2', BASE.replace("    '2. second',\n", "    '2. second',\n    '8. rule',\n").replace('1. first', '1. first!'))
        self.assertEqual(self.tool('p1', '--note', 'n')[0], 0)
        first = json.loads((self.out.parent / 'bundles.identity.json').read_text())
        self.assertEqual(self.tool('p2', '--note', 'n', '--allow-removals')[0], 0)
        second = json.loads((self.out.parent / 'bundles.identity.json').read_text())
        self.assertNotEqual(first['arm'], second['arm'])
        self.assertNotEqual(first['image']['digest'], second['image']['digest'])
        self.assertEqual(self.tool('p1', '--note', 'n', '--image-digest', 'a' * 64)[0], 0)
        given = json.loads((self.out.parent / 'bundles.identity.json').read_text())
        self.assertEqual((given['image']['digest'], given['image']['digestSource']), ('a' * 64, 'given'))

    def test_a_removed_line_an_interpolated_line_or_nothing_added_is_refused_and_nothing_is_written(self):
        self.branch('removes', BASE.replace("    '1. first',\n", "    '1. first',\n    '9. extra',\n").replace("    '2. second',\n", ''))
        code, _, err = self.tool('removes')
        self.assertEqual(code, 2)
        self.assertIn('removes 1 line', err)
        self.branch('interpolates', BASE.replace('`3. third ${x}`,\n', '`3. third ${x}`,\n    `4. ${y}`,\n'))
        code, _, err = self.tool('interpolates')
        self.assertEqual(code, 2)
        self.assertIn('not a plain string literal', err)
        self.branch('nothing', BASE + '// a comment is not a guidance line\n')
        code, _, err = self.tool('nothing')
        self.assertEqual(code, 2)
        self.assertFalse(self.out.exists())


if __name__ == '__main__':
    unittest.main()
