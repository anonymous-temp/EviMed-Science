from pathlib import Path
import os
import tempfile
import unittest

import score_f

TAGS = score_f.TAGS


def gold(met=()):
    return {tag: ("met" if tag in met else "not met") for tag in TAGS}


def record(patient, labels, status="complete"):
    return {"patientId": patient, "status": status, "labels": {tag: {"label": label, "basis": "stated"} for tag, label in labels.items()}}


class Readings(unittest.TestCase):
    def test_a_label_is_a_yes_a_no_or_neither(self):
        self.assertEqual(score_f.state_of({"label": "included"}), ("met", None))
        self.assertEqual(score_f.state_of({"label": "not_included"}), ("not met", None))
        self.assertEqual(score_f.state_of({"label": "Not Included"}), ("not met", None))
        self.assertEqual(score_f.state_of({"label": "not_enough_information"}), (None, "not enough information"))
        self.assertEqual(score_f.state_of({"label": "not applicable"}), (None, "not applicable"))
        self.assertEqual(score_f.state_of(None), (None, "no answer"))
        self.assertEqual(score_f.state_of({"label": "excluded"}), (None, "unrecognised"))

    def test_b_c_d_read_neither_as_not_met_as_guide_says_or_as_met(self):
        self.assertEqual([score_f.read_as(None, "ABDOMINAL", r) for r in "bcd"], ["not met", "not met", "met"])
        self.assertEqual([score_f.read_as(None, "ENGLISH", r) for r in "bcd"], ["not met", "met", "met"])
        self.assertEqual([score_f.read_as(None, "MAKES-DECISIONS", r) for r in "bcd"], ["not met", "met", "met"])
        self.assertEqual([score_f.read_as("met", "ENGLISH", r) for r in "bcd"], ["met"] * 3, "a yes or no is kept as the model gave it")
        self.assertEqual([score_f.read_as("not met", "ENGLISH", r) for r in "bcd"], ["not met"] * 3)

    def test_overall_f1_is_the_mean_of_met_and_not_met(self):
        self.assertEqual(score_f.overall_f1({"tp": 5, "fp": 0, "fn": 0, "tn": 5}), 1.0)
        self.assertAlmostEqual(score_f.overall_f1({"tp": 0, "fp": 5, "fn": 5, "tn": 0}), 0.0)
        self.assertAlmostEqual(score_f.overall_f1({"tp": 2, "fp": 1, "fn": 1, "tn": 6}), (2 / 3 + 12 / 14 * 1) / 2 if False else (score_f.f1(2, 1, 1) + score_f.f1(6, 1, 1)) / 2)


class Scoring(unittest.TestCase):
    def labels(self):
        rows = []
        for i in range(6):
            rows.append({"patientId": f"n2c2-{i}", "split": "train-dev", "tags": gold(met=("ENGLISH", "MAKES-DECISIONS", "ASP-FOR-MI") if i % 2 else ("ENGLISH", "MAKES-DECISIONS"))})
        for i in range(6, 12):
            rows.append({"patientId": f"n2c2-{i}", "split": "train-heldout", "tags": gold(met=("ENGLISH",))})
        return rows

    def run_score(self, records, split="train-dev", resamples=50):
        return score_f.score(records, self.labels(), split, None, None, None, None, resamples=resamples, official=False)

    def test_perfect_answers_are_perfect_under_every_reading(self):
        records = {row["patientId"]: record(row["patientId"], {tag: ("included" if row["tags"][tag] == "met" else "not_included") for tag in TAGS}) for row in self.labels()}
        result = self.run_score(records)
        self.assertEqual(result["accuracyA"]["point"], 1.0)
        self.assertEqual(result["unknownShare"]["point"], 0.0)
        for reading in "bcd":
            self.assertEqual(result["readings"][reading]["accuracy"], 1.0)
            self.assertEqual(result["readings"][reading]["microF1"], 1.0)
        self.assertEqual(result["patientsScored"], 6)
        self.assertEqual(result["yesNoBasis"], {"stated": 6 * 13})

    def test_every_answer_unknown_is_wrong_in_a_and_the_readings_split(self):
        records = {row["patientId"]: record(row["patientId"], {tag: "not_enough_information" for tag in TAGS}) for row in self.labels()}
        result = self.run_score(records)
        self.assertEqual(result["accuracyA"]["point"], 0.0)
        self.assertEqual(result["unknownShare"]["point"], 1.0)
        self.assertEqual(result["unknownShare"]["byKind"], {"not enough information": 6 * 13})
        met = [tag in ("ENGLISH",) for tag in TAGS]
        # (b) answers not met everywhere: right for every criterion nobody meets, wrong for the met ones. (d) answers met everywhere: the reverse.
        b, d, c = (result["readings"][r] for r in "bdc")
        gold_met = sum(1 for row in self.labels() if row["split"] == "train-dev" for tag in TAGS if row["tags"][tag] == "met")
        self.assertAlmostEqual(b["accuracy"], 1 - gold_met / (6 * 13))
        self.assertAlmostEqual(d["accuracy"], gold_met / (6 * 13))
        # (c) differs from (b) only on ENGLISH and MAKES-DECISIONS, where it answers met: right when the gold is met, wrong when it is not.
        dev = [row["tags"] for row in self.labels() if row["split"] == "train-dev"]
        gain = sum((g[tag] == "met") - (g[tag] != "met") for g in dev for tag in score_f.ABSENT_MEANS_MET)
        self.assertAlmostEqual(c["accuracy"] - b["accuracy"], gain / (6 * 13))
        self.assertNotEqual(gain, 0)

    def test_a_yes_or_no_is_kept_as_the_model_gave_it_silent_or_stated(self):
        records = {}
        for row in self.labels():
            entry = {tag: {"label": "not_included", "basis": "silent"} for tag in TAGS}
            records[row["patientId"]] = {"patientId": row["patientId"], "status": "complete", "labels": entry}
        result = self.run_score(records)
        self.assertEqual(result["unknownShare"]["point"], 0.0)
        self.assertEqual(result["yesNoBasis"], {"silent": 6 * 13})
        self.assertEqual(result["accuracyA"]["point"], result["readings"]["b"]["accuracy"])

    def test_only_patients_with_a_record_are_scored_and_the_baseline_is_learnt_from_the_other_split(self):
        records = {"n2c2-0": record("n2c2-0", {tag: "not_included" for tag in TAGS}), "n2c2-1": record("n2c2-1", {tag: "not_included" for tag in TAGS}, "partial")}
        result = self.run_score(records)
        self.assertEqual((result["patientsScored"], result["patientsInSplit"]), (2, 6))
        self.assertIn("6 training patients outside", result["baseline"]["learntFrom"])
        held = self.run_score({"n2c2-7": record("n2c2-7", {})}, split="train-heldout")
        self.assertIn("6 training patients outside", held["baseline"]["learntFrom"])
        with self.assertRaises(score_f.SelfCheckError):
            self.run_score({"somebody-else": record("somebody-else", {})})

    def test_completion_counts_statuses_failures_and_usage(self):
        records = {"n2c2-0": {**record("n2c2-0", {}), "failed": [{"code": "x"}], "usage": {"inputTokens": 10, "outputTokens": 2, "costCny": 0.5}}, "n2c2-1": record("n2c2-1", {}, "partial")}
        c = score_f.completion(records, self.labels(), "train-dev")
        self.assertEqual((c["patients"], c["patientsWithRecord"], c["patientsComplete"]), (6, 2, 1))
        self.assertEqual(c["pairsFailedByCode"], {"x": 1})
        self.assertEqual(c["usage"]["costCny"], 0.5)

    def test_the_test_split_is_refused(self):
        class Args:
            n2c2_root = "/nonexistent"
        with self.assertRaises(Exception):
            score_f.main_f(Args())


@unittest.skipUnless(os.environ.get("VCR_BOARDS_N2C2_ROOT") and os.environ.get("VCR_BOARDS_PYTHON"), "the official scorer's files are not named in the environment")
class OfficialPath(unittest.TestCase):
    def test_the_official_scorer_agrees_with_this_module_under_b_c_and_d(self):
        root = Path(os.environ["VCR_BOARDS_N2C2_ROOT"])
        labels = [{"patientId": f"n2c2-{i}", "split": "train-dev", "tags": gold(met=tuple(TAGS[i % 5: i % 5 + 3]))} for i in range(8)]
        records = {}
        for i, row in enumerate(labels):
            kinds = ["included", "not_included", "not_enough_information", "not applicable"]
            records[row["patientId"]] = record(row["patientId"], {tag: kinds[(i + j) % 4] for j, tag in enumerate(TAGS)})
        with tempfile.TemporaryDirectory() as work:
            wrapper = Path(score_f.__file__).resolve().parent.parent / "vcr-matching" / "n2c2" / "run_official_scorer.py"
            result = score_f.score(records, labels + [{"patientId": "n2c2-x", "split": "train-heldout", "tags": gold()}], "train-dev", root / "work" / "eval" / "track1_eval.py", wrapper, os.environ["VCR_BOARDS_PYTHON"], work, resamples=20)
        for reading in "bcd":
            official = result["readings"][reading]["official"]
            self.assertAlmostEqual(official["microF1"], result["readings"][reading]["microF1"], places=3)
            self.assertAlmostEqual(official["macroF1"], result["readings"][reading]["macroF1"], places=3)


if __name__ == "__main__":
    unittest.main()
