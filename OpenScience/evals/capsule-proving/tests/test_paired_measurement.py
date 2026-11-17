"""Case-local IDs and unobserved rows must survive paired comparisons."""
import importlib.util
from pathlib import Path
import unittest
SPEC = importlib.util.spec_from_file_location("score_rows", Path(__file__).parents[1] / "results/score_rows.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class Tests(unittest.TestCase):
    def test_repeated_ids_and_unknown_are_not_wrong_answers(self):
        rows = [{"caseId": "A", "kind": "answer", "id": "q", "verdict": "pass"},
                {"caseId": "B", "kind": "answer", "id": "q", "verdict": "fail"},
                {"caseId": "C", "kind": "answer", "id": "q", "verdict": "unobserved"}]
        out = MODULE.index_rows(rows)
        self.assertEqual(len(out), 3)
        self.assertEqual(list(out.values()), [True, False, None])
        with self.assertRaisesRegex(ValueError, "duplicate_score_identity"):
            MODULE.index_rows(rows + rows[:1])
    def test_checkpoints_do_not_collide(self):
        rows = [{"caseId": "A", "kind": "answer", "id": "q", "checkpoint": i, "verdict": "pass"} for i in [1, 2]]
        self.assertEqual(len(MODULE.index_rows(rows)), 2)
if __name__ == "__main__": unittest.main()
