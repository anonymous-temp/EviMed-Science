"""Tests of tools/judge_packets.py: delivery (complete / at-cap / none), repeats and their isolation, question filters.

Run: python3 -I -m unittest discover -s tools/test -p 'test_judge_packets.py'   (from evals/public-benchmarks)
"""
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import judge_packets as jp  # noqa: E402
import judging_fixture as fx  # noqa: E402


def meta(d):
    return json.loads((d / 'meta.json').read_text())


class Packets(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='judge-packets-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = fx.make_root(self.tmp.name)
        self.out = self.root / 'packets'

    def test_root_comes_from_the_environment_not_a_constant(self):
        import os
        self.assertEqual(jp.ROOT, pathlib.Path(os.environ.get('BENCH_ROOT', '.')).resolve())
        self.assertNotIn('/home/coder', pathlib.Path(jp.__file__).read_text())

    def test_drb_delivery_complete_at_cap_none(self):
        jp.write_packets('drb', self.out, root=self.root)
        done, capped, none = (self.out / 'drb' / i for i in ('59', '27', '3'))
        self.assertEqual((meta(done)['delivery'], (done / 'target.md').read_text()), ('complete', '# complete report'))
        self.assertEqual((meta(capped)['delivery'], (capped / 'target.md').read_text()), ('at-cap', '# half a report'))
        self.assertIn('at-cap:draft.md', meta(capped)['target_source'])
        self.assertEqual((meta(none)['delivery'], (none / 'target.md').read_text()), ('none', ''))
        self.assertEqual((capped / 'reference.md').read_text(), 'reference 27')

    def test_a_packet_holds_the_task_and_nothing_of_a_verdict(self):
        jp.write_packets('drb', self.out, root=self.root)
        names = sorted(p.name for p in (self.out / 'drb' / '59').iterdir())
        self.assertEqual(names, ['criteria.json', 'meta.json', 'reference.md', 'target.md', 'task.txt'])

    def test_rcb_at_cap_report_and_figures(self):
        jp.write_packets('rcb', self.out, root=self.root)
        done, capped = self.out / 'rcb' / 'Life_001', self.out / 'rcb' / 'Life_000'
        self.assertEqual(meta(done)['delivery'], 'complete')
        self.assertEqual((capped / 'report.md').read_text(), '# rcb draft')
        self.assertEqual(meta(capped)['delivery'], 'at-cap')
        self.assertTrue((done / 'run_files' / 'report' / 'images' / 'f.png').exists())
        self.assertTrue((done / 'target_study' / 'rubric.json').exists())

    def test_repeats_are_independent_packets_with_large_trees_linked(self):
        jp.write_packets('rcb', self.out, repeats=3, root=self.root)
        for k in (1, 2, 3):
            d = self.out / 'rcb' / f'p{k}' / 'Life_001'
            self.assertEqual(meta(d)['pass'], k)
            self.assertEqual((d / 'report.md').read_text(), '# rcb report')
            self.assertTrue((d / 'target_study' / 'rubric.json').exists())
            self.assertEqual(sorted(p.name for p in d.iterdir()), ['meta.json', 'report.md', 'run_files', 'target_study', 'task.txt'])
        self.assertFalse((self.out / 'rcb' / 'p1' / 'Life_001' / 'run_files').is_symlink())
        self.assertTrue((self.out / 'rcb' / 'p3' / 'Life_001' / 'run_files').is_symlink())
        # nothing outside the packet directories: no verdict, no list of passes
        self.assertEqual(sorted(p.name for p in (self.out / 'rcb').iterdir()), ['p1', 'p2', 'p3'])

    def test_a_single_pass_keeps_the_flat_layout(self):
        jp.write_packets('drb', self.out, root=self.root)
        self.assertTrue((self.out / 'drb' / '59' / 'target.md').exists())
        self.assertNotIn('pass', meta(self.out / 'drb' / '59'))

    def test_only_selects_items(self):
        written = jp.write_packets('drb', self.out, only={'59', '3'}, root=self.root)
        self.assertEqual(sorted(p.name for p in written), ['3', '59'])

    def test_bixbench_llm_questions_only_and_capsules_without_any_are_skipped(self):
        jp.write_packets('bixbench', self.out, modes={'llm_verifier'}, root=self.root)
        d = self.out / 'bixbench' / 'bix-1'
        self.assertEqual([q['qid'] for q in json.loads((d / 'questions.json').read_text())['questions']], ['bix-1-q2'])
        self.assertEqual(meta(d)['questions'], ['bix-1-q2'])
        self.assertTrue((self.out / 'bixbench' / 'bix-2').exists())  # an llm question, though the run timed out: empty answer.md
        self.assertEqual((self.out / 'bixbench' / 'bix-2' / 'answer.md').read_text(), '')
        jp.write_packets('bixbench', self.root / 'p2', modes={'str_verifier'}, root=self.root)
        self.assertFalse((self.root / 'p2' / 'bixbench' / 'bix-2').exists())

    def test_bixbench_unsettled_are_the_questions_code_leaves_to_a_judge(self):
        jp.write_packets('bixbench', self.out, unsettled=True, root=self.root)
        qs = [q['qid'] for q in json.loads((self.out / 'bixbench' / 'bix-1' / 'questions.json').read_text())['questions']]
        # q1 (1.5 in (1,2)) and q3 (166 genes vs 166: not exact, not a substring of the target) -> q3 and the llm q2 are for the judge
        self.assertEqual(qs, ['bix-1-q2', 'bix-1-q3'])


if __name__ == '__main__':
    unittest.main()
