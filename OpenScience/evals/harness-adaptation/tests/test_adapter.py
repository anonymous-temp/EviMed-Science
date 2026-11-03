import json
import unittest

from support import Sandbox, ensure_upstream  # noqa: F401  (support puts the package on sys.path)


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.rnd = self.box.round()
        self.adapter = self.rnd.build_adapter("medcalc", ["1", "2"])
        self.surface = self.adapter.substrate.surface()

    def tree_dir(self, tree, name="h"):
        from evimed_h2 import upstream
        up = upstream.load()
        return up.tree.write_tree(self.surface, tree, self.box.tmp / name)

    def test_base_request_shape_and_route_pinning(self):
        run = self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        self.assertTrue((run / "result.json").is_file())
        request = json.loads(self.box.broker_events("submit")[0]["request"] and json.dumps(self.box.broker_events("submit")[0]["request"]))
        self.assertEqual(request["image"], "base")
        self.assertEqual(request["probe"], {"preamble": None, "line": None})
        self.assertIsNone(request["item"]["groupSkill"])
        self.assertTrue(request["item"]["key"].startswith("medcalc/1#h2."))
        self.assertTrue(request["rid"].startswith("h2.rsi1.medcalc.1.base1."))
        self.assertLessEqual(len(request["rid"]), 120)
        self.assertEqual(self.adapter.route_of("1"), "answer")  # open-domain-answer -> the "answer" line
        self.assertNotIn("SECRET-GOLD-VALUE", json.dumps(request))

        tree = {"guidance.md": "Recompute the value with a tool.\n- When a skill applies, load the `check` skill.\n",
                "skills/check/SKILL.md": "---\nname: check\ndescription: a value must be verified\n---\nRead the note again.\n"}
        probe_run = self.adapter.execute("1", self.tree_dir(tree), "rsi1/medcalc/1/inv1")
        probe = [e for e in self.box.broker_events("submit") if "inv1" in e["rid"]][0]["request"]
        self.assertEqual(probe["probe"]["line"], "answer")
        self.assertEqual(probe["item"]["line"], "answer")
        self.assertIn("Recompute the value", probe["probe"]["preamble"])
        skill = probe["item"]["groupSkill"]
        self.assertEqual(set(skill), {"title", "description", "instructions"})
        self.assertIn("## check", skill["instructions"])
        self.assertIn("check: a value must be verified", skill["description"])
        self.assertNotEqual(probe["rid"], request["rid"])
        self.assertEqual(self.adapter.delivered(probe_run), True)

    def test_same_inputs_are_one_request_and_one_charge(self):
        first = self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        second = self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        self.assertEqual(first, second)
        self.assertEqual(len(self.box.broker_events("submit")), 1)
        rows = [r for r in self.rnd.ledger.rows() if r["kind"] == "rollout"]
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["cny"], 0.0123)

    def test_changed_input_is_a_different_request(self):
        self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        a = self.adapter.execute("1", self.tree_dir({"guidance.md": "Rule A.\n"}, "a"), "rsi1/medcalc/1/inv1")
        b = self.adapter.execute("1", self.tree_dir({"guidance.md": "Rule B.\n"}, "b"), "rsi1/medcalc/1/inv1")  # same run id, other tree
        self.assertNotEqual(a, b)
        self.assertEqual(len(self.box.broker_events("submit")), 3)

    def test_a_fetched_bundle_survives_a_killed_process_without_a_new_request(self):
        import shutil
        run = self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        rid = run.name
        archived = next((self.box.tmp / "runs" / "inbox" / "archive").glob(f"done.{rid}.tgz"))
        shutil.rmtree(run)  # the process died after the fetch and before the extraction was recorded
        shutil.copy(archived, self.box.tmp / "runs" / "inbox" / f"{rid}.tgz")
        again = self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        self.assertEqual(again.name, rid)
        self.assertTrue((again / "result.json").is_file())
        self.assertEqual(len(self.box.broker_events("submit")), 1)

    def test_infra_failed_marker_is_infrastructure_then_resubmitted(self):
        from evimed_h2.errors import InfrastructureFailure
        self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        tree = self.tree_dir({"guidance.md": "Rule A.\n"})
        self.box.scenario(infra_fail=["inv1"])
        with self.assertRaises(InfrastructureFailure) as caught:
            self.adapter.execute("1", tree, "rsi1/medcalc/1/inv1")
        self.assertEqual(caught.exception.kind, "lab")
        self.assertTrue(getattr(caught.exception, "infrastructure", False))
        run = self.adapter.execute("1", tree, "rsi1/medcalc/1/inv1")  # asked again: a fresh submission, and now it runs
        self.assertTrue((run / "result.json").is_file())
        self.assertEqual(len(self.box.broker_events("submit")), 3)

    def test_a_run_that_did_not_happen_is_not_a_result(self):
        from evimed_h2.errors import InfrastructureFailure
        self.box.scenario(driver_error=["base1"])
        with self.assertRaises(InfrastructureFailure) as caught:
            self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        self.assertEqual(caught.exception.kind, "driver")
        self.assertEqual([r for r in self.rnd.ledger.rows() if r["kind"] == "rollout"], [])

    def test_infrastructure_failure_passes_through_upstream_roll(self):
        from evimed_h2 import upstream
        from evimed_h2.errors import InfrastructureFailure
        up = upstream.load()
        self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        self.box.scenario(infra_fail=["inv1"])
        with self.assertRaises(InfrastructureFailure):
            up.recursion._roll(self.adapter, up.ledger.Ledger(mode="agg", task_id="1", k=1), "1", "inv1", {"guidance.md": "Rule A.\n"},
                               lambda label: f"rsi1/medcalc/1/{label}", self.box.tmp / "work")

    def test_a_grading_file_in_a_bundle_is_removed_and_recorded(self):
        self.box.scenario(grading_file=True)
        run = self.adapter.execute("1", None, "rsi1/medcalc/1/base1")
        self.assertFalse((run / "scores.json").exists())
        from evimed_h2 import upstream
        mark = upstream.load().runmark.read_mark(run)
        self.assertEqual(mark["removed_grading_files"], ["scores.json"])

    def test_probe_before_base_is_refused(self):
        from evimed_h2.errors import IdentityMismatch
        with self.assertRaises(IdentityMismatch):
            self.adapter.execute("2", self.tree_dir({"guidance.md": "Rule A.\n"}), "rsi1/medcalc/2/inv1")

    def test_score_is_not_available(self):
        with self.assertRaises(NotImplementedError):
            self.adapter.score(self.box.tmp, "1")

    def test_validate_tree_refuses_scripts_and_task_text(self):
        with self.assertRaises(ValueError) as caught:
            self.adapter.validate_tree({"guidance.md": "ok\n", "skills/a/scripts/x.py": "print(1)"})
        self.assertIn("scripts are not on this surface", str(caught.exception))
        prompt = self.adapter.task_map["1"].prompt
        with self.assertRaises(ValueError) as caught:
            self.adapter.validate_tree({"guidance.md": "Remember: " + prompt[40:200]})
        self.assertIn("task's own wording", str(caught.exception))
        self.adapter.validate_tree({"guidance.md": "Recompute the value with a tool before answering.\n"})

    def test_task_prompt_and_files_hold_nothing_graded(self):
        text = self.adapter.task_prompt("1")
        self.assertNotIn("SECRET-GOLD-VALUE", text)
        self.assertIsNone(self.adapter.task_files("1"))


if __name__ == "__main__":
    unittest.main()
