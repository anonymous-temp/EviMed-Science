"""One whole recursion per task, end to end, with a fake lab and a fake CLI and no network.

The same driver, adapter, channels, ledger and upstream core as the real round; only the two processes at the edges are fakes.
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from support import FAKE_KEY, PACKAGE, Sandbox


class RoundTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)

    def summary(self, tid):
        return json.loads((self.box.runs / "tasks" / "medcalc" / tid / "summary.json").read_text())

    def test_one_task_whole_recursion(self):
        self.box.write_tasks(["1"])
        rnd = self.box.round()
        self.assertEqual(rnd.run(), 0)
        s = self.summary("1")
        self.assertEqual(s["status"], "adopted", s["reasons"])
        # R = 4k rollouts and P = 3k stages (upstream's own identity), plus the selector and the reflector
        self.assertEqual((s["ledger"]["R"], s["ledger"]["P"]), (4, 3))
        rids = [e["rid"] for e in self.box.broker_events("submit")]
        self.assertEqual(sorted(r.split(".")[-2] for r in rids), ["agg1", "base1", "dom1", "inv1"])
        calls = self.box.cli_calls()
        self.assertEqual(sorted(c["model"] for c in calls), sorted(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]))
        # the baseline is in the selection pool: the selector saw both the base run and the composed one
        self.assertEqual(sorted(s["selection"]["id_map"].values()), ["agg1", "base1"])
        self.assertFalse(s["selection"]["chosen_is_base"])  # the composed run recomputed (the fake lane answers 42 only to a probe)
        self.assertTrue(s["library_entry"])
        self.assertEqual((s["spent"]["rollouts"], s["spent"]["improver_calls"]), (4, 5))
        self.assertAlmostEqual(s["spent"]["solver_cny"], 4 * 0.0123, places=5)
        out = self.box.out / "medcalc"
        self.assertTrue((out / "library" / "INDEX.md").is_file())
        self.assertTrue((out / "tasks" / "1" / "adopted" / "guidance.md").is_file())
        self.assertIn("Recompute", (out / "tasks" / "1" / "adopted" / "guidance.md").read_text())
        self.assertTrue((out / "library" / "harnesses" / "1" / "EXPERIENCE.md").is_file())

    def test_cost_attribution_lands_in_one_ledger(self):
        self.box.write_tasks(["1"])
        self.box.round().run()
        rows = [json.loads(l) for l in (self.box.out / "rsi1-ledger.jsonl").read_text().splitlines()]
        rollouts = [r for r in rows if r["kind"] == "rollout"]
        improver = [r for r in rows if r["kind"] == "improver" and not r["cached"]]
        self.assertEqual(len(rollouts), 4)
        self.assertTrue(all(r["cny"] == 0.0123 for r in rollouts))
        self.assertEqual(sorted(r["stage"] for r in improver), ["agg", "dom", "experience", "inv", "select"])
        by_stage = {r["stage"]: r for r in improver}
        for row in improver:  # every improver stage is Claude: subscription usage, tokens and the API-equivalent figure, no cash
            self.assertNotIn("cny", row)
            self.assertEqual((row["usage"]["output_tokens"], row["usd_reported"]), (300, 0.05))
        self.assertEqual(by_stage["dom"]["model"], "claude-sonnet-5-5")
        totals = self.box.round().ledger.totals()
        self.assertEqual(totals["rollouts"], 4)
        self.assertAlmostEqual(totals["solver_cny"], 4 * 0.0123, places=5)  # the settled cost of the four rollouts is the round's only cash
        self.assertEqual(totals["improver_calls"], 5)

    def test_resume_pays_nothing_twice(self):
        self.box.write_tasks(["1"])
        self.assertEqual(self.box.round().run(), 0)
        before = (len(self.box.cli_calls()), len(self.box.broker_events("submit")), len((self.box.out / "rsi1-ledger.jsonl").read_text().splitlines()))
        self.assertEqual(self.box.round().run(), 0)
        after = (len(self.box.cli_calls()), len(self.box.broker_events("submit")), len((self.box.out / "rsi1-ledger.jsonl").read_text().splitlines()))
        self.assertEqual(before, after)

    def test_resume_after_an_infrastructure_stop_reuses_everything_already_paid(self):
        self.box.write_tasks(["1"])
        self.box.scenario(infra_fail=["dom1"])  # the lab gives up on one rollout, once
        rnd = self.box.round()
        self.assertEqual(rnd.run(), 3)
        s = self.summary("1")
        self.assertEqual(s["status"], "infra")
        self.assertEqual(s["infrastructure"]["kind"], "lab")
        self.assertFalse((self.box.out / "medcalc" / "library" / "harnesses" / "1").exists())  # nothing adopted around the failure
        calls_before = len(self.box.cli_calls())
        self.assertEqual(self.box.round().run(), 0)
        self.assertEqual(self.summary("1")["status"], "adopted")
        # the two editors' replies were cached: only the stages after the failure ran
        self.assertEqual(len(self.box.cli_calls()) - calls_before, 3)
        base_submissions = [e for e in self.box.broker_events("submit") if ".base1." in e["rid"]]
        self.assertEqual(len(base_submissions), 1)

    def test_quota_is_a_transport_failure_never_a_fallen_back_candidate(self):
        self.box.write_tasks(["1", "2"])
        os.environ["FAKE_CLAUDE_MODE"] = "quota"
        os.environ["FAKE_CLAUDE_FAIL_MODEL"] = "claude-sonnet-5-5"
        rnd = self.box.round()
        self.assertEqual(rnd.run(), 3)
        s = self.summary("1")
        self.assertEqual(s["status"], "infra")
        self.assertEqual(s["infrastructure"]["kind"], "quota")
        self.assertFalse((self.box.runs / "tasks" / "medcalc" / "2" / "summary.json").exists())  # the second task never started
        submits_before = len(self.box.broker_events("submit"))
        self.assertLessEqual(submits_before, 2)  # no rollout was spent on an inherited-harness stand-in for the stage that failed
        os.environ.pop("FAKE_CLAUDE_MODE")
        self.assertEqual(self.box.round().run(), 0)
        self.assertEqual(self.summary("1")["status"], "adopted")

    def test_a_stage_that_fell_back_is_visible_and_the_task_stays_out_of_the_library(self):
        self.box.write_tasks(["1"])
        os.environ["FAKE_CLAUDE_MODE"] = "badtree"
        os.environ["FAKE_CLAUDE_FAIL_DIM"] = "DOMAIN"  # the domain editor writes a tree the guard refuses, twice
        self.assertEqual(self.box.round().run(), 2)
        s = self.summary("1")
        self.assertEqual(s["status"], "excluded")
        fell = [st for st in s["stages"] if st["fell_back"]]
        self.assertEqual([st["label"] for st in fell], ["dom1"])
        self.assertIn("numerals", fell[0]["error"])
        self.assertTrue(any("fell back" in r for r in s["reasons"]))
        self.assertFalse((self.box.out / "medcalc" / "library" / "harnesses" / "1").exists())
        self.assertFalse(s["library_entry"])

    def test_balance_below_the_floor_pauses_before_a_new_rollout(self):
        from evimed_h2.balance import BalanceGuard
        self.box.write_tasks(["1"])
        readings = iter([400.0, 400.0, 900.0])
        clock = {"t": 0.0}
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            clock["t"] += seconds

        guard = BalanceGuard(fetch=lambda: next(readings, 900.0), floor=500, min_interval=60, cap_cny=None, clock=lambda: clock["t"], sleep=sleep, log=lambda s: None)
        rnd = self.box.round(balance=guard)
        self.assertEqual(rnd.run(), 0)
        self.assertEqual(sleeps[:2], [60, 60])  # paused twice, then resumed on its own
        # one read per minute at most: three reads for the first pause cycle, then the cached value while the clock stood still
        self.assertLess(guard.reads, 10)

    def test_round_cap_stops_new_spend(self):
        from evimed_h2.balance import BalanceGuard
        self.box.write_tasks(["1"])
        guard = BalanceGuard(fetch=lambda: 1000.0, floor=500, min_interval=0, cap_cny=0.01, spent=lambda: 0.02)
        rnd = self.box.round(balance=guard)
        self.assertEqual(rnd.run(), 3)
        self.assertEqual(self.summary("1")["infrastructure"]["kind"], "budget")
        self.assertEqual(self.box.broker_events("submit"), [])

    def test_a_round_can_be_extended_with_more_tasks(self):
        self.box.write_tasks(["1"])
        self.assertEqual(self.box.round().run(), 0)
        calls = len(self.box.cli_calls())
        self.box.write_tasks(["1", "2"])
        self.assertEqual(self.box.round().run(), 0)
        self.assertEqual(self.summary("2")["status"], "adopted")
        self.assertEqual(len(self.box.cli_calls()) - calls, 5)  # task 1 was not touched again
        # the second task read the library the first one left
        self.assertTrue(any("library" in str(p) for p in (self.box.runs / "tasks" / "medcalc" / "2" / "context" / "inv1").rglob("*")))

    def test_identity_mismatch_refuses_a_resume_with_other_models(self):
        self.box.write_tasks(["1"])
        self.assertEqual(self.box.round().run(), 0)
        changed = json.loads(self.box.channel_file.read_text())
        changed["stages"]["inv"]["model"] = "claude-sonnet-5-4"
        self.box.channel_file.write_text(json.dumps(changed))
        rnd = self.box.round()
        self.assertEqual(rnd.run(), 1)
        self.assertEqual(self.box.round().run(), 1)

    def test_a_round_recorded_with_a_deepseek_domain_editor_refuses_to_resume(self):
        self.box.write_tasks(["1"])
        self.assertEqual(self.box.round().run(), 0)
        identity_file = self.box.runs / "tasks" / "medcalc" / "identity.json"
        recorded = json.loads(identity_file.read_text())
        recorded["channels"]["dom"].update({"provider": "deepseek", "model": "deepseek-v4-pro[1m]"})  # what a round before 2026-11-03 wrote
        identity_file.write_text(json.dumps(recorded))
        calls = len(self.box.cli_calls())
        self.assertEqual(self.box.round().run(), 1)
        self.assertEqual(len(self.box.cli_calls()), calls)  # nothing was asked of any model

    def test_a_channels_file_with_a_deepseek_stage_stops_the_driver_before_anything_is_asked(self):
        document = json.loads(self.box.channel_file.read_text())
        document["stages"]["dom"].update({"model": "deepseek-v4-pro[1m]", "provider": "deepseek"})
        self.box.channel_file.write_text(json.dumps(document))
        with self.assertRaises(ValueError):
            self.box.round()
        done = subprocess.run([sys.executable, str(PACKAGE / "run_round.py"), "--dry-run", "--domains", "medcalc", "--runs-root", str(self.box.runs),
                               "--out", str(self.box.out), "--tasks-file", str(self.box.tasks_file), "--bench-root", str(self.box.bench),
                               "--channels", str(self.box.channel_file), "--offline"], capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn("improver stages run on Claude", done.stderr)
        self.assertEqual((self.box.cli_calls(), self.box.broker_events("submit")), ([], []))

    def test_nothing_gold_reaches_a_session_or_a_request(self):
        self.box.write_tasks(["1"])
        self.box.round().run()
        needle = "SECRET-GOLD-VALUE"
        for path in list((self.box.runs).rglob("*")) + list(self.box.out.rglob("*")):
            if path.is_file() and path.suffix in {".md", ".json", ".jsonl", ".txt"}:
                self.assertNotIn(needle, path.read_text(errors="replace"), str(path))

    def test_a_credential_of_the_parent_shell_never_reaches_a_session_or_the_disk(self):
        self.box.write_tasks(["1"])
        os.environ["DEEPSEEK_API_KEY"] = FAKE_KEY
        os.environ["ANTHROPIC_AUTH_TOKEN"] = FAKE_KEY
        os.environ["ANTHROPIC_BASE_URL"] = "https://api.deepseek.com/anthropic"
        try:
            self.box.round().run()
        finally:
            for k in ("DEEPSEEK_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
                os.environ.pop(k, None)
        calls = self.box.cli_calls()
        self.assertEqual(len(calls), 5)
        for call in calls:
            self.assertEqual((call["base_url"], call["leaked_env"]), (None, []))
        for path in list(self.box.runs.rglob("*")) + list(self.box.out.rglob("*")) + [self.box.cli_log]:
            if path.is_file():
                self.assertNotIn(FAKE_KEY, path.read_text(errors="replace"), str(path))

    def test_env_hygiene_of_every_session(self):
        self.box.write_tasks(["1"])
        os.environ["CLAUDE_CODE_USE_VERTEX"] = "1"
        os.environ["CLAUDE_CODE_SESSION_ID"] = "parent"
        os.environ["ANTHROPIC_API_KEY"] = "parent-key"
        try:
            self.box.round().run()
        finally:
            for k in ("CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_SESSION_ID", "ANTHROPIC_API_KEY"):
                os.environ.pop(k, None)
        for call in self.box.cli_calls():
            self.assertEqual(call["leaked_env"], [])
            self.assertEqual(call["tools"], "Read,Write,Edit,Glob,Grep")
            for flag in ("--safe-mode", "--restricted", "--permission-mode", "--no-session-persistence"):
                self.assertIn(flag, call["flags"])
            self.assertNotIn("--dangerously-skip-permissions", call["flags"])
            self.assertTrue(call["model"].startswith("claude-"))
            self.assertIsNone(call["base_url"])


if __name__ == "__main__":
    unittest.main()
