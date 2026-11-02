import unittest
from prepare import build_requests, prepare, ASSUMPTION, LABEL_ASSUMPTION, RUN, INPUT, SPLIT


class PreparationTests(unittest.TestCase):
    @unittest.skipUnless(INPUT.exists() and SPLIT.exists() and all((RUN / 'upstream' / f).exists() for f in ['TrialGPT.py', 'sigir-retrieved_trials.json', 'corpus.jsonl']), 'Acquired public TrialGPT preparation fixtures are required')
    def test_frozen_scope_and_ablation(self):
        manifest = prepare()
        self.assertEqual((manifest['pairs'], manifest['requests'], manifest['annotations']), (105, 210, 1015))
        original = build_requests('original')
        strict = build_requests('strict')
        for a, b in zip(original, strict):
            self.assertEqual(a['user'], b['user'])
            self.assertIn(ASSUMPTION, a['system'])
            self.assertIn(LABEL_ASSUMPTION, a['system'])
            self.assertNotIn(ASSUMPTION, b['system'])
            self.assertEqual(len(a['expected_indexes']), len(a['criteria']))


if __name__ == '__main__':
    unittest.main()
