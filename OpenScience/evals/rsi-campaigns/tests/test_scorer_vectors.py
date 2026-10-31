"""The lab's scorer vectors (tests/fixtures/scorer-vectors.json) against the Python scorers they were made from.

The JS ports in skill_scorers.mjs are checked against the same file by skillScorers.test.mjs, so a change to score_arb.py, to the
independent BixBench reference or to the file fails here, and a change to a port fails there. No model call, no network."""
import json
import unittest
from pathlib import Path

import scorer_vectors_gen as gen


class ScorerVectors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(gen.FIXTURE.read_text(encoding='utf-8'))
        cls.built = gen.build()

    def test_file_is_what_the_python_scorers_say_today(self):
        # Regenerate with `python3 -I evals/rsi-campaigns/tests/scorer_vectors_gen.py` after an intended change to score_arb.py.
        self.assertEqual(self.fixture, json.loads(json.dumps(self.built, ensure_ascii=False)))

    def test_every_section_has_cases(self):
        for section in ('ratio', 'arbDeep', 'arbWide', 'bixbench'):
            self.assertGreaterEqual(len(self.fixture[section]), 10, section)

    def test_ratio_vectors_cross_the_autojunk_threshold(self):
        lengths = [len(row['b']) for row in self.fixture['ratio']]
        self.assertTrue(any(n < 200 for n in lengths) and any(n >= 200 for n in lengths))

    def test_bixbench_reference_follows_the_official_graders(self):
        gold = {'questions': [gen.q(1, 'str_verifier', '166'), gen.q(2, 'str_verifier', '1.9E-05'), gen.q(3, 'range_verifier', '(1.5,1.54)', [1.5, 1.54]), gen.q(4, 'llm_verifier', 'x')]}
        got = gen.bixbench_reference('Final answers:\n1. 1\n2. 1.9e-05\n3. 1.52 (CI 1.1-2.0)\n4. x', gold)
        # partial match is official (a substring of the ideal is right), an empty cleaned answer is not, llm_verifier is a judge's call
        self.assertEqual(got['verdicts'], ['correct', 'correct', 'correct', 'needs_judge'])
        self.assertEqual(got['deterministic'], [True, True, True, False])
        self.assertEqual(got['score'], 1.0)
        empty = gen.bixbench_reference('Final answers:\n1. ***\n2. n/a', gold)
        self.assertEqual(empty['verdicts'][0], 'incorrect')


if __name__ == '__main__':
    unittest.main()
