import json
import unittest

import grade_results


class NumericNormalizationTests(unittest.TestCase):
    def test_cross_language_count_units_are_equivalent(self):
        source = "There were 53·2 million additional cases and 7.62 billion observations."
        generated = "额外增加 5320 万例，共 76.2 亿次观察。"
        self.assertTrue(grade_results.numbers(generated) <= grade_results.numbers(source))

    def test_percentages_remain_distinct_from_absolute_counts(self):
        self.assertEqual(grade_results.normalize_number("27.6%"), "27.6%")
        self.assertEqual(grade_results.normalize_number("27.6 million"), "27600000")

    def test_grouped_thousands_stay_one_number(self):
        # A narrow no-break space is what the writer emits between groups.
        self.assertEqual(grade_results.numbers("6\u202f609 adults"), {"6609"})
        self.assertEqual(grade_results.numbers("8,544 screened"), {"8544"})

    def test_heading_ordinals_are_not_evidence(self):
        self.assertEqual(grade_results.numbers("### 2.1 Trial Design"), set())
        self.assertEqual(grade_results.numbers("## 3 Results"), set())

    def test_ranges_and_dates_do_not_become_negative_values(self):
        self.assertEqual(grade_results.numbers("4-6 weeks"), {"4", "6"})
        self.assertEqual(grade_results.numbers("a change of -2.4 points"), {"-2.4"})

    def test_model_payload_includes_nonstandard_full_text_sections(self):
        full_text = "Case presentation: baseline HAMD was 21 and improved to 9."
        payload = grade_results.model_payload(
            {"title": "Example", "results": ""},
            "The baseline HAMD was 21.",
            full_text,
        )
        reference = json.loads(payload["reference"])
        self.assertIn("baseline HAMD was 21", reference["fullTextEvidence"])
        self.assertTrue(reference["fullTextEvidenceComplete"])

    def test_delivery_gate_rejects_aborted_or_incomplete_outputs(self):
        complete = {
            "terminalSuccess": True,
            "generatedCharacters": 8_000,
            "sourceIdentifierResolved": True,
            "sectionCoverageRate": 1.0,
        }
        self.assertTrue(grade_results.delivery_gate(complete)["passed"])
        incomplete = {**complete, "generatedCharacters": 116, "sectionCoverageRate": 0.0}
        gate = grade_results.delivery_gate(incomplete)
        self.assertFalse(gate["passed"])
        self.assertEqual(gate["failures"], ["output_too_short", "required_sections_missing"])

    def test_chinese_combined_headings_count_as_required_sections(self):
        self.assertTrue(grade_results.SECTION_PATTERNS["results"].search("## 主要发现（方法学综述）"))
        self.assertTrue(grade_results.SECTION_PATTERNS["discussion"].search("### 讨论与局限性"))


if __name__ == "__main__":
    unittest.main()
