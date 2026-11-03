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


class ToolPatch(Bundle):
    """A branch that holds code beside (or without) guidance text."""

    CODE = 'OpenScience/runtime/mcp/evimed-research/tool.py'

    def code_branch(self, name, text='def tool():\n    return 1\n', guidance=None):
        run('git', 'checkout', '-q', '-b', name, 'main', cwd=self.repo)
        (self.repo / self.CODE).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / self.CODE).write_text(text)
        if guidance is not None:
            (self.repo / PATH).write_text(guidance)
        run('git', 'add', '-A', cwd=self.repo)
        run('git', 'commit', '-q', '-m', name, cwd=self.repo)
        run('git', 'checkout', '-q', 'main', cwd=self.repo)

    def test_a_tool_patch_records_its_code_and_binds_it_into_the_digest(self):
        self.code_branch('t1')
        code, out, err = self.tool('t1', '--tool-patch', '--code-path', 'OpenScience/runtime/mcp/evimed-research', '--tool-catalogue-chars', '640', '--note', 'Use the tool for scales.')
        self.assertEqual((code, err), (0, ''), err)
        document = json.loads(self.out.read_text())
        entry = document['candidates'][0]
        self.assertEqual(entry['bundle'], {'guidanceSupplement': 'Use the tool for scales.', 'skills': []})
        commit = subprocess.run(['git', '-C', str(self.repo), 'rev-parse', 't1'], capture_output=True, text=True).stdout.strip()
        base_image = {'id': 'img-1', 'digest': hashlib.sha256(f'artifact-1|{commit}'.encode()).hexdigest()}
        code_entry = entry['code']
        self.assertEqual(code_entry['image'], {'id': f'img-1-{commit[:8]}', 'digest': hashlib.sha256(f'artifact-1|{commit}|delta'.encode()).hexdigest()})
        self.assertEqual(code_entry['files'], [{'path': self.CODE, 'sha256': hashlib.sha256(b'def tool():\n    return 1\n').hexdigest()}])
        self.assertEqual(code_entry['toolCatalogueChars'], 640)
        diff = subprocess.run(['git', '-C', str(self.repo), 'diff', '--binary', 'main...t1', '--', 'OpenScience/runtime/mcp/evimed-research'], capture_output=True, text=True).stdout
        self.assertEqual(code_entry['patchSha256'], hashlib.sha256(diff.encode()).hexdigest())
        identity = json.loads((self.out.parent / 'bundles.identity.json').read_text())
        self.assertEqual(identity['surface'], 'tool-patch')
        self.assertEqual(identity['alwaysOnChars'], len('Use the tool for scales.') + 640, 'the tool catalogue counts as always-on growth')
        arms = eha.candidate_arms(str(self.out), base_image, 'tool-patch')
        self.assertEqual(list(arms), [identity['arm']])
        # the same candidate as a harness patch is another thing: refused, not silently digested without its code
        with self.assertRaises(eha.ExportError):
            eha.candidate_arms(str(self.out), base_image, 'harness-patch')
        # code changes the digest: the same text without it is another candidate
        text_only = eha.harness_patch_digest(entry['bundle'], base_image)
        self.assertNotEqual(text_only, arms[identity['arm']]['digest'])

    def test_a_tool_patch_may_change_no_guidance_but_must_change_code(self):
        self.code_branch('t2')
        self.assertEqual(self.tool('t2', '--tool-patch', '--code-path', 'OpenScience/runtime/mcp/evimed-research')[0], 0, 'no guidance line, no note: the code is the patch')
        self.assertEqual(json.loads(self.out.read_text())['candidates'][0]['bundle'], {'guidanceSupplement': '', 'skills': []})
        self.out.unlink()
        self.code_branch('t3', guidance=BASE.replace("    '2. second',\n", "    '2. second',\n    '8. use it',\n"))
        self.assertEqual(self.tool('t3', '--tool-patch', '--code-path', 'OpenScience/runtime/mcp/evimed-research')[0], 0)
        self.assertEqual(json.loads(self.out.read_text())['candidates'][0]['bundle']['guidanceSupplement'], '8. use it')
        self.out.unlink()
        self.branch('only-text', BASE.replace("    '2. second',\n", "    '2. second',\n    '8. use it',\n"))
        code, _, err = self.tool('only-text', '--tool-patch', '--code-path', 'OpenScience/runtime/mcp/evimed-research')
        self.assertEqual(code, 2)
        self.assertIn('changes nothing under the --code-path', err)
        self.assertFalse(self.out.exists())
        code, _, err = self.tool('t2', '--tool-patch')
        self.assertEqual(code, 2)
        self.assertIn('--code-path', err)
        code, _, err = self.tool('t2', '--code-path', 'x')
        self.assertEqual(code, 2)
        self.assertIn('belong to --tool-patch', err)


if __name__ == '__main__':
    unittest.main()
