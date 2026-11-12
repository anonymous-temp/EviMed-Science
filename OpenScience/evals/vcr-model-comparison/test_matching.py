"""Synthetic counterexamples for score ownership, polarity and missingness."""
import unittest
from matching import gold_label, metric, parse_batch, payload_for, use_flash


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.row = {"annotation_id": 10, "patient_id": "p1", "trial_id": "t1",
                    "trial_title": "A trial", "criterion_type": "exclusion",
                    "criterion_text": "Smoking", "note": "0. No smoking.\n1. Age is 42.",
                    "expert_eligibility": "not excluded", "expert_sentences": "[0]"}
        self.batch = {"id": "batch1", "rows": [self.row]}

    def receipt(self, results):
        import json
        return {"status": 200, "error": None, "body": {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"results": results})}}]}}

    def test_exclusion_is_not_inverted(self):
        self.assertEqual(gold_label(self.row), "not_met")
        self.assertEqual(gold_label({**self.row, "expert_eligibility": "excluded"}), "met")

    def test_invalid_rows_remain_denominator(self):
        self.assertEqual(metric([self.row], {})["accuracy"], 0)
        self.assertEqual(metric([self.row], {})["invalid"], 1)

    def test_unknown_does_not_become_negative(self):
        self.assertEqual(metric([self.row], {10: {"label": "unknown", "sentences": []}})["correct"], 0)

    def test_foreign_and_duplicate_ids_rejected(self):
        for answers in [[{"id": 11, "label": "met", "sentences": [0]}],
                        [{"id": 10, "label": "met", "sentences": [0]}] * 2,
                        [{"id": True, "label": "met", "sentences": [0]}]]:
            result, issues = parse_batch("flash", self.batch, self.receipt(answers))
            self.assertEqual(result, {})
            self.assertTrue(issues)

    def test_fabricated_evidence_rejected(self):
        result, issues = parse_batch("flash", self.batch, self.receipt([{"id": 10, "label": "not_met", "sentences": [99]}]))
        self.assertEqual(result, {})
        self.assertTrue(issues)

    def test_valid_prediction(self):
        result, issues = parse_batch("flash", self.batch, self.receipt([{"id": 10, "label": "not_met", "sentences": [0]}]))
        self.assertFalse(issues)
        self.assertEqual(metric([self.row], result)["accuracy"], 1)

    def test_unknown_can_be_accepted_but_unanchored_definite_cannot(self):
        self.assertFalse(use_flash(self.row, {"label": "unknown", "sentences": [], "confidence": .95}, .8))
        self.assertTrue(use_flash(self.row, {"label": "not_met", "sentences": [], "confidence": .95}, .8))
        self.assertTrue(use_flash({**self.row, "criterion_text": "Age over 18"}, {"label": "met", "sentences": [1], "confidence": .95}, .8))

    def test_payload_does_not_include_answer_fields(self):
        import json
        for arm in ("flash", "jev113", "jev114"):
            body = json.dumps(payload_for(arm, self.batch))
            self.assertNotIn("expert_eligibility", body)
            self.assertNotIn("expert_sentences", body)
            self.assertNotIn("gpt4_", body)

    def test_missing_criterion_is_not_a_language_candidate(self):
        self.assertTrue(use_flash({**self.row, "criterion_text": None}, {"label": "unknown", "sentences": [], "confidence": 1}, .8))

    def test_malformed_jev_remains_a_failure(self):
        for answers in ([], {"c10": []}, {"c10": {"choice": "met", "confidence": 1, "probabilities": []}}):
            result, issues = parse_batch("jev113", self.batch, {"status": 200, "body": {"answers": answers}})
            self.assertFalse(result)
            self.assertTrue(issues)

    def test_malformed_flash_remains_a_failure(self):
        for body in ({"choices": [[]]}, {"choices": [{"message": []}]}, {"choices": [None]}):
            result, issues = parse_batch("flash", self.batch, {"status": 200, "body": body})
            self.assertFalse(result)
            self.assertTrue(issues)


if __name__ == "__main__":
    unittest.main()
