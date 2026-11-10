"""Offline checks: loop boundaries, skill selection, transport retries and resume."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from loop import DeepSeekModel, JsonSkillProvider, NoSkillProvider, parse_action, run_episode
from run_c1 import episode_key, main


class FakeEnvironment:
    instructions = "Use go."

    def __init__(self, finish=2):
        self.actions = []
        self.finish = finish

    def reset(self):
        return "A room.", "Find the exit."

    def step(self, action):
        self.actions.append(action)
        won = len(self.actions) >= self.finish
        return "An exit.", 100 if won else 0, won, won


class FakeModel:
    def __init__(self):
        self.calls = []

    def complete(self, messages):
        self.calls.append([dict(m) for m in messages])
        return {"text": "Thought: Move.\nAction: go", "usage": {"prompt_tokens": 10, "completion_tokens": 4}}


class Tests(unittest.TestCase):
    def test_one_action_per_reply_and_usage(self):
        env, model = FakeEnvironment(), FakeModel()
        row = run_episode(env, model, "alfworld", "seen")
        self.assertTrue(row["success"])
        self.assertEqual(env.actions, ["go", "go"])
        self.assertEqual((row["promptTokens"], row["completionTokens"]), (20, 8))
        self.assertEqual(len(model.calls[1]), 4)
        self.assertEqual(row["cards"], [])
        self.assertIsNone(row["error"])

    def test_caps_and_failure_preserve_denominator(self):
        for name, cap in [("alfworld", 50), ("scienceworld", 100)]:
            env = FakeEnvironment(finish=1000)
            row = run_episode(env, FakeModel(), name, "seen")
            self.assertEqual(len(env.actions), cap)
            self.assertFalse(row["success"])
        model = Mock()
        model.complete.side_effect = RuntimeError("first line\nprivate detail")
        row = run_episode(FakeEnvironment(), model, "alfworld", "seen")
        self.assertEqual(row["error"], "first line")
        self.assertEqual(row["score"], 0)

    def test_billed_reply_survives_step_error(self):
        env = FakeEnvironment()
        env.step = Mock(side_effect=ValueError("bad action"))
        row = run_episode(env, FakeModel(), "alfworld", "seen")
        self.assertEqual(row["promptTokens"], 10)
        self.assertEqual(len(row["steps"]), 1)
        self.assertEqual(row["error"], "bad action")

    def test_action_parser(self):
        self.assertEqual(parse_action("Thought: x\nAction: open door"), "open door")
        self.assertEqual(parse_action("look around"), "look around")
        with self.assertRaises(ValueError):
            parse_action("")

    def test_skills_flat_pyramid_cycles_and_injection(self):
        with tempfile.TemporaryDirectory() as temp:
            library = Path(temp) / "library.json"
            library.write_text(json.dumps({"skills": [
                {"name": "atomic", "level": "atomic", "when": "", "body": "Look carefully.", "depends_on": ["abstract"]},
                {"name": "abstract", "level": "abstract", "when": "exit", "body": "Find exits.", "depends_on": ["atomic"]},
                {"name": "other", "level": "abstract", "when": "chemistry", "body": "Mix."}]}))
            self.assertEqual(len(JsonSkillProvider(library, "flat").cards_for("", "alfworld", "seen")), 3)
            provider = JsonSkillProvider(library, "pyramid")
            self.assertEqual([c["name"] for c in provider.cards_for("Find exit", "alfworld", "seen")], ["atomic", "abstract"])
            self.assertEqual(provider.cards_for("Nothing", "alfworld", "seen"), [])
            model = FakeModel()
            row = run_episode(FakeEnvironment(), model, "alfworld", "seen", provider)
            self.assertIn("Find exits.", model.calls[0][0]["content"])
            self.assertEqual(len(row["cards"]), 2)
            self.assertEqual(NoSkillProvider().cards_for("x", "y", "z"), [])

    def test_http_retry_and_secret_not_in_error(self):
        with tempfile.TemporaryDirectory() as temp:
            key = Path(temp) / "key"
            key.write_text("fake-test-key")
            sleep = Mock()
            model = DeepSeekModel(key, sleep=sleep)
            success = Mock(status_code=200, ok=True)
            success.json.return_value = {"choices": [{"message": {"content": "Action: go"}}], "usage": {}}
            model.session.post = Mock(side_effect=[Mock(status_code=429, headers={"Retry-After": "0"}), Mock(status_code=503, headers={}), success])
            self.assertEqual(model.complete([])["attempts"], 3)
            self.assertEqual(sleep.call_count, 2)
            kwargs = model.session.post.call_args.kwargs
            self.assertEqual(kwargs["json"]["thinking"], {"type": "disabled"})
            self.assertEqual(kwargs["json"]["temperature"], 0)
            self.assertNotIn("fake-test-key", json.dumps(kwargs["json"]))
            model.session.post = Mock(return_value=Mock(status_code=401, ok=False))
            with self.assertRaisesRegex(RuntimeError, "^DeepSeek HTTP 401$"):
                model.complete([])

    def test_resume_skips_without_model_and_recovers_row(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pool = root / "pool.json"
            pool.write_text(json.dumps({"sets": {"scienceworld": {"seen": ["0:task-1-boil:var17"]}}}))
            row = {"env": "scienceworld", "fold": "seen", "arm": "no-skill", "taskId": "0:task-1-boil:var17",
                   "success": False, "score": 0, "steps": 100, "promptTokens": 10, "completionTokens": 4, "seconds": 1, "error": None}
            (root / "episodes.jsonl").write_text(json.dumps(row) + "\n")
            argv = ["run_c1.py", "--env", "scienceworld", "--fold", "seen", "--samples", str(pool),
                    "--arm", "no-skill", "--out", str(root), "--key-file", "/nonexistent"]
            for _ in range(2):
                output = io.StringIO()
                with patch.object(sys, "argv", argv), contextlib.redirect_stdout(output):
                    main()
                self.assertIn('"skipped": 1', output.getvalue())
            self.assertEqual(len((root / "episodes.jsonl").read_text().splitlines()), 1)
            self.assertEqual((root / "STATUS").read_text(), "DONE " + episode_key("scienceworld", "seen", "no-skill", row["taskId"]) + "\n")
            pool.write_text(pool.read_text() + " ")
            with patch.object(sys, "argv", argv), self.assertRaisesRegex(ValueError, "configuration changed"):
                main()

    def test_cli_disallows_skill_contamination(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("run_c1.py")),
            "--env", "alfworld", "--fold", "seen", "--samples", "missing", "--arm", "no-skill",
            "--library", "missing", "--out", "missing"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no-skill forbids", result.stderr)


if __name__ == "__main__":
    unittest.main()
