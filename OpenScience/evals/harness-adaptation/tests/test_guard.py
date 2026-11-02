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


class Names(unittest.TestCase):
    """What counts as the name of a data set: decided from shape and from the domain's own task texts, never from a list of words.
    Round 1 took the stems `count` and `rules` of data files for data set names and refused three tasks' harnesses for saying
    "count the rows" and "apply the rules"."""

    DOMAIN_PROMPTS = [
        "Using the attached gene table, count the reads per sample and report the fold change of the treated group.",
        "Apply the rules in the protocol to decide which samples to drop, then count what remains.",
        "Follow the rules for normalisation, and count how many genes pass the filter.",
        "The rules of the assay say to repeat any well that fails the control.",
        "Open gapminder.csv and compare the life expectancy of two continents.",
        "Summarise the BCG-CORONA_AE.csv adverse event table by arm.",
    ]
    CANDIDATES = ["count", "rules", "gapminder", "BCG-CORONA_AE.csv", "BCG-CORONA_AE", "count.csv"]

    def guard(self):
        return guard.TreeGuard(self.DOMAIN_PROMPTS, self.CANDIDATES, max_numerals=5)

    def test_an_ordinary_word_is_not_a_name_even_when_it_is_a_file_stem(self):
        g = self.guard()
        self.assertNotIn("count", g.names)
        self.assertNotIn("rules", g.names)
        self.assertEqual(sorted(g.vocabulary), ["count", "rules"], "what was kept out is listed, with the reason being the domain's own use of it")
        text = "Count the rows first, then apply the rules of the task; recount after any discount or account change.\n"
        self.assertEqual(g.problems({"guidance.md": text}), [])

    def test_a_distinctive_name_is_still_refused_by_shape_or_rarity(self):
        g = self.guard()
        for text, expected in (("Open BCG-CORONA_AE.csv first.", "BCG-CORONA_AE.csv"), ("load bcg corona ae and tabulate", "BCG-CORONA_AE"),
                               ("the gapminder table has the continents", "gapminder"), ("see count.csv in the workspace", "count.csv")):
            found = " ".join(g.problems({"guidance.md": text}))
            self.assertIn(expected, found, text)

    def test_a_rare_plain_word_is_matched_as_a_whole_word_only(self):
        g = self.guard()
        self.assertIn("gapminder", " ".join(g.problems({"guidance.md": "Gapminder, then the plot."})))
        self.assertEqual(g.problems({"guidance.md": "A gapminderish habit is not a data set."}), [], "a longer word is another word")

    def test_shape_needs_no_domain_text(self):
        for name in ("TASK008", "GSE12345", "BCG-CORONA_AE.csv", "MedCalc", "a_b.csv", "uuid-like-0f3a"):
            self.assertTrue(guard.has_name_shape(name), name)
        for word in ("count", "rules", "Count", "metadata", "expression", "数据", "心血管疾病数据"):
            self.assertFalse(guard.has_name_shape(word), word)

    def test_a_word_every_task_uses_is_vocabulary_whatever_its_length(self):
        prompts = [f"Read the cohort table number {i} and summarise the baseline characteristics." for i in range(10)]
        g = guard.TreeGuard(prompts, ["baseline", "cohort", "Heart-Study"], max_numerals=5)
        self.assertEqual(g.problems({"guidance.md": "Check the baseline and the cohort."}), [])
        self.assertIn("Heart-Study", " ".join(g.problems({"guidance.md": "see the heart study"})))

    def test_a_word_the_platforms_own_prose_uses_is_vocabulary_even_if_no_task_says_it(self):
        # `rules` is the stem of a data file in one task and no prompt of the domain says it: the platform's skill library does.
        prompts = ["Open the attached workbook and report the totals.", "Plot the series in the attached file."]
        reference = [f"Follow the rules of the format; section {i}." for i in range(guard.ORDINARY_MIN_DOCUMENTS)] + ["Unrelated text."]
        alone = guard.TreeGuard(prompts, ["rules", "gapminder"])
        self.assertIn("rules", alone.names, "with no reference text only the domain's own texts can tell")
        informed = guard.TreeGuard(prompts, ["rules", "gapminder"], reference=reference)
        self.assertNotIn("rules", informed.names)
        self.assertEqual(informed.vocabulary, ["rules"])
        self.assertIn("gapminder", informed.names, "a word no text uses is still a name")
        self.assertEqual(informed.problems({"guidance.md": "Apply the rules of the task."}), [])

    def test_platform_prose_reads_the_skill_files_of_the_tree_and_survives_their_absence(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(guard.platform_prose(Path(tmp)), [])
            (Path(tmp) / "runtime" / "skills" / "a").mkdir(parents=True)
            (Path(tmp) / "runtime" / "skills" / "a" / "SKILL.md").write_text("Follow the rules.")
            (Path(tmp) / "runtime" / "skills" / "a" / "notes.md").write_text("not a skill file")
            self.assertEqual(guard.platform_prose(Path(tmp)), ["Follow the rules."])

    def test_candidate_names_leave_out_the_generic_stem_of_a_kind_of_file(self):
        class T:
            def __init__(self, id, files, facts=None):
                self.id, self.files, self.facts = id, tuple({"dest": f"inputs/{f}"} for f in files), facts or {}

        tasks = [T("bix-17", ["count.csv", "BCG-CORONA_AE.csv"]), T("bix-18", ["count.csv", "meta.csv"]), T("bix-19", ["rules.json", "gapminder.csv"]),
                 T("t-4", ["CCLE_metabolomics.csv"], {"uuid": "0f3a1c52-9b7e-4d1a-8c3e-5a6b7c8d9e0f"})]
        names = guard.candidate_names(tasks)
        self.assertNotIn("count", names, "the stem of count.csv in two tasks is a kind of file")
        for kept in ("count.csv", "BCG-CORONA_AE.csv", "BCG-CORONA_AE", "CCLE_metabolomics", "gapminder", "0f3a1c52-9b7e-4d1a-8c3e-5a6b7c8d9e0f", "bix-17"):
            self.assertIn(kept, names)
        self.assertNotIn("meta", names, "under five characters")


if __name__ == "__main__":
    unittest.main()
