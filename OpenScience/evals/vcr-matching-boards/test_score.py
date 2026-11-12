import unittest

import score

OFFICIAL_OUTPUT = """
==============================
Evaluation summary (TrialGPT full_email_*.json; qrels defines per-patient pool; subtrials collapsed to base)
==============================
(patients=58, K=10, max_rel=2, MRR_relevant=label>=2, subtrial_agg=first, pad_to_pool=True)

[Reported metrics]
  MRR:                     0.9138
  GradedAP:                0.8535
  GradedPrecision@10: 0.7069
  GradednDCG@10:      1.0000
"""


class StatisticsTests(unittest.TestCase):
    def test_interval_rounds_outward(self):
        self.assertEqual(score.interval(list(range(101))), [2, 98])

    def test_bootstrap_is_stable_for_a_seed_and_macro_is_the_mean_of_cohort_means(self):
        groups = {"a": {"m": [float(n) for n in range(1, 13)]}, "b": {"m": [10.0, 10.0]}, "empty": {"m": []}}
        first = score.bootstrap_groups(groups, resamples=500, seed=7, label="x")
        again = score.bootstrap_groups(groups, resamples=500, seed=7, label="x")
        other = score.bootstrap_groups(groups, resamples=500, seed=8, label="x")
        self.assertEqual(first, again)
        self.assertNotEqual(first["a"]["m"]["ci"], other["a"]["m"]["ci"])
        self.assertEqual(first["a"]["m"]["point"], 6.5)
        self.assertEqual(first["b"]["m"]["ci"], [10.0, 10.0])
        self.assertEqual(first["macro"]["m"]["point"], 8.25)
        self.assertEqual(first["macro"]["m"]["cohorts"], ["a", "b"])  # the empty cohort is not a cohort
        low, high = first["a"]["m"]["ci"]
        self.assertTrue(1.0 <= low <= 6.5 <= high <= 12.0)
        self.assertNotEqual(first["a"]["m"]["ci"], score.bootstrap_groups(groups, 500, 7, label="y")["a"]["m"]["ci"])

    def test_paired_bootstrap_of_identical_columns_is_exactly_zero(self):
        per_patient = [(5, 3, 3), (7, 7, 7), (4, 0, 0), (9, 5, 5)]
        result = score.paired_rate_bootstrap(per_patient, resamples=300, seed=1, label="c")
        self.assertEqual(result["difference"], [0.0, 0.0])
        self.assertEqual(result, score.paired_rate_bootstrap(per_patient, resamples=300, seed=1, label="c"))

    def test_parse_official_output(self):
        patients, numbers = score.parse_rankings_output(OFFICIAL_OUTPUT)
        self.assertEqual(patients, 58)
        self.assertEqual(numbers, {"MRR": 0.9138, "gAP": 0.8535, "gP": 0.7069, "gNDCG": 1.0})
        with self.assertRaises(RuntimeError):
            score.parse_rankings_output("nothing here")


def clause(kind, number, text):
    return {"kind": kind, "number": number, "text": text}


CASES = [
    {"patientId": "P1", "trials": [{"registryId": "NCT00000001", "clauses": [
        clause("inclusion", 0, "adult"), clause("inclusion", 1, "stable angina"), clause("exclusion", 0, "pregnancy")]}]},
    {"patientId": "P2", "trials": [{"registryId": "NCT00000002", "clauses": [
        clause("inclusion", 0, "BMI over 30"), clause("exclusion", 0, "active infection"), clause("exclusion", 1, "male only")]}]},
]


def label(pid, trial, kind, number, expert, gpt4, silent):
    return {"annotationId": len(LABELS), "patientId": pid, "registryId": trial, "kind": kind, "number": number,
            "expert": expert, "gpt4": gpt4, "expertSentences": [] if silent else [0]}


LABELS = []
for row in [("P1", "NCT00000001", "inclusion", 0, "included", "included", False),
            ("P1", "NCT00000001", "inclusion", 1, "not enough information", "included", True),
            ("P1", "NCT00000001", "exclusion", 0, "not excluded", "not excluded", True),
            ("P2", "NCT00000002", "inclusion", 0, "not included", "not included", False),
            ("P2", "NCT00000002", "exclusion", 0, "excluded", "not excluded", False),
            ("P2", "NCT00000002", "exclusion", 1, "not applicable", "not applicable", True)]:
    LABELS.append(label(*row))


def crit(kind, number, answer, basis, text=None):
    return {"kind": kind, "number": number, "label": answer, "basis": basis, "sentenceIds": [], "text": text}


RECORDS = {
    "P1": {"patientId": "P1", "status": "complete", "ranking": [{"registryId": "NCT00000001", "criteria": [
        crit("inclusion", 0, "included", "evidence", "adult"),
        crit("inclusion", "1", "not enough information", "not_documented"),
        crit("exclusion", 0, "Not Excluded", "not_documented_not_excluded"),
        crit("exclusion", 0, "excluded", "evidence"),           # repeated: the first answer stands
        crit("exclusion", 9, "excluded", "evidence")]}]},        # no such clause
    "P2": {"patientId": "P2", "status": "partial", "ranking": [{"registryId": "NCT00000002", "criteria": [
        crit("exclusion", 0, "not excluded", "evidence", "a different text"),
        crit("exclusion", 1, "n/a", "evidence")]}]},             # inclusion 0 never answered
}
EXPECTED = {"rows": 6, "gpt4_agree": 4}


class CriterionTests(unittest.TestCase):
    def setUp(self):
        self.result, self.rows = score.score_criterion(CASES, LABELS, RECORDS, resamples=200, seed=3, expected=EXPECTED)

    def test_agreement_counts_missing_and_unrecognised_as_wrong(self):
        agreement = self.result["agreement"]
        self.assertEqual((agreement["ours"]["correct"], agreement["gpt4"]["correct"]), (3, 4))
        self.assertAlmostEqual(agreement["difference"]["value"], -1 / 6)
        self.assertEqual({key: self.result["answers"][key] for key in ("usable", "missing", "unrecognised")},
                         {"usable": 4, "missing": 1, "unrecognised": 1})
        self.assertEqual((self.result["answers"]["criteriaMatchingNoClause"], self.result["answers"]["criteriaRepeated"],
                          self.result["answers"]["criteriaTextDiffers"]), (1, 1, 1))

    def test_per_label_precision_and_recall(self):
        table = self.result["perLabel"]
        self.assertEqual((table["included"]["ours"]["precision"], table["included"]["ours"]["recall"]), (1.0, 1.0))
        self.assertEqual((table["not excluded"]["ours"]["precision"], table["not excluded"]["ours"]["recall"]), (0.5, 1.0))
        self.assertIsNone(table["excluded"]["ours"]["precision"])
        self.assertEqual(table["excluded"]["ours"]["recall"], 0.0)
        self.assertEqual(table["not applicable"]["ours"]["recall"], 0.0)
        self.assertEqual({label for label, entry in table.items() if entry["decisive"]}, {"included", "not included", "excluded"})
        self.assertEqual({key: self.result["decisiveRows"][key] for key in ("rows", "oursCorrect", "gpt4Correct")},
                         {"rows": 3, "oursCorrect": 1, "gpt4Correct": 2})

    def test_confusion_and_false_favourable(self):
        self.assertEqual(self.result["confusion"]["ours"]["excluded"]["not excluded"], 1)
        self.assertEqual(self.result["confusion"]["ours"]["not included"]["(missing)"], 1)
        self.assertEqual(self.result["confusion"]["ours"]["not applicable"]["(unrecognised)"], 1)
        self.assertEqual(self.result["confusion"]["gpt4"]["not enough information"]["included"], 1)
        fav = self.result["falseFavourable"]
        self.assertEqual((fav["ours"]["count"], fav["ours"]["byExpertLabel"]), (1, {"excluded": 1}))
        self.assertEqual((fav["gpt4"]["count"], fav["gpt4"]["byExpertLabel"]), (2, {"not enough information": 1, "excluded": 1}))

    def test_silent_rows_split_by_basis(self):
        silent = self.result["silentRows"]
        self.assertEqual((silent["rows"], silent["oursCorrect"], silent["gpt4Correct"]), (3, 2, 2))
        self.assertEqual(silent["expertLabels"], {"not enough information": 1, "not excluded": 1, "not applicable": 1})
        self.assertEqual({basis: (entry["rows"], entry["correct"]) for basis, entry in silent["byBasis"].items()},
                         {"not_documented": (1, 1), "not_documented_not_excluded": (1, 1), "evidence": (1, 0)})
        self.assertEqual(self.result["evidencedRows"]["rows"], 3)

    def test_private_rows_stay_out_of_the_aggregate(self):
        self.assertEqual(len(self.rows), 6)
        blob = repr(self.result)
        self.assertNotIn("P1", blob)
        self.assertNotIn("NCT0000", blob)

    def test_same_seed_gives_the_same_interval(self):
        again, _ = score.score_criterion(CASES, LABELS, RECORDS, resamples=200, seed=3, expected=EXPECTED)
        self.assertEqual(again["agreement"], self.result["agreement"])

    def test_a_gpt4_column_that_does_not_reproduce_fails_loudly(self):
        with self.assertRaises(score.SelfCheckError):
            score.score_criterion(CASES, LABELS, RECORDS, resamples=10, expected={"rows": 6, "gpt4_agree": 5})
        with self.assertRaises(score.SelfCheckError):
            score.score_criterion(CASES, LABELS[:5], RECORDS, resamples=10, expected=EXPECTED)

    def test_no_answers_at_all_scores_zero_over_every_row(self):
        result, _ = score.score_criterion(CASES, LABELS, {}, resamples=10, expected=EXPECTED)
        self.assertEqual((result["agreement"]["ours"]["correct"], result["answers"]["missing"]), (0, 6))


if __name__ == "__main__":
    unittest.main()
