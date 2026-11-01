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


    def test_round_one_sections_have_cases(self):
        # `mbc` (score_shortanswer.py) and `harnessDigest` (export_harness_arms.py) belong to the harness-patch campaigns.
        self.assertGreaterEqual(len(self.fixture['mbc']), 45)
        self.assertGreaterEqual(len(self.fixture['harnessDigest']), 8)

    def test_mbc_vectors_cover_every_task_and_verdict_and_floor_needs_judge(self):
        cases = self.fixture['mbc']
        self.assertEqual({c['gold']['task_name'] for c in cases},
                         {'Ingredient', 'Applicant_Full_Name', 'Patent_Expire_Date_Text', 'Exclusivity_Date', 'Open_on_Approval'})
        self.assertEqual({c['verdict'] for c in cases}, {'correct', 'incorrect', 'needs_judge'})
        self.assertEqual({c['extraction'] for c in cases}, {'label', 'fallback'})
        for case in cases:
            # a case that needs a judge counts as not correct, the deterministic consumer's floor
            self.assertEqual(case['score'], 1 if case['verdict'] == 'correct' else 0, case['name'])

    def test_harness_digest_vectors_follow_the_stated_recipe(self):
        import hashlib
        for case in self.fixture['harnessDigest']:
            skills = sorted(case['bundle']['skills'], key=lambda s: s['name'])
            body = {'guidanceSupplement': case['bundle']['guidanceSupplement'], 'image': case['image'], 'skills': skills}
            text = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
            self.assertEqual(case['digest'], hashlib.sha256(text.encode('utf-8')).hexdigest(), case['name'])
            utf16 = lambda value: len(value.encode('utf-16-le')) // 2
            always = utf16(case['bundle']['guidanceSupplement']) + sum(utf16(s['name']) + utf16(s['description']) for s in skills)
            self.assertEqual(case['alwaysOnChars'], always, case['name'])
            self.assertEqual(case['chars'], always + sum(utf16(s['body']) for s in skills), case['name'])
        digests = [c['digest'] for c in self.fixture['harnessDigest']]
        self.assertEqual(len(set(digests)), len(digests))
        names = {c['name']: c for c in self.fixture['harnessDigest']}
        # the image is part of the digest: the same patch on another image is another candidate
        self.assertNotEqual(names['ascii']['digest'], names['same-patch-other-image']['digest'])
        self.assertEqual(names['ascii']['bundle'], names['same-patch-other-image']['bundle'])
        # astral characters count as two UTF-16 code units, as JavaScript counts them
        self.assertGreater(names['emoji-astral']['chars'], len(names['emoji-astral']['bundle']['guidanceSupplement']))


if __name__ == '__main__':
    unittest.main()
