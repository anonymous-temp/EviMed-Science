import json
from pathlib import Path
import tempfile
import unittest

import to_official

IDS = [f"NCT0000000{n}" for n in range(1, 7)]  # the case lists them in this (shuffled) input order


def case(pid="p1", ids=IDS):
    return {"caseId": pid, "patientId": pid, "candidateIds": list(ids)}


def entry(trial, rank, fit=50, **extra):
    return {"registryId": trial, "fit": fit, "confidence": 0.5, "verdict": "possible", "rank": rank, **extra}


def order_of(payload):
    return [row["trial_id"] for row in payload["cover_page_list"]]


class ConvertSubjectTests(unittest.TestCase):
    def test_saved_rank_order_wins_over_scores_and_input_order(self):
        record = {"patientId": "p1", "status": "complete", "failed": [],
                  "ranking": [entry("NCT00000004", 1, fit=10), entry("NCT00000002", 2, fit=99), entry("NCT00000006", 3, fit=50)]}
        payload, counts = to_official.convert_subject(case(), record)
        self.assertEqual(order_of(payload)[:3], ["NCT00000004", "NCT00000002", "NCT00000006"])
        self.assertEqual((counts["judged"], counts["unjudged"], counts["candidates"]), (3, 3, 6))

    def test_unjudged_follow_every_judged_one_in_input_order_and_are_kept(self):
        record = {"patientId": "p1", "status": "partial", "ranking": [entry("NCT00000005", 1)],
                  "failed": [{"registryId": "NCT00000003", "code": "model_timeout"}, {"registryId": "nct00000002", "code": "model_timeout"},
                             {"registryId": "NCT00000001", "code": "gateway_502"}]}
        payload, counts = to_official.convert_subject(case(), record)
        self.assertEqual(order_of(payload), ["NCT00000005", "NCT00000001", "NCT00000002", "NCT00000003", "NCT00000004", "NCT00000006"])
        self.assertEqual(len(payload["cover_page_list"]), len(IDS))
        self.assertEqual(counts["failed"], {"gateway_502": 1, "model_timeout": 2})
        unjudged = {row["trial_id"]: row for row in payload["cover_page_list"] if not row["judged"]}
        self.assertEqual(unjudged["NCT00000003"]["failure_code"], "model_timeout")
        self.assertIsNone(unjudged["NCT00000004"]["failure_code"])

    def test_rows_carry_the_fields_the_official_loaders_read(self):
        payload, _ = to_official.convert_subject(case(), {"patientId": "p1", "ranking": [entry("NCT00000002", 1, fit=87)], "failed": []})
        row = payload["cover_page_list"][0]
        self.assertEqual((row["trial_id"], row["score"], row["confidence"]), ("NCT00000002", 87, 0.5))
        self.assertEqual((payload["patient_id"], payload["patient_ID"]), ("p1", "p1"))

    def test_foreign_and_repeated_trials_are_counted_not_ranked(self):
        record = {"patientId": "p1", "failed": [],
                  "ranking": [entry("NCT00000002", 1), entry("NCT99999999", 2), entry("NCT00000002", 3), entry("NCT00000004", 4)]}
        payload, counts = to_official.convert_subject(case(), record)
        self.assertEqual(order_of(payload)[:2], ["NCT00000002", "NCT00000004"])
        self.assertEqual((counts["foreignRanked"], counts["duplicateRanked"], counts["judged"]), (1, 1, 2))
        self.assertNotIn("NCT99999999", order_of(payload))

    def test_entries_without_a_rank_follow_ranked_ones_in_saved_order(self):
        record = {"patientId": "p1", "failed": [], "ranking": [entry("NCT00000003", None), entry("NCT00000006", 2), entry("NCT00000001", 1), entry("NCT00000002", None)]}
        payload, _ = to_official.convert_subject(case(), record)
        self.assertEqual(order_of(payload)[:4], ["NCT00000001", "NCT00000006", "NCT00000003", "NCT00000002"])

    def test_a_patient_with_no_record_lists_everything_unjudged_in_input_order(self):
        payload, counts = to_official.convert_subject(case(), None)
        self.assertEqual(order_of(payload), IDS)
        self.assertFalse(counts["hasRecord"])
        self.assertEqual(counts["judged"], 0)
        skipped, _ = to_official.convert_subject(case(), None, absent="skip")
        self.assertIsNone(skipped)

    def test_the_converter_has_no_way_to_receive_a_label(self):
        # Every input is the case file and the saved record; there is no parameter that could carry a gold label.
        import inspect
        self.assertEqual(list(inspect.signature(to_official.convert_subject).parameters), ["case", "record", "absent"])


class ConvertTests(unittest.TestCase):
    def test_files_totals_and_idempotence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = [case("p1"), case("p2"), case("p3")]
            (root / "cases.jsonl").write_text("".join(json.dumps(c) + "\n" for c in cases))
            records = [
                {"patientId": "p1", "status": "complete", "failed": [], "usage": {"inputTokens": 100, "outputTokens": 10, "costCny": 0.5},
                 "ranking": [entry(t, n + 1) for n, t in enumerate(IDS)]},
                {"patientId": "p2", "status": "failed", "ranking": [entry("NCT00000003", 1)], "failed": [{"registryId": "NCT00000001", "code": "x"}]},
                {"patientId": "ghost", "status": "complete", "ranking": [], "failed": []},
                {"patientId": "p2", "status": "partial", "ranking": [entry("NCT00000003", 1)], "failed": [{"registryId": "NCT00000001", "code": "x"}]},
            ]
            (root / "judgments.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
            for _ in range(2):  # a second run replaces, never duplicates
                totals = to_official.convert(root / "cases.jsonl", root / "judgments.jsonl", root / "official")
            self.assertEqual(sorted(p.name for p in (root / "official").iterdir()), ["full_email_p1.json", "full_email_p2.json", "full_email_p3.json"])
            self.assertEqual((totals["patients"], totals["patientsWithRecord"], totals["patientsFinished"]), (3, 2, 1))
            self.assertEqual((totals["pairs"], totals["pairsJudged"], totals["pairsUnjudged"]), (18, 7, 11))
            self.assertEqual(totals["pairsFailedByCode"], {"x": 1})
            self.assertEqual((totals["duplicateRecords"], totals["recordsForUnknownPatients"], totals["patientsBelowK"]), (1, 1, 3))  # all three judged fewer than ten pairs
            self.assertEqual(totals["statusCounts"], {"complete": 1, "partial": 1, "(no record)": 1})
            self.assertEqual(totals["usage"], {"inputTokens": 100, "outputTokens": 10, "costCny": 0.5, "patientsReporting": 1})
            third = json.loads((root / "official" / "full_email_p3.json").read_text())
            self.assertEqual([row["trial_id"] for row in third["cover_page_list"]], IDS)

    def test_skipping_absent_patients_writes_no_file_for_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cases.jsonl").write_text(json.dumps(case("p1")) + "\n")
            (root / "judgments.jsonl").write_text("")
            totals = to_official.convert(root / "cases.jsonl", root / "judgments.jsonl", root / "official", absent="skip")
            self.assertEqual(list((root / "official").iterdir()), [])
            self.assertEqual(totals["patients"], 1)
            self.assertEqual(totals["patientsWithRecord"], 0)

    def test_an_unsafe_patient_id_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cases.jsonl").write_text(json.dumps(case("../x")) + "\n")
            with self.assertRaises(ValueError):
                to_official.convert(root / "cases.jsonl", None, root / "official")


if __name__ == "__main__":
    unittest.main()
