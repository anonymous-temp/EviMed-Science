"""The managed bridge must be reachable, resumable, and honest about status.

R061: the MCP tool schema carries waitSeconds and forwards it verbatim, so a
request model with extra="forbid" turned every status poll into a 422.
R062: a blocked capability exited 1 and lost its narrower scope in a log tail;
releaseStatus was reported without its vocabulary; neither bridge passed
--resume, so a killed job restarted from step 1.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from new_meta import evimed_adapter
from new_meta.core.method_planning import MethodCapabilityBlockedError
from new_meta.core.project import Project
from new_meta.core.release_contract import ReleaseStatus

SECRET = "test-only-evimed-workload-signing-secret-32-bytes"


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).decode().rstrip("=")


def _token() -> str:
    now = int(time.time())
    header = _b64({"alg": "HS256", "typ": "JWT"})
    body = _b64({
        "v": 1, "aud": "evimed-adapter", "userId": "user-1", "projectId": "project-1",
        "iat": now - 1, "exp": now + 300, "jti": "test-jti-1",
    })
    signed = f"{header}.{body}"
    signature = base64.urlsafe_b64encode(
        hmac.new(SECRET.encode(), signed.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return f"{signed}.{signature}"


def _fixture(tmp_path: Path, monkeypatch) -> tuple[TestClient, Path]:
    workspace = tmp_path / "users" / "user-1" / "projects" / "project-1" / "workspace"
    workspace.mkdir(parents=True)
    (workspace.parent / "project.json").write_text(
        json.dumps({"id": "project-1", "activeWorkspace": ""}), encoding="utf-8"
    )
    monkeypatch.setenv("EVIMED_WORKLOAD_SIGNING_SECRET", SECRET)
    monkeypatch.setenv("LLM_API_KEY", "test-key-never-persist")
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-pro")
    monkeypatch.setenv("LLM_ENABLE_THINKING", "true")
    app = FastAPI()
    app.include_router(evimed_adapter.create_evimed_adapter_router(tmp_path))
    return TestClient(app), workspace


def _post(client: TestClient, body: dict):
    return client.post(
        "/api/v1/evimed/meta-analysis",
        json=body,
        headers={"Authorization": f"Bearer {_token()}"},
    )


def _start(client, monkeypatch) -> str:
    class Worker:
        pid = 12345

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kw: Worker())
    started = _post(client, {"action": "start", "topic": "A versus B for C in adults"})
    assert started.status_code == 200
    return started.json()["data"]["jobId"]


# --------------------------------------------------------------------- R061

def test_a_status_poll_carrying_waitSeconds_is_not_a_422(tmp_path, monkeypatch):
    client, _ = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    response = _post(client, {"action": "status", "jobId": job_id, "waitSeconds": 0})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["jobId"] == job_id


def test_waitSeconds_is_bounded_and_still_rejects_nonsense(tmp_path, monkeypatch):
    client, _ = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    too_long = _post(client, {
        "action": "status", "jobId": job_id,
        "waitSeconds": evimed_adapter.MAX_STATUS_WAIT_SECONDS + 1,
    })
    assert too_long.status_code == 422
    negative = _post(client, {"action": "status", "jobId": job_id, "waitSeconds": -1})
    assert negative.status_code == 422


def test_unknown_fields_are_still_refused(tmp_path, monkeypatch):
    client, _ = _fixture(tmp_path, monkeypatch)
    assert _post(client, {
        "action": "start", "topic": "Valid topic", "command": "rm -rf /",
    }).status_code == 422


def test_a_bounded_wait_returns_the_terminal_state_it_waited_for(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["status"] = "running"
    state["workerPid"] = evimed_adapter.os.getpid()
    state_path.write_text(json.dumps(state), encoding="utf-8")

    reads = {"n": 0}
    real_read = evimed_adapter._read_state

    def finishing_read(path):
        reads["n"] += 1
        payload = real_read(path)
        if reads["n"] >= 2:
            payload["status"] = "succeeded"
            payload["releaseStatus"] = "ready_with_warnings"
            payload["projectRelativePath"] = "meta-analysis-runs/x/output/p"
        return payload

    monkeypatch.setattr(evimed_adapter, "_read_state", finishing_read)
    monkeypatch.setattr(evimed_adapter.time, "sleep", lambda _s: None)

    response = _post(client, {"action": "status", "jobId": job_id, "waitSeconds": 5})
    assert response.status_code == 200
    assert response.json()["data"]["jobStatus"] == "succeeded"


# --------------------------------------------------------------------- R062

def test_the_release_status_vocabulary_is_the_engines():
    assert evimed_adapter.RELEASE_STATUSES == tuple(
        status.value for status in ReleaseStatus
    )


def test_ready_with_warnings_is_reported_as_itself(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state.update({
        "status": "succeeded",
        "releaseStatus": "ready_with_warnings",
        "projectRelativePath": "meta-analysis-runs/x/output/p",
    })
    state_path.write_text(json.dumps(state), encoding="utf-8")

    body = _post(client, {"action": "status", "jobId": job_id}).json()
    assert body["data"]["releaseStatus"] == "ready_with_warnings"
    assert body["data"]["releaseStatusVocabulary"] == list(evimed_adapter.RELEASE_STATUSES)


def test_a_status_outside_the_vocabulary_is_named_not_folded_in(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state.update({
        "status": "succeeded",
        "releaseStatus": "review_required",
        "projectRelativePath": "meta-analysis-runs/x/output/p",
    })
    state_path.write_text(json.dumps(state), encoding="utf-8")

    body = _post(client, {"action": "status", "jobId": job_id}).json()
    assert body["data"]["releaseStatus"] == "unrecognized:review_required"


def test_a_worker_that_died_does_not_leave_a_job_running_forever(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state.update({"status": "running", "workerPid": 999999})
    state_path.write_text(json.dumps(state), encoding="utf-8")

    body = _post(client, {"action": "status", "jobId": job_id}).json()
    assert body["error"]["code"] == "meta_agent_execution_failed"
    assert body["error"]["retryable"] is True


def test_a_blocked_capability_carries_its_narrower_scope():
    from new_meta.schemas.method_policy import CapabilityStatus, MethodPlan, ReviewFamily

    plan = MethodPlan(
        review_id="rid",
        family=ReviewFamily.DIAGNOSTIC_ACCURACY,
        policy_version="1",
        capability_status=CapabilityStatus.BLOCKED,
        plan_fingerprint="fp",
        effect_measure="OR",
        primary_estimator="reitsma",
        risk_of_bias_tool="QUADAS-2",
        certainty_framework="GRADE",
        engine_entrypoint="dta",
        validation_reference="ref",
        capability_id="diagnostic_accuracy.two_gate",
        execution_allowed=False,
        blocking_reasons=["two_gate_design_not_validated"],
    )
    decision = MethodCapabilityBlockedError(plan).release_decision()
    assert decision["status"] == ReleaseStatus.BLOCKED.value
    assert decision["blocker_codes"] == ["two_gate_design_not_validated"]
    assert decision["narrower_capability"]["capability_id"] == "diagnostic_accuracy.two_gate"
    assert decision["next_actions"]


def test_main_maps_a_blocked_capability_to_exit_2():
    source = Path("new_meta/main.py").read_text(encoding="utf-8")
    tail = source[source.index('if __name__ == "__main__":'):]
    assert "MethodCapabilityBlockedError" in tail
    block = tail[tail.index("if isinstance(exc, MethodCapabilityBlockedError):"):]
    assert "release_decision()" in block
    assert "persist_release_decision" in block
    assert "sys.exit(2)" in block


def test_the_adapter_passes_resume_when_a_checkpoint_survives(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    output_root = Path(state["outputRoot"])
    previous = output_root / "20260909_120000_topic"
    previous.mkdir(parents=True)
    (previous / ".checkpoint").write_text(
        json.dumps({"schema_version": 2, "topic_fingerprint": "x", "completed": ["search"]}),
        encoding="utf-8",
    )

    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        project = output_root / "20260909_120000_topic"
        (project / "package").mkdir(parents=True, exist_ok=True)
        (project / "package" / "release_decision.json").write_text(
            json.dumps({"status": "ready", "next_actions": []}), encoding="utf-8"
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", fake_run)
    assert evimed_adapter.run_job(str(state_path)) == 0
    assert "--resume" in captured["command"]
    assert captured["command"][captured["command"].index("--resume") + 1] == str(previous)


def test_a_first_attempt_does_not_pass_resume(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    output_root = Path(state["outputRoot"])

    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        project = output_root / "fresh"
        (project / "package").mkdir(parents=True, exist_ok=True)
        (project / "package" / "release_decision.json").write_text(
            json.dumps({"status": "ready", "next_actions": []}), encoding="utf-8"
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", fake_run)
    assert evimed_adapter.run_job(str(state_path)) == 0
    assert "--resume" not in captured["command"]


def test_blocking_reasons_reach_the_caller(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    output_root = Path(state["outputRoot"])

    def fake_run(command, **kwargs):
        project = output_root / "blocked-project"
        (project / "package").mkdir(parents=True, exist_ok=True)
        (project / "package" / "release_decision.json").write_text(
            json.dumps({
                "status": "blocked",
                "blocker_codes": ["two_gate_design_not_validated"],
                "next_actions": ["Narrow the review."],
            }),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", fake_run)
    assert evimed_adapter.run_job(str(state_path)) == 0

    body = _post(client, {"action": "status", "jobId": job_id}).json()
    assert body["data"]["releaseStatus"] == "blocked"
    assert body["data"]["blockingReasons"] == ["two_gate_design_not_validated"]


# ------------------------------------------------- checkpoint (resume basis)

def test_the_checkpoint_is_written_atomically_and_bound_to_its_topic(tmp_path):
    project = Project("Tranexamic acid in total knee arthroplasty", output_dir=tmp_path)
    project.save_checkpoint("search")
    payload = json.loads((project.base_dir / ".checkpoint").read_text(encoding="utf-8"))
    assert payload["schema_version"] == 2
    assert payload["completed"] == ["search"]
    assert payload["topic_fingerprint"] == project.topic_fingerprint()
    assert not list(project.base_dir.glob("*.tmp"))


def test_a_checkpoint_from_another_project_is_refused(tmp_path):
    """The project's own topic is recorded on disk when its directory is made,
    because resume entry points construct Project with a placeholder label.
    A checkpoint whose fingerprint names a different topic is another run's."""
    one = Project("Topic one", output_dir=tmp_path)
    one.save_checkpoint("search")
    two = Project("A completely different topic", output_dir=tmp_path)
    two.save_checkpoint("search")

    # A checkpoint copied across projects, which is what the check is for.
    (one.base_dir / ".checkpoint").write_text(
        (two.base_dir / ".checkpoint").read_text(encoding="utf-8"), encoding="utf-8"
    )
    with pytest.raises(RuntimeError, match="different topic"):
        Project("resume project", resume_dir=one.base_dir).get_completed_steps()


def test_resuming_the_same_project_with_a_placeholder_label_still_works(tmp_path):
    project = Project("Tranexamic acid in total knee arthroplasty", output_dir=tmp_path)
    project.save_checkpoint("search")
    resumed = Project("resume project", resume_dir=project.base_dir)
    assert resumed.get_completed_steps() == ["search"]
    assert resumed.topic_fingerprint() == project.topic_fingerprint()


def test_a_legacy_bare_list_checkpoint_is_still_readable(tmp_path):
    project = Project("Topic one", output_dir=tmp_path)
    (project.base_dir / ".checkpoint").write_text(json.dumps(["search"]), encoding="utf-8")
    assert project.get_completed_steps() == ["search"]


# ------------------------------------------------- module ledger (class D)

def test_pipeline_warnings_become_a_module_ledger(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "pipeline_warnings.json").write_text(json.dumps([
        {"stage": "figures", "code": "forest_plot_failed",
         "severity": "warning", "message": "matplotlib backend unavailable"},
        {"stage": "grade", "code": "grade_failed",
         "severity": "warning", "message": "certainty rating did not complete"},
        {"stage": "extraction", "code": "low_parse_rate",
         "severity": "warning", "message": "only 3 of 40 PDFs parsed"},
    ]), encoding="utf-8")

    modules = evimed_adapter._module_ledger(project)
    assert modules["figures"]["status"] == "degraded"
    assert "forest_plot_failed" in modules["figures"]["reason"]
    assert modules["grade"]["status"] == "degraded"
    # Extraction changes what the manuscript means, so it is not a degradation.
    assert modules["extraction"]["status"] == "failed"
    assert modules["extraction"]["fatal"] is True


def test_several_warnings_from_one_stage_are_merged(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "pipeline_warnings.json").write_text(json.dumps([
        {"stage": "figures", "code": "forest_plot_failed", "message": "a"},
        {"stage": "figures", "code": "funnel_plot_failed", "message": "b"},
    ]), encoding="utf-8")
    modules = evimed_adapter._module_ledger(project)
    assert "forest_plot_failed" in modules["figures"]["reason"]
    assert "funnel_plot_failed" in modules["figures"]["reason"]


def test_a_project_with_no_warnings_has_an_empty_ledger(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    assert evimed_adapter._module_ledger(project) == {}


def test_the_status_response_carries_the_ledger(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    job_id = _start(client, monkeypatch)
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    output_root = Path(state["outputRoot"])

    def fake_run(command, **kwargs):
        project = output_root / "degraded-project"
        (project / "package").mkdir(parents=True, exist_ok=True)
        (project / "package" / "release_decision.json").write_text(
            json.dumps({"status": "ready_with_warnings", "next_actions": []}),
            encoding="utf-8",
        )
        (project / "pipeline_warnings.json").write_text(json.dumps([
            {"stage": "figures", "code": "forest_plot_failed", "message": "no backend"},
        ]), encoding="utf-8")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", fake_run)
    assert evimed_adapter.run_job(str(state_path)) == 0

    body = _post(client, {"action": "status", "jobId": job_id}).json()
    assert body["data"]["degraded"] is True
    assert body["data"]["modules"]["figures"]["status"] == "degraded"
