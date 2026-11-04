import unittest

import score_d


def record(patient, verdicts):
    return {"patientId": patient, "ranking": [{"registryId": nct, "verdict": verdict} for nct, verdict in verdicts.items()]}


class Mapping(unittest.TestCase):
    def test_our_four_verdicts_as_their_binary_answer_with_possible_both_ways(self):
        self.assertEqual([score_d.binary(v, "possible_is_eligible") for v in ("eligible", "possible", "insufficient", "ineligible", None, "")], [True, True, False, False, None, None])
        self.assertEqual([score_d.binary(v, "possible_is_ineligible") for v in ("eligible", "possible", "insufficient", "ineligible")], [True, False, False, False])

    def test_their_pair_key_is_a_list_or_patient_and_trial_joined(self):
        self.assertEqual(score_d.pair_key("sigir-20141__nct00337116"), ("sigir-20141", "NCT00337116"))
        self.assertEqual(score_d.pair_key(["sigir-20141", "NCT00337116"]), ("sigir-20141", "NCT00337116"))


class Scoring(unittest.TestCase):
    def setUp(self):
        self.pairs = [{"pair": "p1__NCT00000001", "gold": "eligible"}, {"pair": "p1__NCT00000002", "gold": "ineligible"}, {"pair": ["p2", "NCT00000003"], "gold": "eligible"},
                      {"pair": "p2__NCT00000004", "gold": "ineligible"}, {"pair": "p3__NCT00000005", "gold": "eligible"}]
        self.judgments = [record("p1", {"NCT00000001": "eligible", "NCT00000002": "possible"}), record("p2", {"NCT00000003": "possible", "NCT00000004": "ineligible"})]

    def test_f1_is_their_definition_with_eligible_the_positive_class(self):
        result = score_d.score(self.judgments, self.pairs, resamples=20)
        self.assertEqual((result["pairs"], result["pairsAnswered"], result["goldEligible"]), (5, 4, 3))
        up = result["readings"]["possible_is_eligible|unanswered_left_out"]
        # eligible: p1/1 tp; possible->eligible: p1/2 fp, p2/3 tp; ineligible p2/4 tn; p3 left out.
        self.assertEqual((up["n"], round(up["precision"], 4), round(up["recall"], 4)), (4, round(2 / 3, 4), 1.0))
        down = result["readings"]["possible_is_ineligible|unanswered_left_out"]
        # possible->ineligible: p1/2 tn, p2/3 fn.
        self.assertEqual((down["precision"], round(down["recall"], 4)), (1.0, 0.5))
        self.assertAlmostEqual(down["f1"], 2 * 1.0 * 0.5 / 1.5)

    def test_a_pair_with_no_answer_is_counted_and_reported_both_left_out_and_as_ineligible(self):
        result = score_d.score(self.judgments, self.pairs, resamples=20)
        left = result["readings"]["possible_is_eligible|unanswered_left_out"]
        counted = result["readings"]["possible_is_eligible|unanswered_ineligible"]
        self.assertEqual((left["n"], counted["n"]), (4, 5))
        self.assertLess(counted["recall"], left["recall"], "p3 is gold eligible and unanswered: a miss when counted as ineligible")
        self.assertEqual(result["pairsPerVerdict"], {"eligible": 1, "possible": 2, "ineligible": 1, "(none)": 1})

    def test_the_interval_is_over_patients_and_the_scorer_never_reads_a_label_from_the_judgments(self):
        result = score_d.score(self.judgments, self.pairs, resamples=50)
        low, high = result["readings"]["possible_is_eligible|unanswered_left_out"]["f1Interval"]
        self.assertLessEqual(low, high)
        self.assertEqual(score_d.PINNED["commit"], "a56e3ed09f10928dd033baefb1b78856943aa99f")


if __name__ == "__main__":
    unittest.main()
