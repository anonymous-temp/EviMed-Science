import json
from pathlib import Path
import random
import sqlite3
import tempfile
import unittest
from unittest import mock
import zlib

import common
import prepare

HERE = Path(__file__).resolve().parent
FROZEN_SPLIT_SHA256 = "69fa5991bdd53297b20d63eab5c8339636ec7f47d16ed5a2bf3a5001e095ade0"


def spearman(xs, ys):
    def ranks(values):
        order = sorted(range(len(values)), key=values.__getitem__)
        out = [0.0] * len(values)
        for rank, index in enumerate(order):
            out[index] = rank
        return out
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    return cov / (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5


class ShuffleTests(unittest.TestCase):
    def test_order_is_a_pure_function_of_ids_and_seed(self):
        trials = [f"NCT{n:08d}" for n in range(1, 40)]
        first = common.candidate_order("p1", trials)
        self.assertEqual(sorted(first), sorted(trials))
        self.assertEqual(first, common.candidate_order("p1", list(reversed(trials))))
        self.assertNotEqual(first, common.candidate_order("p2", trials))
        self.assertNotEqual(first, common.candidate_order("p1", trials, seed="another"))

    def test_position_carries_no_label(self):
        correlations = []
        for patient in range(60):
            trials = [f"NCT{n:08d}" for n in range(1, 80)]
            rng = random.Random(patient)
            labels = {trial: rng.choice([0, 0, 1, 2]) for trial in trials}
            order = common.candidate_order(f"sigir-{patient}", trials)
            correlations.append(spearman([order.index(t) for t in trials], [labels[t] for t in trials]))
        self.assertLess(abs(sum(correlations) / len(correlations)), 0.05)

    def test_cases_carry_ids_note_and_split_only(self):
        data = {"order": ["p1"], "cases": {"p1": {"patient_summary": "note", "candidate_trial_ids": ["NCT00000002", "NCT00000001"]}}}
        with mock.patch.dict(prepare.COLLECTIONS, {"x": "tg2-x"}):
            (case,) = prepare.ranking_cases("x", data, {"dev": {"x": ["p1"]}, "test": {}})
        self.assertEqual(set(case), {"caseId", "patientId", "cohort", "collection", "split", "note", "candidateIds", "candidateCount"})
        self.assertEqual((case["split"], case["candidateCount"]), ("dev", 2))

    def test_a_patient_with_no_candidates_is_not_a_case(self):
        data = {"order": ["p1"], "cases": {"p1": {"patient_summary": "note", "candidate_trial_ids": []}}}
        with mock.patch.dict(prepare.COLLECTIONS, {"x": "tg2-x"}):
            self.assertEqual(prepare.ranking_cases("x", data, {"dev": {}, "test": {}}), [])


class SplitTests(unittest.TestCase):
    def ids(self, prefix, count):
        return [f"{prefix}{n}" for n in range(1, count + 1)]

    def test_dev_is_first_ten_in_query_order_and_the_rest_is_test(self):
        order = {"sigir": self.ids("sigir-2014", 6), "trec_2021": self.ids("trec-2021", 25), "trec_2022": self.ids("trec-2022", 12)}
        split = prepare.build_split(order, {"sigir": {"sigir-20146"}, "trec_2021": set(), "trec_2022": set()},
                                    ["nci-01", "nci-02"], ["sigir-20141", "sigir-20142"])
        self.assertEqual(split["dev"]["trec_2021"], order["trec_2021"][:10])
        self.assertEqual(split["test"]["trec_2021"], order["trec_2021"][10:])
        self.assertEqual(split["dev"]["trec_2022"], order["trec_2022"][:10])
        self.assertEqual(len(split["test"]["trec_2023"]), 40)
        self.assertNotIn("sigir-20146", split["dev"]["sigir"])
        self.assertEqual(split["unscorable"], {"sigir": ["sigir-20146"]})
        self.assertEqual(split["test"]["nih_trialbench"], ["nci-01", "nci-02"])
        self.assertEqual(split["dev"]["criterion"], ["sigir-20141", "sigir-20142"])

    def test_the_committed_split_is_frozen(self):
        raw = (HERE / "split.json").read_bytes()
        self.assertEqual(common.sha256_bytes(raw), FROZEN_SPLIT_SHA256, "split.json changed: a new freeze is a deliberate, reviewed act")
        split = json.loads(raw)
        sizes = {key: len(value) for key, value in split["dev"].items()}
        self.assertEqual(sizes, {"criterion": 53, "sigir": 58, "trec_2021": 10, "trec_2022": 10})
        self.assertEqual({key: len(value) for key, value in split["test"].items()},
                         {"nih_trialbench": 126, "trec_2021": 65, "trec_2022": 40, "trec_2023": 40})
        for cohort in ("trec_2021", "trec_2022"):
            self.assertFalse(set(split["dev"][cohort]) & set(split["test"][cohort]))
        self.assertEqual(split["dev"]["trec_2021"][:3], ["trec-20211", "trec-20212", "trec-20213"])  # query order, not lexicographic
        self.assertEqual(split["dev"]["trec_2021"][9], "trec-202110")
        self.assertEqual(split["test"]["trec_2023"][0], "trec-2023-1")

    def test_freezing_is_explicit_and_never_overwrites(self):
        split = {"version": 1, "dev": {}, "test": {}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "split.json"
            with self.assertRaises(FileNotFoundError):
                prepare.settle_split(split, path, freeze=False)
            self.assertTrue(prepare.settle_split(split, path, freeze=True))
            common.write_json(path, split)
            self.assertFalse(prepare.settle_split(split, path, freeze=True))
            with self.assertRaises(ValueError):
                prepare.settle_split({**split, "dev": {"sigir": ["x"]}}, path, freeze=True)


class PoolTests(unittest.TestCase):
    def cohort(self, candidates, summary="note"):
        return {"cases": {"p1": {"patient_summary": summary, "candidate_trial_ids": candidates, "candidate_trial_count": len(candidates)}},
                "queries": [{"_id": "p1", "text": summary}], "order": ["p1"]}

    def test_candidates_must_equal_the_qrels_pool(self):
        expected = {"cases": 1, "evaluable": 1, "pairs": 2}
        ok = prepare.check_ranking_cohort("x", self.cohort(["NCT00000001", "NCT00000002"]),
                                          {"p1": {"NCT00000001": 0, "NCT00000002": 2}}, {"NCT00000001", "NCT00000002"}, expected)
        self.assertEqual(ok, expected)
        with self.assertRaises(ValueError):
            prepare.check_ranking_cohort("x", self.cohort(["NCT00000001", "NCT00000002"]),
                                         {"p1": {"NCT00000001": 0, "NCT00000003": 2}}, {"NCT00000001", "NCT00000002"}, expected)
        with self.assertRaises(ValueError):  # a pair count that differs from the paper's
            prepare.check_ranking_cohort("x", self.cohort(["NCT00000001"]), {"p1": {"NCT00000001": 0}}, {"NCT00000001"}, expected)
        with self.assertRaises(ValueError):  # a candidate with no trial file
            prepare.check_ranking_cohort("x", self.cohort(["NCT00000001", "NCT00000002"]),
                                         {"p1": {"NCT00000001": 0, "NCT00000002": 2}}, {"NCT00000001"}, expected)


class CriterionBoardTests(unittest.TestCase):
    def rows(self):
        base = {"note": "0. a.\n1. b.", "trial_title": "T", "gpt4_explanation": "x", "explanation_correctness": "Correct",
                "gpt4_sentences": "[0]", "expert_sentences": "[]", "gpt4_eligibility": "included",
                "expert_eligibility": "not enough information", "training": True}
        spec = [(0, "inclusion", "first"), (1, "inclusion", "second"), (2, "exclusion", None), (3, "exclusion", "fourth")]
        return [{**base, "annotation_id": index, "patient_id": "sigir-20141", "trial_id": "NCT00000001",
                 "criterion_type": kind, "criterion_text": text} for index, kind, text in spec]

    def test_clauses_are_numbered_per_kind_and_keyed_by_annotation(self):
        cases, seven, labels = prepare.criterion_board(self.rows(), {"rows": 4, "patients": 1, "pairs": 1})
        (case,) = cases
        clauses = case["trials"][0]["clauses"]
        self.assertEqual([(c["kind"], c["number"], c["annotationId"]) for c in clauses],
                         [("inclusion", 0, 0), ("inclusion", 1, 1), ("exclusion", 0, 2), ("exclusion", 1, 3)])
        self.assertEqual(case["sentenceCount"], 2)
        self.assertEqual(seven[2]["criterion_text"], None)  # the null stays null in the seven-field row
        self.assertTrue(clauses[2]["textNull"] and clauses[2]["text"] is None)
        self.assertEqual({row["annotationId"]: (row["kind"], row["number"]) for row in labels}[3], ("exclusion", 1))

    def test_inputs_carry_the_seven_fields_and_no_label(self):
        cases, seven, labels = prepare.criterion_board(self.rows(), {"rows": 4, "patients": 1, "pairs": 1})
        self.assertEqual(set(seven[0]), set(prepare.SEVEN_FIELDS))
        blob = json.dumps([cases, seven])
        for forbidden in ("expert", "gpt4", "eligibility", "training", "not enough information"):
            self.assertNotIn(forbidden, blob.replace("criterion_text", ""))
        self.assertIn("expert", json.dumps(labels))

    def test_refuses_the_wrong_number_of_rows(self):
        with self.assertRaises(ValueError):
            prepare.criterion_board(self.rows())


class CollectionTests(unittest.TestCase):
    def trial(self, nct, **over):
        trial = {"nctid": nct, "title": f"Title {nct}", "brief_summary": "summary text", "raw_criteria": "Inclusion Criteria:\n- adults\nExclusion Criteria:\n- pregnancy",
                 "study_type": "INTERVENTIONAL", "phases": ["PHASE2", "PHASE3"], "condition": ["Asthma", "COPD"],
                 "minimum_age": "18 Years", "maximum_age": "", "sex": "ALL", "overall_status": "COMPLETED"}
        return {**trial, **over}

    def test_index_matches_the_platform_reader_format(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trials = root / "trials"
            trials.mkdir()
            for nct in ("NCT00000002", "NCT00000001"):
                (trials / f"{nct}.json").write_text(json.dumps(self.trial(nct)))
            (trials / "NCT00000003.json").write_text(json.dumps(self.trial("NCT00000003", raw_criteria="")))
            ids, info = prepare.build_collection(trials, root / "collection", "sigir")
            self.assertEqual((ids, info), ({"NCT00000001", "NCT00000002", "NCT00000003"}, {"records": 3, "emptyEligibility": 1}))
            manifest = common.read_json(root / "collection" / "collection.json")
            self.assertEqual((manifest["version"], manifest["sourceFormat"], manifest["id"]), (1, "trialgpt-json", "tg2-sigir"))
            database = root / "collection" / manifest["databasePath"]
            self.assertEqual(manifest["databaseSha256"], common.sha256_file(database))
            db = sqlite3.connect(database)
            try:
                row = db.execute("SELECT nct_id,xml_sha256,payload_sha256,payload FROM documents WHERE nct_id='NCT00000001'").fetchone()
                payload = json.loads(zlib.decompress(row[3]))
                self.assertEqual(common.sha256_bytes(zlib.decompress(row[3])), row[2])
                self.assertEqual(payload["source_sha256"], row[1])
                self.assertEqual((payload["title"], payload["summary"], payload["phase"], payload["condition"], payload["gender"]),
                                 ("Title NCT00000001", "summary text", "PHASE2/PHASE3", "Asthma\nCOPD", "ALL"))
                self.assertEqual(payload["eligibility"], self.trial("x")["raw_criteria"])
                hits = db.execute("SELECT d.nct_id FROM terms JOIN documents d ON d.id=terms.rowid WHERE terms MATCH '\"asthma\"' ORDER BY d.nct_id").fetchall()
                self.assertEqual([hit[0] for hit in hits], ["NCT00000001", "NCT00000002", "NCT00000003"])
            finally:
                db.close()

    def test_a_file_missing_a_field_or_named_wrongly_is_refused(self):
        raw = json.dumps(self.trial("NCT00000001")).encode()
        with self.assertRaises(ValueError):
            prepare.trial_payload(raw, "NCT00000009.json", "a")
        broken = json.loads(raw)
        del broken["raw_criteria"]
        with self.assertRaises(ValueError):
            prepare.trial_payload(json.dumps(broken).encode(), "NCT00000001.json", "a")


class NihTests(unittest.TestCase):
    def test_target_must_be_in_the_candidate_list_and_nothing_leaks(self):
        case = {"patient_id": "nci-01", "ic": "NCI", "patient_summary": "note", "target_trial_id": "NCT00000001",
                "target_study_type": "INTERVENTIONAL", "candidate_trial_ids": ["NCT00000001", "NCT00000002"]}
        data = {"order": ["nci-01"], "cases": {"nci-01": case}}
        with self.assertRaises(ValueError):  # a valid list, but the counts differ from the published ones
            prepare.nih_cases(data, {"NCT00000001", "NCT00000002"})
        data["cases"]["nci-01"] = {**case, "candidate_trial_ids": ["NCT00000002"]}
        with self.assertRaises(ValueError):  # the target is missing from its own candidate list
            prepare.nih_cases(data, {"NCT00000002"})


if __name__ == "__main__":
    unittest.main()
