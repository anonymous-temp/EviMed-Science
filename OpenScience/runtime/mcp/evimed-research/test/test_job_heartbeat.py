"""A managed job's state advances while its engine works, on the local paths too.

On 2026-09-27 a research-topic job PubMed was throttling ran for 21 minutes;
its state was written at start and at completion only, so the run polling it
saw `updatedAt` frozen at the start after 15 minutes, recorded the job as dead
and delivered a fallback six minutes before the job succeeded.
"""

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import job_heartbeat  # noqa: E402

BEAT = 0.05

WAITING_RUNNER = r'''import argparse, json, os, time
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument("--request")
parser.add_argument("--output-dir")
args = parser.parse_args()
Path(os.environ["EVIMED_JOB_PROGRESS_FILE"]).write_text(json.dumps({"stage": "多源并行检索", "percent": 10}))
release, deadline = Path(os.environ["TEST_RELEASE_FILE"]), time.time() + 30
while not release.exists() and time.time() < deadline:
    time.sleep(0.02)
out = Path(args.output_dir)
(out / "report.md").write_text("# Report\n", encoding="utf-8")
(out / "result.json").write_text(json.dumps({"status": "succeeded"}), encoding="utf-8")
'''

WAITING_META_MAIN = r'''import argparse, json, os, time
from pathlib import Path
parser = argparse.ArgumentParser()
for flag in ("--topic", "--output-dir", "--model", "--run-mode", "--language", "--max-papers",
             "--analysis-type", "--user-pdfs", "--ipd-data"):
    parser.add_argument(flag)
parser.add_argument("--skip-confirm", action="store_true")
args = parser.parse_args()
project = Path(args.output_dir) / "working-project"
project.mkdir(parents=True)
(project / "step_manifest.json").write_text(json.dumps({
    "pipeline_steps": ["protocol", "search_query", "search", "ta_screening"],
    "steps": {"protocol": {"status": "complete"}, "search_query": {"status": "complete"}},
}), encoding="utf-8")
release, deadline = Path(os.environ["TEST_RELEASE_FILE"]), time.time() + 30
while not release.exists() and time.time() < deadline:
    time.sleep(0.02)
(project / "package").mkdir()
(project / "package" / "release_decision.json").write_text(json.dumps({"status": "ready", "next_actions": []}), encoding="utf-8")
'''


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_until(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    return None


def running_state(path):
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return state if state.get("status") == "running" else None


class LocalJobHeartbeatTests(unittest.TestCase):
    def setUp(self):
        self.old_env = os.environ.copy()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.release = self.root / "release"
        token = self.root / "model-gateway.token"
        token.write_text("test-key\n", encoding="utf-8")
        token.chmod(0o600)
        os.environ.update({
            "OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace),
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token),
            "EVIMED_MODEL_GATEWAY_URL": "https://api.deepseek.example",
            "EVIMED_MODEL_GATEWAY_MODEL": "deepseek-flash",
            "TEST_RELEASE_FILE": str(self.release),
        })
        patcher = mock.patch.object(job_heartbeat, "HEARTBEAT_SECONDS", BEAT)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.release.touch()
        os.environ.clear()
        os.environ.update(self.old_env)
        self.temporary.cleanup()

    def run_while_polling(self, run_job, state_path, status):
        """Run the worker in a thread; return what was observed while it worked."""
        outcome = []
        worker = threading.Thread(target=lambda: outcome.append(run_job(state_path)))
        worker.start()
        try:
            first = wait_until(lambda: running_state(state_path))
            self.assertIsNotNone(first, "the worker never started")
            advanced = wait_until(
                lambda: (state := running_state(state_path))
                and state["updatedAt"] != first["updatedAt"]
                and state.get("progress")
                and state
            )
            polled = status()
        finally:
            self.release.touch()
            worker.join(30)
        self.assertIsNotNone(advanced, "updatedAt stayed at the worker's start while the engine worked")
        terminal = json.loads(state_path.read_text(encoding="utf-8"))
        time.sleep(BEAT * 4)
        self.assertEqual(json.loads(state_path.read_text(encoding="utf-8")), terminal, "a beat after the terminal write")
        return outcome, advanced, polled, terminal

    def test_a_local_specialist_job_advances_while_its_engine_works(self):
        jobs = load("evimed_specialist_jobs_heartbeat", "specialist_jobs.py")
        spec = jobs.SPECS["research_topic_selection"]
        root = self.root / spec["id"]
        (root / pathlib.Path(spec["marker"]).parent).mkdir(parents=True)
        (root / spec["marker"]).write_text("# marker\n", encoding="utf-8")
        (root / "evimed_runner.py").write_text(WAITING_RUNNER, encoding="utf-8")
        os.environ[spec["rootEnv"]] = str(root)
        os.environ[spec["pythonEnv"]] = sys.executable
        live = mock.Mock()
        live.poll.return_value = None
        with mock.patch.object(jobs.subprocess, "Popen", return_value=live):
            job_id = jobs.call("research_topic_selection", {
                "action": "start", "researchDirection": "Dialysis adherence",
            })["data"]["jobId"]
        state_path = self.workspace / "research-topic-runs" / ".jobs" / (job_id + ".json")

        outcome, advanced, polled, terminal = self.run_while_polling(
            jobs._run_job, state_path,
            lambda: jobs.status_job("research_topic_selection", {"jobId": job_id}),
        )

        self.assertEqual(outcome, [0])
        self.assertEqual(advanced["progress"], {"stage": "多源并行检索", "percent": 10})
        self.assertEqual(polled["data"]["jobStatus"], "running")
        self.assertEqual(polled["data"]["progress"], {"stage": "多源并行检索", "percent": 10})
        self.assertLessEqual(polled["data"]["secondsSinceUpdate"], 5)
        self.assertIsInstance(polled["data"]["elapsedSeconds"], int)
        self.assertEqual(terminal["status"], "succeeded")
        self.assertFalse(state_path.with_name(job_id + ".progress.json").exists())
        finished = jobs.status_job("research_topic_selection", {"jobId": job_id})
        self.assertIsInstance(finished["data"]["elapsedSeconds"], int)

    def test_a_local_meta_job_advances_while_metaagent_works(self):
        meta = load("evimed_meta_agent_heartbeat", "meta_agent.py")
        meta_root = self.root / "meta"
        (meta_root / "new_meta").mkdir(parents=True)
        (meta_root / "new_meta" / "__init__.py").write_text("", encoding="utf-8")
        (meta_root / "new_meta" / "main.py").write_text(WAITING_META_MAIN, encoding="utf-8")
        os.environ["EVIMED_META_AGENT_ROOT"] = str(meta_root)
        os.environ["EVIMED_META_AGENT_PYTHON"] = sys.executable
        live = mock.Mock()
        live.poll.return_value = None
        with mock.patch.object(meta.subprocess, "Popen", return_value=live):
            job_id = meta.call({"action": "start", "topic": "Heartbeat topic"})["data"]["jobId"]
        state_path = self.workspace / "meta-analysis-runs" / ".jobs" / (job_id + ".json")

        outcome, advanced, polled, terminal = self.run_while_polling(
            meta._run_job, state_path, lambda: meta.status_job({"jobId": job_id}),
        )

        self.assertEqual(outcome, [0])
        self.assertEqual(advanced["progress"], {"stage": "search", "percent": 50})
        self.assertEqual(polled["data"]["jobStatus"], "running")
        self.assertEqual(polled["data"]["progress"], {"stage": "search", "percent": 50})
        self.assertLessEqual(polled["data"]["secondsSinceUpdate"], 5)
        self.assertEqual(terminal["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
