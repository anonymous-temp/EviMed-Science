import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_FILE = ROOT / "specialist_jobs.py"


def load_module():
    spec = importlib.util.spec_from_file_location("evimed_specialist_jobs_test", MODULE_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SpecialistJobContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.jobs = load_module()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temp.name) / "workspace"
        self.workspace.mkdir()
        self.model_config = pathlib.Path(self.temp.name) / "opencode.json"
        self.model_config.write_text(json.dumps({
            "provider": {
                "deepseek": {
                    "options": {"baseURL": "https://api.deepseek.com", "apiKey": "test-key"},
                    "models": {"deepseek-v4-pro": {}},
                }
            }
        }), encoding="utf-8")
        self.old_env = os.environ.copy()
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(self.workspace)
        os.environ["EVIMED_MODEL_CONFIG_FILE"] = str(self.model_config)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        self.temp.cleanup()

    def install_fake_specialist(self, tool_name):
        spec = self.jobs.SPECS[tool_name]
        root = pathlib.Path(self.temp.name) / spec["id"]
        (root / pathlib.Path(spec["marker"]).parent).mkdir(parents=True)
        (root / spec["marker"]).write_text("# marker\n", encoding="utf-8")
        (root / "evimed_runner.py").write_text("# runner\n", encoding="utf-8")
        os.environ[spec["rootEnv"]] = str(root)
        os.environ[spec["pythonEnv"]] = sys.executable
        return root

    def test_all_specialists_publish_managed_capabilities(self):
        for tool_name in self.jobs.SPECS:
            with self.subTest(tool=tool_name):
                self.install_fake_specialist(tool_name)
                result = self.jobs.call(tool_name, {"action": "capabilities"})
                self.assertEqual(result["status"], "success")
                self.assertTrue(result["data"]["available"])
                self.assertEqual(result["data"]["model"], "deepseek-v4-pro")

    def test_unconfigured_specialist_fails_honestly(self):
        result = self.jobs.call("evimed_peer_review", {"action": "capabilities"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "specialist_agent_unconfigured")

    def test_peer_review_rejects_manuscripts_outside_workspace_before_starting(self):
        self.install_fake_specialist("evimed_peer_review")
        with mock.patch.object(self.jobs.subprocess, "Popen") as popen:
            result = self.jobs.call("evimed_peer_review", {
                "action": "start",
                "manuscript": "/tmp/outside.pdf",
            })
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "specialist_input_path_invalid")
        popen.assert_not_called()

    def test_background_worker_receives_the_managed_workspace(self):
        self.install_fake_specialist("evimed_bibliometric_analysis")
        worker = mock.Mock()
        with mock.patch.object(self.jobs.subprocess, "Popen", return_value=worker) as popen:
            result = self.jobs.call("evimed_bibliometric_analysis", {
                "action": "start",
                "topic": "test topic",
                "maxRecords": 20,
            })
        self.assertEqual(result["status"], "warning")
        environment = popen.call_args.kwargs["env"]
        self.assertEqual(environment["OPEN_SCIENCE_WORKSPACE_DIR"], str(self.workspace))

    def test_job_state_binds_the_current_specialist_source(self):
        root = self.install_fake_specialist("evimed_bibliometric_analysis")
        with mock.patch.object(self.jobs.subprocess, "Popen", return_value=mock.Mock()):
            result = self.jobs.call("evimed_bibliometric_analysis", {
                "action": "start",
                "topic": "test topic",
            })
        job_id = result["data"]["jobId"]
        state_path = self.workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["executionEvidence"], self.jobs._execution_evidence(root))
        (root / "evimed_runner.py").write_text("# changed runner\n", encoding="utf-8")
        self.assertNotEqual(state["executionEvidence"], self.jobs._execution_evidence(root))

    def test_job_source_evidence_ignores_runtime_cache_mutations(self):
        root = self.install_fake_specialist("evimed_drug_safety_analysis")
        cache = root / ".cache" / "openfda"
        cache.mkdir(parents=True)
        cache_file = cache / "response.json"
        cache_file.write_text('{"cached": 1}\n', encoding="utf-8")
        before = self.jobs._execution_evidence(root)

        cache_file.write_text('{"cached": 2}\n', encoding="utf-8")
        (cache / "new-response.json").write_text('{"cached": 3}\n', encoding="utf-8")

        self.assertEqual(before, self.jobs._execution_evidence(root))

    def test_project_environment_is_allowlisted_and_cannot_override_model_config(self):
        root = self.install_fake_specialist("evimed_mendelian_randomization")
        (root / ".env").write_text(
            "OPENGWAS_JWT=project-token\nDEEPSEEK_API_KEY=untrusted-model-key\nUNRELATED=value\n",
            encoding="utf-8",
        )
        with mock.patch.object(self.jobs.subprocess, "Popen") as popen:
            result = self.jobs.call("evimed_mendelian_randomization", {
                "action": "start",
                "exposure": "body mass index",
                "outcome": "coronary heart disease",
            })
        self.assertEqual(result["status"], "warning")
        environment = popen.call_args.kwargs["env"]
        self.assertEqual(environment["OPENGWAS_JWT"], "project-token")
        self.assertEqual(environment["DEEPSEEK_API_KEY"], "test-key")
        self.assertNotIn("UNRELATED", environment)

    def test_drug_safety_receives_only_allowlisted_evidence_configuration(self):
        root = self.install_fake_specialist("evimed_drug_safety_analysis")
        key_file = pathlib.Path(self.temp.name) / "evimed.api-key"
        key_file.write_text("test-key\n", encoding="utf-8")
        key_file.chmod(0o600)
        (root / ".env").write_text(
            "EVIMED_EVIDENCE_SEARCH_URL=https://www.evimed.com/api-evimed/medicine-api/ai-api\n"
            f"EVIMED_EVIDENCE_SEARCH_KEY_FILE={key_file}\n"
            "OPENFDA_BASE_URL=https://api.fda.gov\n"
            "UNRELATED=value\n",
            encoding="utf-8",
        )
        with mock.patch.object(self.jobs.subprocess, "Popen") as popen:
            result = self.jobs.call("evimed_drug_safety_analysis", {
                "action": "start",
                "drug": "atorvastatin",
                "reactions": ["myalgia"],
            })
        self.assertEqual(result["status"], "warning")
        environment = popen.call_args.kwargs["env"]
        self.assertEqual(environment["EVIMED_EVIDENCE_SEARCH_KEY_FILE"], str(key_file))
        self.assertEqual(environment["OPENFDA_BASE_URL"], "https://api.fda.gov")
        self.assertNotIn("UNRELATED", environment)

    def test_managed_model_environment_limits_specialist_concurrency(self):
        environment = self.jobs._model_environment()
        self.assertEqual(environment["LLM_MAX_CONCURRENT"], "2")
        self.assertEqual(environment["MAX_CONCURRENT_REVIEWS"], "1")
        self.assertEqual(environment["MAX_CONCURRENT_REVIEWS_V2"], "1")

    def test_failed_status_preserves_terminal_job_state_for_pollers(self):
        self.install_fake_specialist("evimed_research_topic_selection")
        job_id = "topic-20260718120000-abcdef123456"
        jobs = self.workspace / "research-topic-runs" / ".jobs"
        jobs.mkdir(parents=True)
        (jobs / f"{job_id}.json").write_text(
            json.dumps({
                "tool": "evimed_research_topic_selection",
                "jobId": job_id,
                "status": "failed",
                "updatedAt": "2026-07-18T04:00:00Z",
                "error": "upstream model unavailable",
                "retryable": True,
            }),
            encoding="utf-8",
        )

        result = self.jobs.status_job(
            "evimed_research_topic_selection",
            {"jobId": job_id},
        )

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertEqual(result["data"]["jobId"], job_id)

    def test_a_job_whose_worker_died_stops_answering_still_running(self):
        # A SIGKILL or an OOM kill left the state file saying "running" and
        # this tool answering "not complete, poll again" for as long as anyone
        # asked. There was no liveness check at all, unlike meta_agent.
        self.install_fake_specialist("evimed_research_topic_selection")
        job_id = "topic-20260815090000-abcdef123456"
        jobs = self.workspace / "research-topic-runs" / ".jobs"
        jobs.mkdir(parents=True)
        state_path = jobs / f"{job_id}.json"
        dead_pid = self.a_pid_that_is_not_running()
        state_path.write_text(
            json.dumps({
                "tool": "evimed_research_topic_selection",
                "jobId": job_id,
                "status": "running",
                "workerPid": dead_pid,
                "updatedAt": "2026-08-15T09:00:00Z",
            }),
            encoding="utf-8",
        )

        result = self.jobs.status_job("evimed_research_topic_selection", {"jobId": job_id})

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertTrue(result["error"]["retryable"], "an OOM kill is worth retrying")
        self.assertEqual(
            json.loads(state_path.read_text(encoding="utf-8"))["status"],
            "failed",
            "the conclusion is recorded, not recomputed on every poll",
        )

    def test_a_live_worker_is_still_reported_as_running(self):
        # The liveness check must not fail a job that is doing its work.
        self.install_fake_specialist("evimed_research_topic_selection")
        job_id = "topic-20260815090100-abcdef123456"
        jobs = self.workspace / "research-topic-runs" / ".jobs"
        jobs.mkdir(parents=True)
        (jobs / f"{job_id}.json").write_text(
            json.dumps({
                "tool": "evimed_research_topic_selection",
                "jobId": job_id,
                "status": "running",
                "workerPid": os.getpid(),
                "updatedAt": "2026-08-15T09:01:00Z",
            }),
            encoding="utf-8",
        )

        result = self.jobs.status_job("evimed_research_topic_selection", {"jobId": job_id})

        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["jobStatus"], "running")

    def test_a_job_without_a_recorded_pid_is_left_alone(self):
        # Liveness that cannot be established is not death. A job recorded
        # before its worker pid was written must keep polling, not be failed.
        self.install_fake_specialist("evimed_research_topic_selection")
        job_id = "topic-20260815090200-abcdef123456"
        jobs = self.workspace / "research-topic-runs" / ".jobs"
        jobs.mkdir(parents=True)
        (jobs / f"{job_id}.json").write_text(
            json.dumps({
                "tool": "evimed_research_topic_selection",
                "jobId": job_id,
                "status": "queued",
                "updatedAt": "2026-08-15T09:02:00Z",
            }),
            encoding="utf-8",
        )

        result = self.jobs.status_job("evimed_research_topic_selection", {"jobId": job_id})

        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["jobStatus"], "queued")

    def test_specialist_execution_carries_its_own_wall_clock(self):
        # The only bound used to be the server's four-hour run monitor, and
        # that one counts polls rather than time, so a hung child outlived
        # every limit the platform believed it had.
        self.assertEqual(self.jobs._execution_timeout_seconds(), 10800)
        os.environ["EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS"] = "600"
        self.assertEqual(self.jobs._execution_timeout_seconds(), 600)
        os.environ["EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS"] = "1"
        self.assertEqual(self.jobs._execution_timeout_seconds(), 60, "a floor, so a typo cannot disable specialists")
        os.environ["EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS"] = "999999"
        self.assertEqual(self.jobs._execution_timeout_seconds(), 14400, "a ceiling inside the run monitor")
        os.environ["EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS"] = "not-a-number"
        self.assertEqual(self.jobs._execution_timeout_seconds(), 10800)

    def a_pid_that_is_not_running(self):
        for candidate in range(400000, 420000):
            try:
                os.kill(candidate, 0)
            except ProcessLookupError:
                return candidate
            except PermissionError:
                continue
        self.skipTest("no free pid found to stand in for a dead worker")

    def test_virtual_environment_entry_point_is_not_resolved_to_base_python(self):
        root = self.install_fake_specialist("evimed_peer_review")
        os.environ.pop("EVIMED_PEER_REVIEW_AGENT_PYTHON", None)
        entry_point = root / ".venv" / "bin" / "python"
        entry_point.parent.mkdir(parents=True)
        entry_point.symlink_to(sys.executable)
        selected = self.jobs._python(self.jobs.SPECS["evimed_peer_review"], root)
        self.assertEqual(selected, entry_point)
        self.assertNotEqual(str(selected), str(entry_point.resolve()))

    def test_mendelian_randomization_uses_the_project_r_library(self):
        root = self.install_fake_specialist("evimed_mendelian_randomization")
        (root / ".r-lib").mkdir()
        with mock.patch.object(self.jobs.subprocess, "Popen") as popen:
            result = self.jobs.call("evimed_mendelian_randomization", {
                "action": "start",
                "exposure": "body mass index",
                "outcome": "coronary heart disease",
            })
        self.assertEqual(result["status"], "warning")
        self.assertEqual(popen.call_args.kwargs["env"]["R_LIBS_USER"], str((root / ".r-lib").resolve()))


if __name__ == "__main__":
    unittest.main()
