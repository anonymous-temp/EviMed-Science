"""Tests for score_e.py (board E): a hand-worked fixture, the trec_eval agreement when a binary is given, and the file shapes."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_e  # noqa: E402

TREC_EVAL = os.environ.get("VCR_BOARDS_TREC_EVAL")

# One topic. Grades: eligible A, B, E (2), excluded C, F (1), not relevant D (0). Hand-worked below.
QRELS = {"NCT00000001": 2, "NCT00000002": 2, "NCT00000003": 1, "NCT00000004": 0, "NCT00000005": 2, "NCT00000006": 1}
A, B, C, D, E, F = (f"NCT0000000{n}" for n in range(1, 7))
X, Y, Z, W, V = (f"NCT0000009{n}" for n in range(1, 6))  # not judged
ORDER = [A, X, C, B, D, Y, Z, E, W, V, F]


def pad(order, position, ident):
    """`order` with fillers up to `position`, then `ident` (so an id can sit at rank 120)."""
    fillers = [f"NCT{80000000 + len(order) + n}" for n in range(position - len(order) - 1)]
    return order + fillers + [ident]


class HandWorked(unittest.TestCase):
    def test_ndcg_by_hand(self):
        # DCG@10: A at rank 1 gives 2/log2(2) = 2; C at rank 3 gives 1/log2(4) = 0.5; B at rank 4 gives 2/log2(5) = 0.8613531;
        # E at rank 8 gives 2/log2(9) = 0.6309298; the rest are 0. F is at rank 11 and is cut. DCG = 3.9922829.
        # Ideal: grades 2,2,2,1,1,0 -> 2 + 2/log2(3) + 2/log2(4) + 1/log2(5) + 1/log2(6) = 2 + 1.2618595 + 1 + 0.4306766 + 0.3868528 = 5.0793889.
        got = score_e.metrics(ORDER, QRELS)
        self.assertAlmostEqual(got["ndcg10"], 3.9922829 / 5.0793889, places=6)
        self.assertAlmostEqual(got["ndcg10"], 0.78596, places=4)

    def test_precision_judged_and_recall_by_hand(self):
        got = score_e.metrics(ORDER, QRELS)
        self.assertEqual(got["p10"], 0.3)  # A, B and E are eligible among the first ten
        self.assertEqual(got["j10"], 0.5)  # A, C, B, D, E are judged among the first ten; X, Y, Z, W, V are not
        self.assertEqual(got["recall100"], 1.0)  # all three eligible ids are listed
        self.assertEqual(got["graded100"], 1.0)  # F (11th) is inside 100: 2+1+2+0+2+1 = 8 of 8
        # A list shorter than ten counts its missing places as not eligible and not judged.
        short = score_e.metrics([A, B], QRELS)
        self.assertEqual((short["p10"], short["j10"]), (0.2, 0.2))

    def test_recall_cut_points(self):
        # E sits at rank 120 and F at rank 600: recall@100 misses E, recall@500 still misses F (F is excluded, not eligible).
        order = pad(pad([A, C, B], 120, E), 600, F)
        got = score_e.metrics(order, QRELS)
        self.assertAlmostEqual(got["recall100"], 2 / 3)
        self.assertEqual(got["recall500"], 1.0)  # E at 120 is inside 500
        self.assertAlmostEqual(got["graded100"], (2 + 1 + 2) / 8)  # A, C, B
        self.assertAlmostEqual(got["graded500"], (2 + 1 + 2 + 2) / 8)  # plus E; F at 600 is outside

    def test_unjudged_ids_have_zero_gain_and_an_empty_topic_has_no_recall(self):
        self.assertEqual(score_e.metrics([X, Y], QRELS)["ndcg10"], 0.0)
        nothing = score_e.metrics([A], {"NCT00000001": 0})
        self.assertIsNone(nothing["ndcg10"])
        self.assertIsNone(nothing["recall100"])
        self.assertIsNone(nothing["graded100"])

    def test_a_list_with_unjudged_ids_is_also_read_without_them(self):
        unjudged = "NCT99999999"
        got = score_e.metrics([unjudged, A, B], QRELS)
        without = score_e.metrics([A, B], QRELS)
        self.assertLess(got["ndcg10"], without["ndcg10"])
        self.assertAlmostEqual(got["ndcg10Judged"], without["ndcg10"])
        self.assertAlmostEqual(got["p10Judged"], without["p10"])

    def test_a_repeated_id_is_refused(self):
        with self.assertRaises(ValueError):
            score_e.metrics([A, A], QRELS)

    def test_perfect_and_reversed_order(self):
        ideal = sorted(QRELS, key=lambda ident: -QRELS[ident])
        self.assertAlmostEqual(score_e.metrics(ideal, QRELS)["ndcg10"], 1.0)
        self.assertLess(score_e.metrics(list(reversed(ideal)), QRELS)["ndcg10"], 0.8)


class Shapes(unittest.TestCase):
    def test_topic_keys(self):
        self.assertEqual(score_e.topic_key("trec-20211"), (2021, 1))
        self.assertEqual(score_e.topic_key("trec-202210"), (2022, 10))
        self.assertEqual(score_e.topic_key("trec-2023-5"), (2023, 5))
        with self.assertRaises(ValueError):
            score_e.topic_key("sigir-20141")

    def test_qrels_hash_and_shape(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "qrels2021.txt"
            path.write_text("1 0 NCT00000001 2\n1 0 NCT00000002 0\n2 0 NCT00000001 1\n")
            with self.assertRaises(ValueError):
                score_e.read_qrels(path, 2021)  # not the pinned file
            got = score_e.read_qrels(path, 2021, check_hash=False)
            self.assertEqual(got, {1: {"NCT00000001": 2, "NCT00000002": 0}, 2: {"NCT00000001": 1}})
            path.write_text("1 0 NCT00000001 2\n1 0 NCT00000001 1\n")
            with self.assertRaises(ValueError):
                score_e.read_qrels(path, None)  # a repeated pair

    def test_bootstrap_is_deterministic_and_skips_none(self):
        first = score_e.bootstrap([0.2, 0.4, None, 0.6], 500, 7)
        again = score_e.bootstrap([0.2, 0.4, None, 0.6], 500, 7)
        self.assertEqual(first, again)
        self.assertEqual(first["n"], 3)
        self.assertAlmostEqual(first["mean"], 0.4)
        self.assertLessEqual(first["low"], first["mean"] <= first["high"] and first["mean"])

    def test_all_year_is_the_mean_of_year_means(self):
        rows = [{"year": 2021, "ndcg10": 0.2}, {"year": 2021, "ndcg10": 0.4}, {"year": 2022, "ndcg10": 0.9}]
        got = score_e.summarise(rows, ["ndcg10"], 50, 1)
        self.assertAlmostEqual(got["meanOfYearMeans"]["ndcg10"], (0.3 + 0.9) / 2)
        self.assertAlmostEqual(got["pooled"]["ndcg10"]["mean"], 0.5)


class Files(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.dir = Path(self.scratch.name)
        # Pretend qrels for 2021 topic 1 (the pinned hash is bypassed by writing the file and patching the table for this test).
        (self.dir / "qrels2021.txt").write_text("".join(f"1 0 {ident} {grade}\n" for ident, grade in QRELS.items()))
        self.saved = dict(score_e.QRELS_SHA)
        score_e.QRELS_SHA.clear()

    def tearDown(self):
        score_e.QRELS_SHA.update(self.saved)
        self.scratch.cleanup()

    def run_cli(self, *argv):
        code = score_e.main([*argv])
        self.assertEqual(code, 0)

    def test_retrieval_command_writes_both_arms(self):
        better = {"topic": "trec-20211", "retrieved": [A, B, E, C, F, D]}
        worse = {"topic": "trec-20211", "retrieved": [X, Y, A, B, E, C]}
        (self.dir / "a.jsonl").write_text(json.dumps(better) + "\n")
        (self.dir / "b.jsonl").write_text(json.dumps(worse) + "\n")
        out = self.dir / "out"
        self.run_cli("retrieval", "--qrels-dir", str(self.dir), "--run", f"no-rerank={self.dir / 'b.jsonl'}", f"rerank={self.dir / 'a.jsonl'}",
                     "--out", str(out), "--years", "2021", "--resamples", "50")
        report = json.loads((out / "board-e-retrieval.json").read_text())
        arms = report["arms"]
        self.assertGreater(arms["rerank"]["summary"]["byYear"]["2021"]["ndcg10"]["mean"], arms["no-rerank"]["summary"]["byYear"]["2021"]["ndcg10"]["mean"])
        self.assertEqual(arms["rerank"]["rows"][0]["recall100"], 1.0)

    def test_end2end_command_reads_saved_rank_order(self):
        record = {"patientId": "trec-20211", "status": "complete", "failed": [],
                  "ranking": [{"registryId": ident, "fit": 90 - i, "rank": i + 1} for i, ident in enumerate([A, B, E, C, X])]}
        (self.dir / "j.jsonl").write_text(json.dumps(record) + "\n")
        retrieved = {"topic": "trec-20211", "retrieved": [X, C, A, B, E, D]}
        (self.dir / "r.jsonl").write_text(json.dumps(retrieved) + "\n")
        out = self.dir / "out"
        self.run_cli("end2end", "--qrels-dir", str(self.dir), "--judgments", f"2021={self.dir / 'j.jsonl'}", "--retrieved", str(self.dir / "r.jsonl"),
                     "--out", str(out), "--resamples", "50")
        report = json.loads((out / "board-e-end2end.json").read_text())
        row = report["rows"][0]
        self.assertEqual(row["p10"], 0.3)
        self.assertEqual(row["j10"], 0.4)  # A, B, E, C are judged; X is not
        self.assertGreater(row["ndcg10"], row["retrievalOrderNdcg10"])
        self.assertTrue(row["allJudged"])
        self.assertEqual(report["complete"], {"2021": 1})


@unittest.skipUnless(TREC_EVAL and Path(TREC_EVAL).exists(), "VCR_BOARDS_TREC_EVAL names a built trec_eval")
class AgainstTrecEval(unittest.TestCase):
    def test_same_numbers_as_trec_eval(self):
        qrels = {2021: {1: QRELS, 2: {A: 1, B: 0, C: 2}}}
        orders = {(2021, 1): ORDER, (2021, 2): [C, A, B, X]}
        theirs = score_e.trec_eval_check(TREC_EVAL, qrels, orders)
        for (year, number), order in orders.items():
            mine = score_e.metrics(order, qrels[year][number])
            self.assertAlmostEqual(theirs[(year, number, "ndcg_cut_10")], mine["ndcg10"], places=4)
            self.assertAlmostEqual(theirs[(year, number, "P_10")], mine["p10"], places=4)


if __name__ == "__main__":
    unittest.main()
