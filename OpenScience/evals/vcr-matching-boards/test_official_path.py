"""Run the unchanged official evaluators on synthetic rankings.

These tests need the pinned TrialGPT 2.0 clone, so they skip unless VCR_BOARDS_TG2
points at it (and VCR_BOARDS_PYTHON at an interpreter with tqdm). A skipped run
proves nothing about the official path: selfcheck.py is the same proof on the
prepared boards.
"""
import json
import os
from pathlib import Path
import tempfile
import unittest

import common
import score
import to_official

TG2 = os.environ.get("VCR_BOARDS_TG2")
PYTHON = os.environ.get("VCR_BOARDS_PYTHON")


def write_cohort(root, pools, patients):
    """A tiny cohort laid out like data/<cohort>: queries, qrels and (empty) trial files."""
    (root / "qrels").mkdir(parents=True)
    (root / "trials").mkdir()
    (root / "queries.jsonl").write_text("".join(json.dumps({"_id": pid, "text": "note"}) + "\n" for pid in patients))
    lines = ["query-id\tcorpus-id\tscore"]
    for pid, labels in pools.items():
        lines += [f"{pid}\t{trial}\t{label}" for trial, label in labels.items()]
        for trial in labels:
            (root / "trials" / f"{trial}.json").write_text("{}")
    (root / "qrels" / "test.tsv").write_text("\n".join(lines) + "\n")


@unittest.skipUnless(TG2 and PYTHON, "needs VCR_BOARDS_TG2 and VCR_BOARDS_PYTHON (the pinned clone and an interpreter with tqdm)")
class OfficialPathTests(unittest.TestCase):
    def official(self, root, results, *extra):
        script = common.check_evaluator(TG2, "rankings")
        stdout = score.run_official(PYTHON, script, ["--queries-jsonl", root / "queries.jsonl", "--qrels", root / "qrels" / "test.tsv",
                                                     "--results-dir", results, "--trial-dir", root / "trials", *extra], root)
        return score.parse_rankings_output(stdout)

    def convert(self, root, pids, record_for):
        cases = root / "cases.jsonl"
        cases.write_text("".join(json.dumps({"patientId": pid, "candidateIds": ids}) + "\n" for pid, ids in pids.items()))
        judgments = root / "judgments.jsonl"
        judgments.write_text("".join(json.dumps(record) + "\n" for record in record_for))
        to_official.convert(cases, judgments, root / "results")
        return root / "results"

    def test_hand_worked_mini_case(self):
        # pool labels A=2 B=0 C=1 D=2, ranked A B C D:
        # DCG = 2 + 0 + 1/2 + 2/log2(5) = 3.36135, ideal [2,2,1,0] = 2 + 2/log2(3) + 1/2 = 3.76186 -> nDCG 0.8935
        # graded P@10 = (1 + 0 + 0.5 + 1) / 10 = 0.25; MRR = 1; graded AP = (1*1 + 0.5*0.5 + 1*0.625) / 2.5 = 0.75
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pool = {"NCT00000001": 2, "NCT00000002": 0, "NCT00000003": 1, "NCT00000004": 2}
            write_cohort(root, {"p1": pool}, ["p1"])
            ranking = [{"registryId": f"NCT0000000{n}", "fit": 0, "rank": n} for n in (1, 2, 3, 4)]
            results = self.convert(root, {"p1": list(pool)}, [{"patientId": "p1", "status": "complete", "ranking": ranking, "failed": []}])
            patients, numbers = self.official(root, results, "--k", 10, "--max-rel", 2, "--mrr-relevance-threshold", 2, "--pad-to-pool")
            self.assertEqual(patients, 1)
            self.assertEqual(numbers, {"gNDCG": 0.8935, "gP": 0.25, "MRR": 1.0, "gAP": 0.75})
            official = score.load_official(common.check_evaluator(TG2, "rankings"))
            values = score.per_patient_metrics(official, root / "queries.jsonl", root / "qrels" / "test.tsv", results, root / "trials")["p1"]
            self.assertAlmostEqual(values["gNDCG"], 0.893535, places=6)
            self.assertAlmostEqual(values["gAP"], 0.75, places=9)

    def test_reversed_ranking_scores_lower_than_perfect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pool = {f"NCT{n:08d}": label for n, label in enumerate([2, 2, 1, 1] + [0] * 8, start=1)}  # twelve, so P@10 can differ
            write_cohort(root, {"p1": pool}, ["p1"])
            best = sorted(pool, key=lambda trial: (-pool[trial], trial))
            scores = {}
            for name, order in (("perfect", best), ("reversed", best[::-1])):
                ranking = [{"registryId": trial, "fit": 0, "rank": index + 1} for index, trial in enumerate(order)]
                results = self.convert(root, {"p1": list(pool)}, [{"patientId": "p1", "ranking": ranking, "failed": []}])
                scores[name] = self.official(root, results, "--pad-to-pool")[1]
            self.assertEqual(scores["perfect"]["gNDCG"], 1.0)
            self.assertTrue(all(scores["reversed"][key] < scores["perfect"][key] for key in scores["perfect"]))

    def test_the_official_script_drops_a_patient_with_no_result_file_but_the_converter_keeps_them(self):
        # Pinned surprise: a missing full_email file removes the patient from the means instead of scoring them zero.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pool = {"NCT00000001": 2, "NCT00000002": 0}
            write_cohort(root, {"p1": pool, "p2": pool}, ["p1", "p2"])
            ranking = [{"registryId": "NCT00000001", "fit": 0, "rank": 1}, {"registryId": "NCT00000002", "fit": 0, "rank": 2}]
            record = {"patientId": "p1", "ranking": ranking, "failed": []}
            cases = {"p1": list(pool), "p2": list(pool)}
            cases_path = root / "cases.jsonl"
            cases_path.write_text("".join(json.dumps({"patientId": pid, "candidateIds": ids}) + "\n" for pid, ids in cases.items()))
            (root / "judgments.jsonl").write_text(json.dumps(record) + "\n")
            skipped = root / "skipped"
            to_official.convert(cases_path, root / "judgments.jsonl", skipped, absent="skip")
            self.assertEqual(self.official(root, skipped, "--pad-to-pool")[0], 1)
            kept = root / "kept"
            to_official.convert(cases_path, root / "judgments.jsonl", kept)
            self.assertEqual(self.official(root, kept, "--pad-to-pool")[0], 2)

    def test_a_tampered_evaluator_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "scripts"
            fake.mkdir()
            (fake / "eval_trialgpt_rankings_qrels.py").write_text("print('x')\n")
            with self.assertRaises(ValueError):
                common.check_evaluator(directory, "rankings")


if __name__ == "__main__":
    unittest.main()
