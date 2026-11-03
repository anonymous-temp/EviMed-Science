import json
import unittest

from support import PACKAGE  # noqa: F401

from evimed_h2 import guard
from evimed_h2.errors import ContaminationRefused

PROMPTS = [
    "A 62-year-old man with alcoholic cirrhosis visited the outpatient clinic for unexplained weight loss and a mass in the caudate lobe of the liver.",
    "What is the odds ratio of higher severity associated with vaccination in the adverse event table of the trial named TASK008?",
]
REQUEST = {"rid": "h2.a.b", "image": "base", "item": {"key": "k/1#x", "prompt": "p", "files": [{"src": "/bench/data/x/a.csv", "dest": "inputs/a.csv"}],
                                                        "groupSkill": None}, "probe": {"preamble": None, "line": None}}


class RequestGuard(unittest.TestCase):
    def test_a_clean_request_passes(self):
        guard.assert_request_clean(REQUEST)

    def test_keys_that_could_carry_a_grade_are_refused_anywhere(self):
        for path, value in (("item.gold", "x"), ("item.expectInAnswer", "x"), ("probe.score", 1), ("item.meta", {"rubric": "r"}), ("extra", 1)):
            request = json.loads(json.dumps(REQUEST))
            target = request
            keys = path.split(".")
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            with self.assertRaises(ContaminationRefused, msg=path):
                guard.assert_request_clean(request)

    def test_paths_that_hold_grading_material_are_refused(self):
        request = json.loads(json.dumps(REQUEST))
        request["item"]["files"] = [{"src": "/bench/data/rcb_judge/Life_000/checklist.json", "dest": "inputs/x"}]
        with self.assertRaises(ContaminationRefused):
            guard.assert_request_clean(request)

    def test_grader_output_markers_are_refused_in_any_string(self):
        request = json.loads(json.dumps(REQUEST))
        request["probe"]["preamble"] = 'result {"pass_rate": 0.5}'
        with self.assertRaises(ContaminationRefused):
            guard.assert_request_clean(request)

    def test_agrees_with_the_labs_own_validation(self):
        try:
            from lab import broker  # noqa: F401
        except ImportError:
            import sys
            sys.path.insert(0, str(PACKAGE / "lab"))
            import broker
        for bad in ({"gold": 1}, {"scoring": 1}, {"Answer": "x"}, {"nested": {"ground_truth": 1}}):
            request = json.loads(json.dumps(REQUEST))
            request["item"].update(bad)
            with self.assertRaises(ValueError):
                broker.validate_request(request)
            with self.assertRaises(ContaminationRefused):
                guard.assert_request_clean(request)
        broker.validate_request(REQUEST)


class TreeGuard(unittest.TestCase):
    def setUp(self):
        self.guard = guard.TreeGuard(PROMPTS, ["TASK008", "BCG-CORONA_AE.csv"], max_numerals=5)

    def test_process_text_passes(self):
        text = "Recompute the value in code before answering.\n1. Read the request.\n2. Check units.\nStop after 3 failed tries and say so.\n"
        self.assertEqual(self.guard.problems({"guidance.md": text}), [])

    def test_a_long_verbatim_stretch_of_a_prompt_is_refused_whatever_the_case_or_spacing(self):
        stretch = PROMPTS[0][10:110].upper().replace(" ", "  ")
        found = self.guard.problems({"guidance.md": f"Beware of cases like: {stretch}."})
        self.assertEqual(len(found), 1)
        self.assertIn("task's own wording", found[0])

    def test_a_short_phrase_is_fine(self):
        self.assertEqual(self.guard.problems({"guidance.md": "Look at the outpatient clinic note for weight loss and then decide."}), [])

    def test_numerals_over_the_allowance_are_refused_list_markers_do_not_count(self):
        many = "Use 3.5 and 12 and 7 and 100 and 2024 and 9.\n"
        self.assertIn("numerals", " ".join(self.guard.problems({"guidance.md": many})))
        listed = "\n".join(f"{i}. step" for i in range(1, 30))
        self.assertEqual(self.guard.problems({"guidance.md": listed}), [])

    def test_names_of_data_and_identifiers_are_refused(self):
        found = " ".join(self.guard.problems({"guidance.md": "Open TASK008 first; see NCT01234567, arXiv 2112.07917 and bix-17 and Chemistry_000 and MedCalc-Bench."}))
        for expected in ("TASK008", "a trial id", "an arXiv id", "a task id", "MedCalc-Bench"):
            self.assertIn(expected, found)

    def test_check_raises_one_actionable_message(self):
        with self.assertRaises(ValueError) as caught:
            self.guard.check({"guidance.md": "see TASK008", "skills/a/SKILL.md": "Remember: " + PROMPTS[1][:90]})
        self.assertIn(" | ", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
