import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
MODULE_FILE = ROOT / "meta_agent.py"


def load_meta_agent():
    spec = importlib.util.spec_from_file_location("evimed_meta_agent_test", MODULE_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FAKE_MAIN = r'''import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--topic", required=True)
parser.add_argument("--output-dir", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--skip-confirm", action="store_true")
parser.add_argument("--run-mode", required=True)
parser.add_argument("--language")
parser.add_argument("--max-papers")
parser.add_argument("--analysis-type")
parser.add_argument("--user-pdfs")
parser.add_argument("--ipd-data")
args = parser.parse_args()

project = Path(args.output_dir) / "fake-project"
(project / "manuscript").mkdir(parents=True)
(project / "package").mkdir(parents=True)
(project / "analysis").mkdir(parents=True)
(project / "manuscript" / "draft.md").write_text("# Measured synthesis\n", encoding="utf-8")
(project / "manuscript" / "draft.pdf").write_bytes(b"%PDF-test")
(project / "package" / "metaagent_export.zip").write_bytes(b"PK-test")
(project / "package" / "release_decision.json").write_text(json.dumps({
    "status": "ready",
    "next_actions": [],
}), encoding="utf-8")
(project / "analysis" / "meta_analysis.json").write_text("{}", encoding="utf-8")
(project / "invocation.json").write_text(json.dumps({
    "topic": args.topic,
    "model": args.model,
    "run_mode": args.run_mode,
    "skip_confirm": args.skip_confirm,
    "language": args.language,
    "max_papers": args.max_papers,
    "analysis_type": args.analysis_type,
    "llm_model": os.environ.get("LLM_MODEL"),
    "thinking": os.environ.get("LLM_ENABLE_THINKING"),
    "reasoning_effort": os.environ.get("LLM_REASONING_EFFORT"),
    "api_key_present": bool(os.environ.get("LLM_API_KEY")),
}), encoding="utf-8")
'''


class ManagedMetaAgentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta_agent = load_meta_agent()

    def setUp(self):
        self.old_env = os.environ.copy()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.meta_root = self.root / "meta"
        self.workspace.mkdir()
        (self.meta_root / "new_meta").mkdir(parents=True)
        (self.meta_root / "new_meta" / "__init__.py").write_text("", encoding="utf-8")
        (self.meta_root / "new_meta" / "main.py").write_text(FAKE_MAIN, encoding="utf-8")
        # What the runtime actually writes: the gateway token alone, one line,
        # mode 0600. The URL and the model name are environment, not file
        # contents, so nothing here has to parse a kernel's configuration.
        self.model_gateway_token = self.root / "model-gateway.token"
        self.test_api_key = "test-only-secret-that-must-not-be-persisted"
        self.model_gateway_token.write_text("%s\n" % self.test_api_key, encoding="utf-8")
        self.model_gateway_token.chmod(0o600)
        os.environ.update({
            "OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace),
            "EVIMED_META_AGENT_ROOT": str(self.meta_root),
            "EVIMED_META_AGENT_PYTHON": sys.executable,
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(self.model_gateway_token),
            "EVIMED_MODEL_GATEWAY_URL": "https://api.deepseek.example",
            "EVIMED_MODEL_GATEWAY_MODEL": "deepseek-flash",
        })

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        self.temporary.cleanup()

    def wait_for_terminal(self, job_id):
        for _ in range(200):
            result = self.meta_agent.status_job({"jobId": job_id})
            if result["status"] != "warning" or result.get("data", {}).get("jobStatus") in {"succeeded", "blocked"}:
                return result
            time.sleep(0.025)
        self.fail("managed MetaAgent job did not reach a terminal state")

    def test_capabilities_fail_closed_without_an_operator_installation(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            result = self.meta_agent.call({"action": "capabilities"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "meta_agent_unconfigured")
        self.assertNotIn("data", result)

    def failed_phase_main(self, *, retryable=True, exit_code=75, phase_status="failed"):
        suffix = r'''
(project / "extraction").mkdir()
phase = {"schema_version":1,"phase":"extraction","status":PHASE_STATUS,
         "error_code":"extraction_incomplete","retryable":RETRYABLE}
(project / "extraction/extraction_status.json").write_text(json.dumps(phase))
(project / "package/release_decision.json").write_text(json.dumps({"status":"blocked",
    "phase":"extraction","phaseStatus":PHASE_STATUS,"retryable":RETRYABLE}))
print(os.environ.get("LLM_API_KEY"), flush=True)
raise SystemExit(EXIT_CODE)
'''.replace("RETRYABLE", repr(retryable)).replace("EXIT_CODE", str(exit_code)).replace("PHASE_STATUS", repr(phase_status))
        (self.meta_root / "new_meta/main.py").write_text(FAKE_MAIN + suffix)

    def test_typed_model_failure_preserves_retryability_and_only_diagnostic_artifacts(self):
        self.failed_phase_main()
        started = self.meta_agent.call({"action": "start", "topic": "Synthetic failed extraction"})
        result = self.wait_for_terminal(started["data"]["jobId"])
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertEqual(result["data"]["phaseStatus"], "failed")
        self.assertEqual(result["data"]["phase"], "extraction")
        self.assertEqual(result["error"]["code"], "meta_agent_execution_failed")
        self.assertEqual(result["data"]["phaseErrorCode"], "extraction_incomplete")
        self.assertTrue(result["error"]["retryable"])
        self.assertEqual([item["kind"] for item in result["artifacts"]], ["phase_diagnostic"])
        self.assertNotIn(self.test_api_key, json.dumps(result))

    def test_phase_exit_mismatch_cannot_become_blocked_success(self):
        self.failed_phase_main(exit_code=0)
        started = self.meta_agent.call({"action": "start", "topic": "Synthetic inconsistent phase"})
        result = self.wait_for_terminal(started["data"]["jobId"])
        self.assertEqual(result["data"]["jobStatus"], "failed")

    def test_typed_missing_data_remains_blocked_instead_of_service_failure(self):
        self.failed_phase_main(retryable=False, exit_code=2, phase_status="needs_input")
        started = self.meta_agent.call({"action": "start", "topic": "Synthetic missing study data"})
        result = self.wait_for_terminal(started["data"]["jobId"])
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["jobStatus"], "blocked")
        self.assertEqual(result["data"]["phaseStatus"], "needs_input")
        self.assertFalse(result["data"]["retryable"])
        self.assertEqual([item["kind"] for item in result["artifacts"]], ["phase_diagnostic"])

    def test_nonretryable_typed_failure_stays_nonretryable(self):
        self.failed_phase_main(retryable=False, exit_code=1)
        started = self.meta_agent.call({"action": "start", "topic": "Synthetic nonretryable source failure"})
        result = self.wait_for_terminal(started["data"]["jobId"])
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertFalse(result["error"]["retryable"])

    def test_dead_worker_retains_failed_phase_instead_of_reclassifying_release_as_blocked(self):
        self.failed_phase_main()
        started = self.meta_agent.call({"action": "start", "topic": "Synthetic failure recovery"})
        job_id = started["data"]["jobId"]
        self.wait_for_terminal(job_id)
        _, state_path, _ = self.meta_agent._job_paths(job_id)
        state = self.meta_agent._read_json_no_follow(state_path)
        state.update(status="running", workerPid=99999999)
        self.meta_agent._atomic_json(state_path, state)
        with mock.patch.object(self.meta_agent, "_worker_is_alive", return_value=False):
            result = self.meta_agent.status_job({"jobId": job_id})
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertTrue(result["error"]["retryable"])
        self.assertEqual(result["data"]["phaseStatus"], "failed")

    def test_phase_parent_symlink_cannot_supply_diagnostics(self):
        project = self.workspace / "phase-project"
        project.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "extraction_status.json").write_text(json.dumps({"schema_version":1,"phase":"extraction",
            "status":"failed","error_code":"extraction_incomplete","retryable":True}))
        (project / "extraction").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(self.meta_agent.MetaAgentError):
            self.meta_agent._incomplete_phase_state(self.workspace, project,
                {"status":"blocked","phase":"extraction","phaseStatus":"failed","retryable":True}, 75)

    def test_phase_failure_precedes_stale_ready_release_after_interruption(self):
        self.failed_phase_main()
        started = self.meta_agent.call({"action": "start", "topic": "Synthetic stale release recovery"})
        job_id = started["data"]["jobId"]
        self.wait_for_terminal(job_id)
        _, state_path, _ = self.meta_agent._job_paths(job_id)
        state = self.meta_agent._read_json_no_follow(state_path)
        project = self.workspace / state["projectRelativePath"]
        (project / "package/release_decision.json").write_text('{"status":"ready"}')
        state.update(status="running", workerPid=99999999)
        self.meta_agent._atomic_json(state_path, state)
        with mock.patch.object(self.meta_agent, "_worker_is_alive", return_value=False):
            result = self.meta_agent.status_job({"jobId": job_id})
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertEqual(result["data"]["phaseStatus"], "failed")
        self.assertTrue(result["error"]["retryable"])

    def test_a_missing_gateway_token_file_names_the_variable_that_is_unset(self):
        """MetaAgent read all three model facts out of the retired kernel's
        `opencode.json`, and that was its only path — under the kernel that
        writes no such file every managed run failed with
        `meta_model_config_unavailable` while a valid token sat on disk."""
        import public_sources

        for name in public_sources.GATEWAY_TOKEN_FILE_ENV_NAMES:
            os.environ.pop(name, None)
        result = self.meta_agent.call({"action": "capabilities"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "meta_model_config_unavailable")
        self.assertIn("EVIMED_MODEL_GATEWAY_TOKEN_FILE", result["error"]["message"])

    def test_a_configuration_file_is_not_mined_for_something_token_shaped(self):
        """The retired kernel carried the token under
        `provider.deepseek.options.apiKey`. Left in the token file's place it
        must be refused, not parsed."""
        stale = self.root / "opencode.json"
        stale.write_text(json.dumps({
            "provider": {"deepseek": {"options": {"apiKey": "the-retired-kernels-token"}}}
        }), encoding="utf-8")
        os.environ["EVIMED_MODEL_GATEWAY_TOKEN_FILE"] = str(stale)
        result = self.meta_agent.call({"action": "capabilities"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "meta_model_config_unavailable")
        self.assertNotIn("the-retired-kernels-token", json.dumps(result))

    def test_meta_python_preserves_virtual_environment_entry_point(self):
        virtual_python = self.meta_root / ".venv" / "bin" / "python"
        virtual_python.parent.mkdir(parents=True)
        virtual_python.symlink_to(sys.executable)
        os.environ.pop("EVIMED_META_AGENT_PYTHON", None)

        selected = self.meta_agent._meta_python(self.meta_root)

        self.assertEqual(selected, virtual_python)
        self.assertNotEqual(selected, virtual_python.resolve())

    def test_managed_job_uses_fixed_arguments_and_returns_workspace_artifacts(self):
        started = self.meta_agent.call({
            "action": "start",
            "topic": "Effect of intervention A versus B in adults",
            "outputLanguage": "zh",
            "maxPapers": 25,
            "analysisType": "pairwise",
        })
        self.assertEqual(started["status"], "warning")
        job_id = started["data"]["jobId"]
        terminal = self.wait_for_terminal(job_id)
        self.assertEqual(terminal["status"], "success")
        self.assertEqual(terminal["data"]["jobStatus"], "succeeded")
        self.assertEqual(terminal["data"]["releaseStatus"], "ready")
        self.assertTrue(terminal["artifacts"])
        self.assertTrue(all(not pathlib.PurePosixPath(item["path"]).is_absolute() for item in terminal["artifacts"]))

        project = self.workspace / terminal["data"]["projectPath"]
        invocation = json.loads((project / "invocation.json").read_text(encoding="utf-8"))
        self.assertEqual(invocation, {
            "topic": "Effect of intervention A versus B in adults",
            "model": "deepseek-flash",
            "run_mode": "review",
            "skip_confirm": True,
            "language": "zh",
            "max_papers": "25",
            "analysis_type": "pairwise",
            "llm_model": "deepseek-flash",
            "thinking": "true",
            "reasoning_effort": "high",
            "api_key_present": True,
        })
        state_file = self.workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
        state_text = state_file.read_text(encoding="utf-8")
        log_text = state_file.with_suffix(".log").read_text(encoding="utf-8")
        self.assertNotIn(self.test_api_key, state_text)
        self.assertNotIn(self.test_api_key, log_text)
        state = json.loads(state_text)
        self.assertEqual(state["executionEvidence"], self.meta_agent._execution_evidence(self.meta_root))

    def test_workspace_relative_inputs_cannot_escape_the_project(self):
        outside = self.root / "outside.json"
        outside.write_text("{}", encoding="utf-8")
        result = self.meta_agent.call({
            "action": "start",
            "topic": "Traversal must fail",
            "ipdData": "../outside.json",
        })
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "meta_input_path_invalid")
        self.assertFalse((self.workspace / "meta-analysis-runs" / ".jobs").exists())

    def test_release_gate_exit_two_is_completed_but_not_submission_ready(self):
        main_file = self.meta_root / "new_meta" / "main.py"
        blocked_main = FAKE_MAIN.replace('"status": "ready"', '"status": "blocked"')
        main_file.write_text(blocked_main + "\nraise SystemExit(2)\n", encoding="utf-8")

        started = self.meta_agent.call({
            "action": "start",
            "topic": "Sparse evidence must retain diagnostic artifacts",
        })
        terminal = self.wait_for_terminal(started["data"]["jobId"])

        self.assertEqual(terminal["status"], "warning")
        self.assertEqual(terminal["data"]["jobStatus"], "blocked")
        self.assertEqual(terminal["data"]["releaseStatus"], "blocked")
        self.assertTrue(terminal["artifacts"])

    def test_workspace_relative_inputs_reject_symbolic_links(self):
        real = self.workspace / "real"
        real.mkdir()
        (self.workspace / "linked").symlink_to(real, target_is_directory=True)
        result = self.meta_agent.call({
            "action": "start",
            "topic": "Symlink input must fail",
            "userPdfDirectory": "linked",
        })
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "meta_input_path_invalid")
        self.assertFalse((self.workspace / "meta-analysis-runs" / ".jobs").exists())

    def test_failed_status_preserves_terminal_job_state_for_pollers(self):
        job_id = "meta-20260718120000-abcdef123456"
        jobs = self.workspace / "meta-analysis-runs" / ".jobs"
        jobs.mkdir(parents=True)
        (jobs / f"{job_id}.json").write_text(
            json.dumps({
                "jobId": job_id,
                "status": "failed",
                "updatedAt": "2026-07-18T04:00:00Z",
                "error": "upstream model unavailable",
                "retryable": True,
            }),
            encoding="utf-8",
        )

        result = self.meta_agent.status_job({"jobId": job_id})

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertEqual(result["data"]["jobId"], job_id)

    def test_dead_worker_recovers_a_blocked_release_from_workspace_evidence(self):
        job_id = "meta-20260718120001-abcdef123456"
        jobs = self.workspace / "meta-analysis-runs" / ".jobs"
        output_root = self.workspace / "meta-analysis-runs" / job_id / "output"
        project = output_root / "recovered-project"
        (project / "package").mkdir(parents=True)
        (project / "analysis").mkdir()
        (project / "package" / "release_decision.json").write_text(
            json.dumps({"status": "blocked", "next_actions": ["Supply eligible full text."]}),
            encoding="utf-8",
        )
        (project / "package" / "metaagent_export.zip").write_bytes(b"PK-test")
        (project / "analysis" / "meta_analysis.json").write_text("{}", encoding="utf-8")
        jobs.mkdir(parents=True)
        state_file = jobs / f"{job_id}.json"
        state_file.write_text(json.dumps({
            "jobId": job_id,
            "status": "running",
            "workerPid": 99999999,
            "workspace": str(self.workspace),
            "outputRoot": str(output_root),
            "updatedAt": "2026-07-18T04:00:00Z",
        }), encoding="utf-8")

        result = self.meta_agent.status_job({"jobId": job_id})

        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["jobStatus"], "blocked")
        self.assertEqual(result["data"]["releaseStatus"], "blocked")
        self.assertTrue(result["artifacts"])
        recovered = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertTrue(recovered["recoveredTerminalState"])

    def test_dead_worker_without_release_evidence_becomes_retryable_failure(self):
        job_id = "meta-20260718120002-abcdef123456"
        jobs = self.workspace / "meta-analysis-runs" / ".jobs"
        output_root = self.workspace / "meta-analysis-runs" / job_id / "output"
        output_root.mkdir(parents=True)
        jobs.mkdir(parents=True)
        (jobs / f"{job_id}.json").write_text(json.dumps({
            "jobId": job_id,
            "status": "running",
            "workerPid": 99999999,
            "workspace": str(self.workspace),
            "outputRoot": str(output_root),
            "updatedAt": "2026-07-18T04:00:00Z",
        }), encoding="utf-8")

        result = self.meta_agent.status_job({"jobId": job_id})

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["data"]["jobStatus"], "failed")
        self.assertTrue(result["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
