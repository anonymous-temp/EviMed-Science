import json
import tempfile
import unittest
from pathlib import Path

from support import PACKAGE  # noqa: F401

from evimed_h2 import config, trajectory as T


def run_dir(root: Path, *, status="succeeded", answer="Final answer: 42", messages=None, files=None, result=None):
    root.mkdir(parents=True, exist_ok=True)
    (root / "result.json").write_text(json.dumps({"status": status, "effectiveAgentId": "open-domain-answer", **(result or {})}))
    (root / "answer.md").write_text(answer)
    (root / "transcript.json").write_text(json.dumps({"messages": messages or []}))
    for rel, text in (files or {}).items():
        path = root / "files" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return root


MESSAGES = [
    {"role": "user", "source": "user", "turn": 1, "parts": [{"type": "text", "text": "TASK TEXT"}]},
    {"role": "user", "source": "skill-catalog", "turn": 1, "parts": [{"type": "text", "text": "available skills ..."}]},
    {"role": "user", "source": "plugin:evimed-run-policy", "turn": 1, "parts": [{"type": "text", "text": "<evimed-brief>"}]},
    {"role": "assistant", "source": "system", "turn": 1, "step": 1, "parts": [
        {"type": "reasoning", "text": "think"},
        {"type": "tool", "tool": "bash", "status": "completed", "input": {"command": "ls"}, "output": "a\nb"},
        {"type": "tool", "tool": "web_read", "status": "error", "input": {"url": "x"}, "output": "boom"},
        {"type": "tool", "tool": "bash", "status": "pending", "input": {"command": "sleep 9"}}]},
    {"role": "user", "source": "compact-checkpoint", "turn": 1, "parts": [{"type": "text", "text": "summary of earlier work"}]},
    {"role": "assistant", "source": "system", "turn": 1, "step": 2, "parts": [{"type": "text", "text": "done"}]},
]


class TrajectoryTest(unittest.TestCase):
    def test_grammar_and_skipped_platform_messages(self):
        with tempfile.TemporaryDirectory() as d:
            text = T.render_trajectory(run_dir(Path(d), messages=MESSAGES))
        self.assertIn("[THINKING] think", text)
        self.assertIn('[ACTION] bash({"command": "ls"})', text)
        self.assertIn("[OBSERVATION] a\nb", text)
        self.assertIn("[ACTION] web_read(", text)
        self.assertIn("[OBSERVATION ERROR] boom", text)
        self.assertIn("still pending when the run ended", text)
        self.assertIn("[NOTE compact-checkpoint] summary of earlier work", text)
        self.assertIn("[ASSISTANT] done", text)
        for absent in ("TASK TEXT", "available skills", "evimed-brief"):
            self.assertNotIn(absent, text)

    def test_a_run_that_did_not_end_well_says_so(self):
        with tempfile.TemporaryDirectory() as d:
            text = T.render_trajectory(run_dir(Path(d), status="timeout", messages=MESSAGES, result={"errorCode": "run_timeout"}))
        self.assertTrue(text.endswith("[ERROR] the run ended with status timeout (run_timeout)"))

    def test_deliverables_are_the_final_answer_and_report_like_files_only(self):
        files = {"report/report.md": "# R", "code/analysis.py": "print(1)", "outputs/table.csv": "a,b", "notes.md": "n", "deck.pptx": "binary-ish"}
        with tempfile.TemporaryDirectory() as d:
            got = T.deliverable_files(run_dir(Path(d), files=files, result={"presentedFiles": ["deck.pptx"]}))
        self.assertEqual(sorted(got), ["answer.md", "files/deck.pptx", "files/notes.md", "files/report/report.md"])
        self.assertTrue(got["files/deck.pptx"].startswith("(binary document"))

    def test_a_timed_out_runs_last_message_is_not_a_delivered_answer(self):
        with tempfile.TemporaryDirectory() as d:
            root = run_dir(Path(d), status="timeout", answer="working on it...")
            self.assertEqual(T.deliverable_files(root), {})
            self.assertFalse(T.has_deliverable(root))
            root = run_dir(Path(d) / "b", status="timeout", answer="partial", files={"report/report.md": "# draft"})
            self.assertTrue(T.has_deliverable(root))

    def test_route_and_cost(self):
        self.assertEqual(T.route_of({"effectiveAgentId": "open-domain-answer"}), "answer")
        self.assertEqual(T.route_of({"effectiveAgentId": "statistical-analysis"}), "statistical-analysis")
        self.assertIsNone(T.route_of({}))
        cost = T.cost_of({"cost": {"cost": 0.5, "openCost": 0.25, "currency": "CNY", "calls": 3, "uncertain": 0}, "capture": {"cost": "ok"}})
        self.assertEqual((cost["cny"], cost["calls"], cost["captured"]), (0.75, 3, "ok"))
        self.assertEqual(T.cost_of({"listUsage": {"costCny": 0.1, "requests": 2}})["cny"], 0.1)
        self.assertIsNone(T.cost_of({})["cny"])


class RealTranscripts(unittest.TestCase):
    """The baseline runs of the first campaign, when they are on this box: every family renders, and nothing graded is in what is rendered."""

    ROOT = config.BENCH_ROOT / "results"
    FAMILIES = {"medcalc": "v1-medcalc", "arb": "v1-arb", "bixbench": "v1-bixbench", "mbc": "v1-medbrowsecomp", "drb": "v1-drb", "rcb": "v1-rcb"}

    def setUp(self):
        if not self.ROOT.is_dir():
            self.skipTest("the baseline results are not on this box")

    def test_each_family_renders_and_holds_no_grading_keys(self):
        forbidden_keys = ("gold", "rubric", "criteria", "checklist", "ideal", "scorer")
        for family, folder in self.FAMILIES.items():
            runs = [p for p in sorted((self.ROOT / folder).iterdir()) if (p / "result.json").is_file()][:3]
            self.assertTrue(runs, family)
            for run in runs:
                text = T.render_trajectory(run)
                self.assertNotIn("(no trajectory recorded", text, f"{family}/{run.name}")
                self.assertTrue(any(tag in text for tag in ("[ACTION]", "[ASSISTANT]", "[THINKING]")), f"{family}/{run.name}")
                result = T.result_of(run)
                lowered = {str(k).lower() for k in result}
                self.assertFalse([k for k in forbidden_keys if k in lowered], f"{family}/{run.name}: {sorted(lowered)}")
                for name in T.deliverable_files(run):
                    self.assertFalse(any(k in name.lower() for k in ("gold", "rubric", "criteria", "score", "judge")), name)

    def test_the_answer_of_a_delivered_family_run_is_read(self):
        run = self.ROOT / "v1-medcalc" / "medcalc__18"
        if not run.is_dir():
            self.skipTest("fixture run absent")
        self.assertTrue(T.has_deliverable(run))
        self.assertIn("Final answer", T.deliverable_text(run))
        self.assertEqual(T.route_of(T.result_of(run)), "answer")


if __name__ == "__main__":
    unittest.main()
