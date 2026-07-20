import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import grade_detailed_fidelity as detailed


class DetailedFidelityTests(unittest.TestCase):
    def test_selects_targeted_rerun_before_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / "baseline"
            rerun = root / "rerun"
            baseline.mkdir()
            rerun.mkdir()
            (baseline / "paper-001.json").write_text(
                json.dumps({"assistantText": "baseline"}), encoding="utf-8"
            )
            (rerun / "paper-001.json").write_text(
                json.dumps({"assistantText": "rerun"}), encoding="utf-8"
            )

            label, run = detailed.select_run("paper-001", baseline, rerun)

            self.assertEqual(label, "rerun")
            self.assertEqual(run["assistantText"], "rerun")

    def test_evidence_locators_resolve_to_exact_supplied_text(self):
        item = {
            "id": "sample_size",
            "importance": "critical",
            "status": "exact",
            "issueKinds": [],
            "referenceFact": "6609 participants",
            "generatedFact": "6609 participants",
            "sourceEvidence": {"locator": "R0001"},
            "generatedEvidence": {"locator": "G0001"},
            "explanation": "Exact match.",
        }
        checked = detailed.validate_item_evidence(
            item,
            reference_units={"R0001": "We randomly assigned 6609 participants."},
            generated_units={"G0001": "The trial included 6609 participants."},
        )
        self.assertTrue(checked["sourceEvidenceValid"])
        self.assertTrue(checked["generatedEvidenceValid"])
        self.assertEqual(
            checked["sourceEvidence"]["quote"], "We randomly assigned 6609 participants."
        )

        item["sourceEvidence"]["locator"] = "R9999"
        checked = detailed.validate_item_evidence(
            item,
            reference_units={"R0001": "We randomly assigned 6609 participants."},
            generated_units={"G0001": "The trial included 6609 participants."},
        )
        self.assertFalse(checked["sourceEvidenceValid"])

    def test_multiple_returned_locators_are_all_resolved_and_preserved(self):
        item = self._item("sample_size", "critical", "exact")
        item["sourceEvidence"] = {"locator": "R0001,R0002"}
        item["generatedEvidence"] = {"locator": "G0001, G0002"}
        checked = detailed.validate_item_evidence(
            item,
            {"R0001": "source one", "R0002": "source two"},
            {"G0001": "generated one", "G0002": "generated two"},
        )
        self.assertTrue(checked["sourceEvidenceValid"])
        self.assertEqual(checked["sourceEvidence"]["locators"], ["R0001", "R0002"])
        self.assertEqual(checked["sourceEvidence"]["quotes"], ["source one", "source two"])

    def test_partial_missing_fact_only_requires_source_evidence(self):
        item = self._item("limitations", "major", "partial", ["missing"])
        item["sourceEvidenceValid"] = True
        item["generatedEvidenceValid"] = False
        item["generatedEvidence"] = {"locator": "", "quote": ""}
        self.assertTrue(detailed.evidence_requirement_met(item))

    def test_adversarial_unsupported_issue_overrides_primary_pass(self):
        metrics = detailed.derive_metrics_and_verdict(
            [self._item("study_design", "critical", "exact")]
        )
        issue = {
            "criterionId": "limitations_and_bias",
            "kind": "unsupported",
            "severity": "major",
            "claim": "invented limitation",
            "sourceEvidence": {"locator": "", "quote": ""},
            "generatedEvidence": {"locator": "G0001", "quote": "claim"},
            "sourceEvidenceValid": False,
            "generatedEvidenceValid": True,
            "explanation": "not in source",
        }
        combined = detailed.apply_adversarial_audit(metrics, [issue])
        self.assertEqual(combined["verdict"], "fail")
        self.assertIn("adversarial_unsupported_claim", combined["gateFailures"])

    def test_adversarial_issue_kind_is_derived_from_evidence_sides(self):
        self.assertEqual(
            detailed.normalize_adversarial_kind("unsupported", "R0001", "G0001"),
            "contradicted",
        )
        self.assertEqual(
            detailed.normalize_adversarial_kind("contradicted", "", "G0001"),
            "unsupported",
        )
        self.assertEqual(
            detailed.normalize_adversarial_kind("contradicted", "R0001", ""),
            "missing",
        )

    def test_gate_rejects_critical_contradiction_even_with_high_coverage(self):
        items = [
            self._item("study_design", "critical", "exact"),
            self._item("sample_size", "critical", "contradicted"),
            self._item("analysis_methods", "critical", "compatible"),
            self._item("key_results", "critical", "exact"),
            self._item("conclusion", "critical", "exact"),
            self._item("limitations", "major", "partial"),
        ]
        result = detailed.derive_metrics_and_verdict(items)
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("critical_contradiction", result["gateFailures"])

    def test_gate_rejects_any_critical_missing_fact(self):
        items = [
            self._item("study_design", "critical", "exact"),
            self._item("search_sources_and_dates", "critical", "missing"),
            self._item("conclusion", "critical", "exact"),
        ]
        result = detailed.derive_metrics_and_verdict(items)
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("critical_missing_fact", result["gateFailures"])

    def test_strict_gate_rejects_noncritical_unsupported_addition(self):
        items = [
            self._item("study_design", "critical", "exact"),
            self._item("conclusion", "critical", "exact"),
            self._item("limitations", "major", "partial", ["unsupported"]),
        ]
        result = detailed.derive_metrics_and_verdict(items)
        self.assertEqual(result["usabilityVerdict"], "pass")
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("unsupported_claim", result["gateFailures"])

    def test_not_applicable_items_do_not_reduce_recall(self):
        items = [
            self._item("algorithm", "major", "not_applicable"),
            self._item("study_design", "critical", "exact"),
            self._item("conclusion", "critical", "compatible"),
        ]
        result = detailed.derive_metrics_and_verdict(items)
        self.assertEqual(result["applicableItems"], 2)
        self.assertAlmostEqual(result["weightedFidelity"], 0.95)

    def test_cache_fingerprint_changes_with_generated_output(self):
        prompt_hash = hashlib.sha256(b"prompt").hexdigest()
        first = detailed.cache_fingerprint("source", "generated-a", prompt_hash)
        second = detailed.cache_fingerprint("source", "generated-b", prompt_hash)
        self.assertNotEqual(first, second)

    def test_model_result_requires_valid_evidence_locator_fields(self):
        result = {
            "paperType": "trial",
            "items": [],
            "overallAssessment": "assessment",
        }
        for identifier, importance, _ in detailed.item_spec("randomized-trial"):
            result["items"].append(
                {
                    "id": identifier,
                    "importance": importance,
                    "status": "exact",
                    "issueKinds": [],
                    "referenceFact": "fact",
                    "generatedFact": "fact",
                    "sourceEvidence": {"locator": "R0001"},
                    "generatedEvidence": {"locator": "G0001"},
                    "explanation": "same",
                }
            )
        checked = detailed.validate_model_result(result, "randomized-trial")
        self.assertEqual(checked["items"][0]["sourceEvidence"]["locator"], "R0001")

    def test_numbered_evidence_preserves_resolvable_source_blocks(self):
        numbered, units = detailed.number_evidence(
            "First sentence. Second sentence with 6609 participants.", "R", max_chars=30
        )
        self.assertIn("[R0001]", numbered)
        self.assertEqual(" ".join(units.values()), "First sentence. Second sentence with 6609 participants.")

    def test_xml_body_excludes_reference_list(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "article.xml"
            path.write_text(
                "<article><body><sec><p>Scientific body.</p></sec></body>"
                "<back><ref-list><ref>Reference only.</ref></ref-list></back></article>",
                encoding="utf-8",
            )
            self.assertEqual(detailed.xml_body_text(path), "Scientific body.")

    def test_prompt_requires_immutable_evidence_locator(self):
        system, _ = detailed.grader_prompt("randomized-trial")
        self.assertIn("immutable evidence blocks", system)
        self.assertIn("Never invent a locator", system)

    @staticmethod
    def _item(identifier: str, importance: str, status: str, issue_kinds=None) -> dict:
        if issue_kinds is None:
            issue_kinds = {
                "missing": ["missing"],
                "contradicted": ["contradicted"],
                "unsupported": ["unsupported"],
                "partial": ["missing"],
            }.get(status, [])
        return {
            "id": identifier,
            "importance": importance,
            "status": status,
            "issueKinds": issue_kinds,
            "referenceFact": "reference",
            "generatedFact": "generated",
            "sourceEvidence": {"locator": "R0001", "quote": "reference"},
            "generatedEvidence": {"locator": "G0001", "quote": "generated"},
            "explanation": "comparison",
            "sourceEvidenceValid": True,
            "generatedEvidenceValid": True,
        }


if __name__ == "__main__":
    unittest.main()
