"""Synthetic math fixtures are not pharmacist annotations or clinical validation."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

MODULE = Path(__file__).resolve().parents[1] / "agreement.py"
spec = importlib.util.spec_from_file_location("geo_agreement", MODULE)
agreement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agreement)


class AgreementTests(unittest.TestCase):
    def test_weighted_kappa_matches_independent_sklearn(self):
        from sklearn.metrics import cohen_kappa_score
        a, b = [0, 1, 2, 3, 4, 4], [0, 2, 2, 4, 4, 1]
        for mode in ("linear", "quadratic"):
            self.assertAlmostEqual(agreement.kappa(a, b, size=5, weights=mode),
                                   cohen_kappa_score(a, b, labels=range(5), weights=mode))
        self.assertIsNone(agreement.kappa([4, 4], [4, 4], size=5))
        self.assertIsNone(agreement.kappa([], [], size=5))

    def test_genuine_ordinal_alpha_with_missing_data(self):
        import krippendorff
        import numpy as np
        # Maintainer's documented missing-data example, evaluated as ordinal.
        rows = [
            [None, None, None, None, None, 3, 4, 1, 2, 1, 1, 3, 3, None, 3],
            [1, None, 2, 1, 3, 3, 4, 3, None, None, None, None, None, None, None],
            [None, None, 2, 1, 3, 4, 4, None, 2, 1, 1, 3, 3, None, 4],
        ]
        expected = krippendorff.alpha(reliability_data=np.array(rows, dtype=float),
                                     value_domain=range(5), level_of_measurement="ordinal")
        actual = agreement.ordinal_alpha(list(zip(*rows)))
        self.assertAlmostEqual(actual, expected)
        interval = krippendorff.alpha(reliability_data=np.array(rows, dtype=float),
                                     value_domain=range(5), level_of_measurement="interval")
        self.assertNotAlmostEqual(actual, interval)
        self.assertIsNone(agreement.ordinal_alpha([[0], [None, 2], [None]]))
        self.assertIsNone(agreement.ordinal_alpha([[4, 4], [4, 4]]))

    def test_empty_template_has_no_fabricated_agreement(self):
        dataset, digest = agreement.load_dataset(MODULE.with_name("dataset-template.json"))
        result = agreement.analyze(dataset, digest, bootstrap=50)
        self.assertEqual(result["severity_basis"], "initial")
        self.assertEqual(result["independentPharmacistLabels"], 0)
        self.assertIsNone(result["agreementResults"])
        self.assertEqual(result["status"], "awaiting_independent_labels")

    def test_missing_severity_never_becomes_s0(self):
        dataset = synthetic_dataset()
        report = agreement.analyze(dataset, "test", bootstrap=50)
        pair = report["agreementResults"]["pairs"][0]
        self.assertEqual(pair["verdict"]["n"], 3)
        self.assertEqual(pair["severity"]["n"], 1)
        self.assertIsNone(pair["severity"]["linearKappa"])
        comparison = report["modelComparisons"][0]
        self.assertEqual(comparison["seriousErrors"]["referencePositive"], 1)
        self.assertEqual(comparison["seriousErrors"]["missed"], 1)
        self.assertEqual(comparison["seriousErrors"]["missingModel"], 0)
        self.assertEqual(comparison["seriousErrors"]["missedUnitIds"], ["u0"])

    def test_cluster_interval_and_missing_model_are_explicit(self):
        dataset = synthetic_dataset()
        dataset["ratings"] = [r for r in dataset["ratings"] if not (r["raterId"] == "model" and r["unitId"] == "u0")]
        for unit in dataset["units"]:
            unit["groupId"] = "one-answer"
        result = agreement.analyze(dataset, "test", bootstrap=50)
        serious = result["modelComparisons"][0]["seriousErrors"]
        self.assertEqual(serious["missingModel"], 1)
        self.assertIsNone(serious["sensitivity"])
        self.assertEqual(serious["sensitivityCi"]["reason"], "fewer_than_two_clusters")

    def test_integrity_rejects_duplicates_wrong_offsets_and_model_reference(self):
        for defect in ("duplicate", "offset", "model_reference", "split_leak", "wrong_rubric"):
            data = synthetic_dataset()
            if defect == "duplicate":
                data["ratings"].append(copy.deepcopy(data["ratings"][0]))
            elif defect == "offset":
                data["units"][0]["span"]["end"] = 1
            elif defect == "model_reference":
                data["references"][0]["sourceRatingIds"] = ["model-u0"]
            elif defect == "split_leak":
                data["units"][0]["groupId"] = data["units"][1]["groupId"]
                data["units"][1]["datasetSplit"] = "held_out"
            else:
                data["ratings"][0]["rubricVersion"] = "other"
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                agreement.validate_relations(data)


def synthetic_dataset():
    """In-memory unit fixtures only; never installed as an empirical dataset."""
    data = json.loads(MODULE.with_name("dataset-template.json").read_text())
    data["datasetId"] = "synthetic-test-only"
    data["analysis"]["referenceRule"] = "test-human-reference/v1"
    for rater in ("one", "two", "model"):
        data["raters"].append({"raterId": rater, "kind": "model" if rater == "model" else "pharmacist",
            "qualificationBasis": "Synthetic fixture", "modelVersion": "test" if rater == "model" else None, "independent": True})
    for i in range(3):
        text = f"Synthetic statement {i}."
        data["units"].append({"unitId": f"u{i}", "answerId": f"answer{i}", "groupId": f"group{i}",
            "unitKind": "statement", "question": "Synthetic", "answer": text, "answerSha256": hashlib.sha256(text.encode()).hexdigest(),
            "statement": text, "span": {"start": 0, "end": len(text), "offsetUnit": "unicode_codepoints"},
            "context": {"product": "Synthetic", "population": None, "jurisdiction": None, "asOf": None, "missingContext": []},
            "evidence": [], "datasetSplit": "codebook_pilot"})
        for rater in ("one", "two", "model"):
            wrong = i == 0 and rater != "model"
            data["ratings"].append({"ratingId": f"{rater}-u{i}", "unitId": f"u{i}", "raterId": rater,
                "round": "independent_initial", "status": "rated", "verdict": "wrong" if wrong else "correct",
                "errorType": "number" if wrong else None, "severity": "S4" if wrong else None,
                "severityMissingReason": None if wrong else "not_applicable_not_wrong", "rationale": "Synthetic test only",
                "evidenceSourceIds": [], "blindedToModel": True, "blindedToOtherRaters": True,
                "createdAt": "2026-09-30T00:00:00Z", "rubricVersion": data["rubric"]["version"]})
    data["references"] = [{"unitId": "u0", "basis": "independent_pharmacist_consensus", "sourceRatingIds": ["one-u0", "two-u0"],
        "ruleVersion": "test-human-reference/v1", "verdict": "wrong", "severity": "S4", "disputed": False,
        "rationale": "Synthetic test only", "createdAt": "2026-09-30T00:00:00Z"}]
    return data


if __name__ == "__main__":
    unittest.main()
