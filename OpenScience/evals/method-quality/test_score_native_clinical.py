"""The clinical extraction evaluation has two arms, `native` and `on`.

It used to run a third, `off`, whose prompt was byte-identical to `native`'s (the enhanced guidance only ever went to `on`), so
the two were replicates of one arm and the gap between them was the noise floor, not a finding. Archives written then still hold
`off` cells; the scorer reads them as `native`, and the committed scorecard is what the scorer makes of its archives.
"""
import json
import unittest
from pathlib import Path

import score_native_clinical as scorer

ROOT = Path(__file__).resolve().parents[2]
CARD = json.loads((ROOT / "evals/vcr-matching/openmed-scorecard.json").read_text())
REFERENCE = json.loads((ROOT / "evals/vcr-matching/corpora/chinese-synthetic/reference.json").read_text())
RESULTS = ROOT / "evals/vcr-matching/results/openmed-v3-20261009"


def reference(*case_ids):
    return {"cases": [{"id": case_id, "task": "eligibility", "sourceGroup": f"g-{case_id}", "dataClass": "synthetic",
                       "reference": {"labels": {case_id: "eligible"}, "states": ["eligible", "ineligible", "insufficient_evidence"]}}
                      for case_id in case_ids]}


def cell(case_id, arm, label, repeat=0, cost="0.01", latency=1000):
    return {"cell": f"{case_id}-{arm}-{repeat}", "caseId": case_id, "group": f"g-{case_id}", "dataClass": "synthetic", "arm": arm,
            "parseError": None, "code": 0, "writeIssues": [], "latencyMs": latency,
            "usage": [{"actual_cost": cost, "observed_model": "deepseek-flash"}],
            "predicted": {"labels": {case_id: label}}}


class LegacyOffArmTests(unittest.TestCase):
    def test_off_cells_are_read_as_native_and_no_third_arm_is_reported(self):
        archive = {"manifest": {}, "predictions": [
            cell("a", "native", "eligible"), cell("a", "off", "ineligible"), cell("a", "on", "eligible"),
            cell("b", "native", "eligible", repeat=1), cell("b", "off", "eligible", repeat=1)]}
        report = scorer.summarize(reference("a", "b"), archive)
        self.assertEqual(sorted(report["arms"]), ["native", "on"])
        native = report["arms"]["native"]
        self.assertEqual(native["attempted"], 4, "the off cells are replicates of native: four native cells")
        self.assertEqual(sorted(row["id"] for row in native["cases"]), ["a-native-0", "a-off-0", "b-native-1", "b-off-1"],
                         "each cell keeps its own id, so the pooled arm can still be traced to the archive")
        self.assertEqual(report["arms"]["on"]["attempted"], 1)
        # a eligible-by-reference chart judged ineligible once in the pool is one false exclusion out of the pooled eligible charts
        row = native["scorecard"][0]
        self.assertEqual((row["cases"], row["n"], row["correct"], row["falseExclusions"], row["eligibleReference"]), (4, 4, 3, 1, 4))

    def test_an_archive_without_off_cells_scores_as_before(self):
        archive = {"manifest": {}, "predictions": [cell("a", "native", "eligible"), cell("a", "on", "ineligible")]}
        report = scorer.summarize(reference("a"), archive)
        self.assertEqual(sorted(report["arms"]), ["native", "on"])
        self.assertEqual(report["arms"]["native"]["scorecard"][0]["correct"], 1)
        self.assertEqual(report["arms"]["on"]["scorecard"][0]["correct"], 0)


class CommittedScorecardTests(unittest.TestCase):
    """The scorecard's numbers are the scorer's, not typed: each section with an archive in the repository is re-derived here."""

    def derived(self, archive_name):
        archive = json.loads((RESULTS / archive_name).read_text())
        arms = scorer.summarize(REFERENCE, archive)["arms"]
        return {name: {key: value for key, value in arm.items() if key != "cases"} for name, arm in arms.items()}

    def test_the_paired_batch_has_two_arms_and_reproduces_from_its_archive(self):
        recorded = CARD["syntheticPaired"]["arms"]
        self.assertEqual(sorted(recorded), ["native", "on"])
        self.assertEqual(recorded, self.derived("native-predictions.json"))
        self.assertEqual((recorded["native"]["attempted"], recorded["on"]["attempted"]), (48, 24), "native pools the 24 off cells")

    def test_the_targeted_retest_has_two_arms_and_reproduces_from_its_archive(self):
        recorded = CARD["targetedUnitRetest"]["arms"]
        self.assertEqual(sorted(recorded), ["native", "on"])
        self.assertEqual(recorded, self.derived("unit-regression-predictions.json"))

    def test_no_section_of_the_scorecard_keeps_an_off_arm(self):
        sections = {"syntheticPaired": CARD["syntheticPaired"],
                    "targetedUnitRetest": CARD["targetedUnitRetest"],
                    "localReview20261010.syntheticClinical": CARD["localReview20261010"]["syntheticClinical"],
                    "releaseClosure20261010.clinicalSynthetic": CARD["releaseClosure20261010"]["clinicalSynthetic"]}
        for name, section in sections.items():
            self.assertEqual(sorted(section["arms"]), ["native", "on"], name)


if __name__ == "__main__":
    unittest.main()
