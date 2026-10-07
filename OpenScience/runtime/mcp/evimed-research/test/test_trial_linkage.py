import unittest
import trial_linkage


class TrialLinkageTest(unittest.TestCase):
    def test_same_trial_annotation_retains_all_records(self):
        rows = [{"id": "a", "title": "Emicizumab HAVEN long term efficacy", "doi": "10.a"},
                {"id": "b", "title": "Emicizumab HAVEN patient quality outcomes", "doi": "10.b"}]
        before = [dict(row) for row in rows]
        result = trial_linkage.annotate(rows, ask=lambda *args, **kwargs: {"relation": "same_trial"})
        self.assertEqual(rows, before)
        self.assertEqual(result["suspectedSameTrial"][0]["merged"], False)
        self.assertEqual(result["trialLinkageReview"]["candidatePairsReviewed"], 1)

    def test_failure_and_limit_preserve_rows_as_unknown(self):
        rows = [{"id": str(n), "title": "Emicizumab HAVEN outcomes %d" % n} for n in range(12)]
        result = trial_linkage.annotate(rows, ask=lambda *args, **kwargs: None)
        self.assertEqual(len(rows), 12)
        self.assertEqual(result["suspectedSameTrial"], [])
        self.assertEqual(result["trialLinkageReview"]["unresolvedPairs"], 40)
        self.assertTrue(result["trialLinkageReview"]["candidateLimitReached"])
