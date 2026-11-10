"""The cell-by-cell scorer, on small tables whose right answers are known by construction."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_lib  # noqa: E402

GOLD = {"columns": ["Drug (n = 10)", "Placebo (n = 12)", "p"], "keys": ["Drug", "Placebo", "p"], "rows": [
    ["Age, years", "54.3 ± 10", "55.1 ± 9", "0.7"],
    ["SBP, mmHg", "130 ± 5", "131 ± 6", "0.5"],
    ["DBP, mmHg", "80 ± 4", "81 ± 4", "0.6"],
    ["Male", "5", "6", ""],
    ["Male", "7", "8", ""],
]}
HEADER = [["", "Drug (n = 10)", "Placebo (n = 12)", "p"]]


class Scorer(unittest.TestCase):
    def test_a_correct_grid_is_all_right_and_whitespace_marks_and_minus_signs_do_not_matter(self):
        grid = HEADER + [["Age, years", "54.3±10*", "55.1 ± 9", "0.7"], ["SBP, mmHg", "130 ± 5", "131 ± 6", "0.5"], ["DBP, mmHg", "80 ± 4", "81 ± 4", "0.6"],
                         ["Male", "5", "6", ""], ["Male", "7", "8", ""]]
        result = score_lib.score_table(GOLD, grid)
        self.assertTrue(all(c["strict"] for c in result["cells"]), [c for c in result["cells"] if not c["strict"]])
        self.assertEqual(score_lib.norm_value("−2.3 ± 1.6"), score_lib.norm_value("-2.3±1.6"))

    def test_sbp_is_not_dbp_and_repeated_labels_go_by_order(self):
        grid = HEADER + [["SBP, mmHg", "130 ± 5", "131 ± 6", "0.5"], ["Male", "5", "6", ""], ["Male", "7", "8", ""]]
        result = score_lib.score_table(GOLD, grid)
        by = {(c["variable"], c["column"], c["value"]): c for c in result["cells"]}
        self.assertTrue(by[("SBP, mmHg", "Drug", "130 ± 5")]["strict"])
        self.assertFalse(by[("DBP, mmHg", "Drug", "80 ± 4")]["rowFound"])
        self.assertTrue(by[("Male", "Drug", "7")]["strict"])
        self.assertTrue(by[("Male", "Placebo", "8")]["strict"])

    def test_values_in_the_wrong_columns_are_found_in_the_row_but_not_strictly_right(self):
        grid = [["", "Placebo (n = 12)", "Drug (n = 10)", "p"], ["Age, years", "54.3 ± 10", "55.1 ± 9", "0.7"]]
        cells = {c["column"]: c for c in score_lib.score_table(GOLD, grid)["cells"] if c["variable"] == "Age, years"}
        self.assertFalse(cells["Drug"]["strict"])
        self.assertTrue(cells["Drug"]["anywhere"])
        self.assertTrue(cells["Drug"]["order"])

    def test_a_lost_header_costs_the_strict_score_not_the_order_score(self):
        grid = [["Age, years", "54.3 ± 10", "55.1 ± 9", "0.7"]]
        cells = score_lib.score_table(GOLD, grid)["cells"]
        age = [c for c in cells if c["variable"] == "Age, years"]
        self.assertTrue(all(c["order"] for c in age))
        self.assertFalse(any(c["strict"] for c in age))

    def test_a_wrapped_label_matches_by_its_first_line(self):
        gold = {"columns": ["A", "B"], "keys": ["A", "B"], "rows": [["Previous treatment was effective (% of row above)", "88.9 (16)", "94.7 (18)"]]}
        grid = [["", "A", "B"], ["Previous treatment was effective (%", "88.9 (16)", "94.7 (18)"]]
        self.assertTrue(all(c["strict"] for c in score_lib.score_table(gold, grid)["cells"]))


if __name__ == "__main__":
    unittest.main()
