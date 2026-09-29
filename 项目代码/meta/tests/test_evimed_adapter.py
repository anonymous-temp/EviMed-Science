from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from new_meta import evimed_adapter


SECRET = "test-only-evimed-workload-signing-secret-32-bytes"


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def _token(*, user: str = "user-1", project: str = "project-1", expires: int | None = None) -> str:
    now = int(time.time())
    header = _b64({"alg": "HS256", "typ": "JWT"})
    body = _b64({
        "v": 1,
        "aud": "evimed-adapter",
        "userId": user,
        "projectId": project,
        "iat": now - 1,
        "exp": expires if expires is not None else now + 300,
        "jti": "test-jti-1",
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
        json.dumps({"id": "project-1", "activeWorkspace": ""}),
        encoding="utf-8",
    )
    monkeypatch.setenv("EVIMED_WORKLOAD_SIGNING_SECRET", SECRET)
    monkeypatch.setenv("LLM_API_KEY", "test-key-never-persist")
    monkeypatch.setenv("LLM_MODEL", "deepseek-flash")
    monkeypatch.setenv("LLM_ENABLE_THINKING", "true")
    app = FastAPI()
    app.include_router(evimed_adapter.create_evimed_adapter_router(tmp_path))
    return TestClient(app), workspace


def _post(client: TestClient, body: dict, token: str | None = None):
    headers = {"Authorization": f"Bearer {token or _token()}"}
    return client.post("/api/v1/evimed/meta-analysis", json=body, headers=headers)


def test_adapter_requires_a_valid_scoped_workload_token(tmp_path, monkeypatch) -> None:
    client, _ = _fixture(tmp_path, monkeypatch)
    missing = client.post("/api/v1/evimed/meta-analysis", json={"action": "capabilities"})
    wrong = _post(client, {"action": "capabilities"}, token=_token()[:-1] + "x")
    expired = _post(client, {"action": "capabilities"}, token=_token(expires=int(time.time()) - 1))
    accepted = _post(client, {"action": "capabilities"})

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert expired.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["data"] == {
        "available": True,
        "model": "deepseek-flash",
        "thinking": True,
    }


def test_managed_job_uses_fixed_cli_and_returns_only_workspace_relative_artifacts(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)

    class Worker:
        pid = 12345

        def wait(self, timeout=None):
            return 0

    launched = []

    def fake_popen(command, **kwargs):
        launched.append((command, kwargs))
        return Worker()

    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", fake_popen)
    started = _post(client, {
        "action": "start",
        "topic": "Intervention A versus B for outcome C in adults",
        "outputLanguage": "zh",
        "maxPapers": 20,
        "analysisType": "pairwise",
    })
    assert started.status_code == 200
    assert started.json()["status"] == "warning"
    job_id = started.json()["data"]["jobId"]
    assert launched[0][0][:3] == [
        evimed_adapter.sys.executable,
        "-m",
        "new_meta.evimed_adapter",
    ]
    assert launched[0][1]["stdin"] is evimed_adapter.subprocess.DEVNULL

    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state_text = state_file.read_text(encoding="utf-8")
    assert "test-key-never-persist" not in state_text

    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        output_root = Path(command[command.index("--output-dir") + 1])
        project = output_root / "measured-project"
        (project / "manuscript").mkdir(parents=True)
        (project / "package").mkdir(parents=True)
        (project / "analysis").mkdir(parents=True)
        (project / "manuscript" / "draft.md").write_text("# Result\n", encoding="utf-8")
        (project / "manuscript" / "draft.pdf").write_bytes(b"%PDF-test")
        (project / "package" / "metaagent_export.zip").write_bytes(b"PK-test")
        (project / "package" / "release_decision.json").write_text(
            json.dumps({"status": "ready", "next_actions": []}),
            encoding="utf-8",
        )
        # The compiled route's pooled result; "meta_analysis.json" was listed
        # by the adapter but never written by any route.
        (project / "analysis" / "synthesis_result.json").write_text("{}", encoding="utf-8")
        (project / "prisma_flow.json").write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", fake_run)
    assert evimed_adapter.run_job(str(state_file)) == 0
    assert captured["command"][:3] == [evimed_adapter.sys.executable, "-m", "new_meta.main"]
    assert captured["command"][captured["command"].index("--model") + 1] == "deepseek-flash"
    assert "--skip-confirm" in captured["command"]
    assert captured["command"][captured["command"].index("--run-mode") + 1] == "review"

    terminal = _post(client, {"action": "status", "jobId": job_id})
    assert terminal.status_code == 200
    body = terminal.json()
    assert body["status"] == "success"
    assert body["data"]["releaseStatus"] == "ready"
    assert body["artifacts"]
    assert all(not Path(item["path"]).is_absolute() for item in body["artifacts"])
    assert {item["path"].rsplit("/", 1)[-1] for item in body["artifacts"] if item["kind"] in {"analysis", "prisma_flow"}} == {
        "synthesis_result.json", "prisma_flow.json"}


def test_release_blocked_exit_preserves_evidence_gap_artifacts(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)

    class Worker:
        pid = 12346

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: Worker())
    started = _post(client, {
        "action": "start",
        "topic": "Sparse evidence topic",
        "maxPapers": 10,
    })
    job_id = started.json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"

    def blocked_run(command, **kwargs):
        output_root = Path(command[command.index("--output-dir") + 1])
        project = output_root / "evidence-gap-project"
        (project / "manuscript").mkdir(parents=True)
        (project / "package").mkdir(parents=True)
        (project / "manuscript" / "draft.md").write_text("# Evidence gap\n", encoding="utf-8")
        (project / "package" / "metaagent_export.zip").write_bytes(b"PK-gap")
        (project / "package" / "release_decision.json").write_text(
            json.dumps({
                "status": "blocked",
                "next_actions": ["Add eligible primary studies before publication."],
            }),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", blocked_run)
    assert evimed_adapter.run_job(str(state_file)) == 0
    state = json.loads(state_file.read_text(encoding="utf-8"))
    assert state["status"] == "succeeded"
    assert state["returnCode"] == 2
    assert state["releaseStatus"] == "blocked"

    terminal = _post(client, {"action": "status", "jobId": job_id}).json()
    assert terminal["status"] == "warning"
    assert terminal["data"]["jobStatus"] == "succeeded"
    assert terminal["data"]["releaseStatus"] == "blocked"
    assert terminal["artifacts"]
    assert terminal["next_actions"] == ["Add eligible primary studies before publication."]


def test_tenant_scope_and_symlink_boundaries_fail_closed(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    other = _post(client, {"action": "capabilities"}, token=_token(project="project-2"))
    assert other.status_code == 404

    outside = tmp_path / "outside"
    outside.mkdir()
    (workspace / "linked").symlink_to(outside, target_is_directory=True)
    linked = _post(client, {
        "action": "start",
        "topic": "Symlink input must fail",
        "userPdfDirectory": "linked",
    })
    assert linked.status_code == 200
    assert linked.json()["error"]["code"] == "meta_input_path_invalid"


def test_request_contract_rejects_shell_and_unknown_fields(tmp_path, monkeypatch) -> None:
    client, _ = _fixture(tmp_path, monkeypatch)
    response = _post(client, {
        "action": "start",
        "topic": "Valid topic",
        "command": "rm -rf /",
    })
    assert response.status_code == 422


def test_boolean_time_claims_and_invalid_key_files_fail_closed(tmp_path, monkeypatch) -> None:
    client, _ = _fixture(tmp_path, monkeypatch)
    now = int(time.time())
    header = _b64({"alg": "HS256", "typ": "JWT"})
    body = _b64({
        "v": 1,
        "aud": "evimed-adapter",
        "userId": "user-1",
        "projectId": "project-1",
        "iat": True,
        "exp": now + 300,
        "jti": "test-jti-1",
    })
    signed = f"{header}.{body}"
    signature = base64.urlsafe_b64encode(
        hmac.new(SECRET.encode(), signed.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    rejected = _post(client, {"action": "capabilities"}, token=f"{signed}.{signature}")
    assert rejected.status_code == 401

    monkeypatch.delenv("LLM_API_KEY")
    key_file = tmp_path / "invalid-key"
    key_file.write_text("bad\nkey", encoding="utf-8")
    monkeypatch.setenv("LLM_API_KEY_FILE", str(key_file))
    unavailable = _post(client, {"action": "capabilities"})
    assert unavailable.status_code == 200
    assert unavailable.json()["error"]["code"] == "meta_model_config_unavailable"


def test_a_running_job_advances_while_metaagent_works(tmp_path, monkeypatch) -> None:
    """Written only at start and at the end, a job hours into retrieval looked
    exactly like one whose worker had died (the research-topic incident of
    2026-09-27 was the same shape): the state advances while the engine works."""
    client, workspace = _fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(evimed_adapter, "_HEARTBEAT_SECONDS", 0.05)

    class Worker:
        pid = 12347

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: Worker())
    job_id = _post(client, {"action": "start", "topic": "Heartbeat topic"}).json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    observed = {}

    def working_run(command, **kwargs):
        output_root = Path(command[command.index("--output-dir") + 1])
        project = output_root / "working-project"
        project.mkdir(parents=True)
        (project / "step_manifest.json").write_text(json.dumps({
            "schema_version": 1,
            "pipeline_steps": ["protocol", "search_query", "search", "ta_screening"],
            "steps": {"protocol": {"status": "complete"}, "search_query": {"status": "complete"}},
        }), encoding="utf-8")
        first = json.loads(state_file.read_text(encoding="utf-8"))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            if state["updatedAt"] != first["updatedAt"] and state.get("progress"):
                observed["state"] = state
                break
            time.sleep(0.02)
        observed["status"] = _post(client, {"action": "status", "jobId": job_id}).json()
        (project / "package").mkdir()
        (project / "package" / "release_decision.json").write_text(
            json.dumps({"status": "ready", "next_actions": []}), encoding="utf-8"
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", working_run)
    assert evimed_adapter.run_job(str(state_file)) == 0

    assert "state" in observed, "updatedAt stayed at the worker's start while MetaAgent worked"
    assert observed["state"]["progress"] == {"stage": "search", "percent": 50}
    data = observed["status"]["data"]
    assert data["jobStatus"] == "running"
    assert data["progress"] == {"stage": "search", "percent": 50}
    assert 0 <= data["secondsSinceUpdate"] <= 5
    assert isinstance(data["elapsedSeconds"], int) and "heartbeatSeconds" in data

    terminal = json.loads(state_file.read_text(encoding="utf-8"))
    time.sleep(0.2)
    assert json.loads(state_file.read_text(encoding="utf-8")) == terminal, "a beat after the terminal write"
    assert terminal["status"] == "succeeded"
    finished = _post(client, {"action": "status", "jobId": job_id}).json()
    assert isinstance(finished["data"]["elapsedSeconds"], int)


class _LiveWorker:
    """A worker that is still running as far as the adapter can tell."""

    pid = 4242

    def poll(self):
        return None

    def wait(self, timeout=None):
        return 0


def _launches(monkeypatch) -> list:
    launched = []

    def fake_popen(command, **kwargs):
        launched.append(command)
        return _LiveWorker()

    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", fake_popen)
    evimed_adapter._WORKERS.clear()
    return launched


def _mark(state_file: Path, **fields) -> dict:
    state = json.loads(state_file.read_text(encoding="utf-8"))
    state.update(fields)
    state_file.write_text(json.dumps(state), encoding="utf-8")
    return state


def test_the_same_request_while_its_job_runs_is_that_job(tmp_path, monkeypatch) -> None:
    """ma-001 (2026-09-09): a second job started while the first was still
    extracting. The same request now returns the running job, counted."""
    client, workspace = _fixture(tmp_path, monkeypatch)
    launched = _launches(monkeypatch)
    request = {"action": "start", "topic": "TXA  in primary TKA", "outputLanguage": "zh", "maxPapers": 40}
    job_id = _post(client, request).json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = _mark(state_file, status="running", workerPid=evimed_adapter.os.getpid())

    # Whitespace in the topic does not make it a different review.
    again = _post(client, {**request, "topic": "TXA in primary TKA"}).json()
    assert len(launched) == 1
    assert again["status"] == "warning"
    assert again["data"]["jobId"] == job_id
    assert again["data"]["reused"] is True
    assert again["data"]["jobStatus"] == "running"
    assert again["data"]["startRequests"] == 2
    assert json.loads(state_file.read_text(encoding="utf-8")) == state, "a reuse must not write a live job's state"


def test_a_different_request_while_one_runs_is_refused_with_the_running_job(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    launched = _launches(monkeypatch)
    job_id = _post(client, {"action": "start", "topic": "Review one"}).json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    _mark(state_file, status="running", workerPid=evimed_adapter.os.getpid())

    refused = _post(client, {"action": "start", "topic": "Review two"}).json()
    assert refused["status"] == "error"
    assert refused["error"]["code"] == "meta_job_already_running"
    assert job_id in refused["error"]["message"]
    assert "data" not in refused
    assert len(launched) == 1

    monkeypatch.setenv("EVIMED_META_MAX_ACTIVE_JOBS", "2")
    allowed = _post(client, {"action": "start", "topic": "Review two"}).json()
    assert allowed["status"] == "warning" and allowed["data"]["jobId"] != job_id
    assert len(launched) == 2


def test_a_dead_worker_does_not_hold_the_slot_and_its_request_resumes_from_its_checkpoint(tmp_path, monkeypatch) -> None:
    """A worker killed mid-review (a release recreates the container) left a
    job that read "running" and a restart from step 1. The same request now
    resumes the same job from its checkpoint, and the failure it reports names
    what was already done."""
    client, workspace = _fixture(tmp_path, monkeypatch)
    launched = _launches(monkeypatch)
    request = {"action": "start", "topic": "Resumable review"}
    job_id = _post(client, request).json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    project = workspace / "meta-analysis-runs" / job_id / "output" / "project"
    (project / "extraction").mkdir(parents=True)
    (project / ".checkpoint").write_text("{}", encoding="utf-8")
    (project / "protocol.json").write_text("{}", encoding="utf-8")
    (project / "extraction" / "all_extractions.json").write_text("[]", encoding="utf-8")
    (project / "step_manifest.json").write_text(json.dumps({
        "pipeline_steps": ["protocol", "search", "extraction", "manuscript"],
        "steps": {"protocol": {"status": "complete"}, "search": {"status": "complete"}},
    }), encoding="utf-8")
    _mark(state_file, status="running", workerPid=2_000_000_000)  # no such process
    evimed_adapter._WORKERS.clear()

    failed = _post(client, {"action": "status", "jobId": job_id}).json()
    assert failed["status"] == "error"
    assert failed["error"]["code"] == "meta_agent_execution_failed"
    assert failed["error"]["retryable"] is True
    assert "protocol, search" in failed["error"]["message"]
    kept = {item["path"] for item in failed["artifacts"]}
    assert f"meta-analysis-runs/{job_id}/output/project/extraction/all_extractions.json" in kept
    assert all(not Path(path).is_absolute() for path in kept)
    assert "same request" in failed["next_actions"][0]

    resumed = _post(client, request).json()
    assert resumed["status"] == "warning"
    assert resumed["data"]["jobId"] == job_id
    assert resumed["data"]["resumed"] is True
    assert resumed["data"]["completedSteps"] == ["protocol", "search"]
    assert len(launched) == 2 and launched[1][-1] == str(state_file)
    requeued = json.loads(state_file.read_text(encoding="utf-8"))
    assert requeued["status"] == "queued" and "error" not in requeued
    assert requeued["previousError"].startswith("MetaAgent worker exited")


def test_a_request_that_keeps_failing_stops_being_resumed(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    launched = _launches(monkeypatch)
    request = {"action": "start", "topic": "Failing review"}
    job_id = _post(client, request).json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    project = workspace / "meta-analysis-runs" / job_id / "output" / "project"
    project.mkdir(parents=True)
    (project / ".checkpoint").write_text("{}", encoding="utf-8")
    _mark(state_file, status="failed", attempts=2, error="MetaAgent exited with code 1.")
    evimed_adapter._WORKERS.clear()

    exhausted = _post(client, request).json()
    assert exhausted["status"] == "error"
    assert exhausted["error"]["code"] == "meta_job_attempts_exhausted"
    assert "code 1" in exhausted["error"]["message"]
    assert len(launched) == 1


def test_a_finished_request_returns_its_job_instead_of_running_again(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    launched = _launches(monkeypatch)
    request = {"action": "start", "topic": "Finished review", "outputLanguage": "en"}
    job_id = _post(client, request).json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    _mark(state_file, status="succeeded", releaseStatus="ready")
    evimed_adapter._WORKERS.clear()

    again = _post(client, request).json()
    assert again["data"] == {"jobId": job_id, "jobStatus": "succeeded", "reused": True, "startRequests": 2}
    other_language = _post(client, {**request, "outputLanguage": "zh"}).json()
    assert other_language["data"]["jobId"] != job_id
    assert len(launched) == 2


def test_a_blocked_job_is_the_answer_and_is_never_run_again(tmp_path, monkeypatch) -> None:
    """A terminal decision is the answer to its request (2026-09-29).

    Until then a job refused part-way (checkpoint short of the manuscript) was
    resumed by the identical request; production 0928b resumed one and was
    refused again at the same step. Blocked before or after its manuscript,
    the identical request now returns the job and launches nothing.
    """
    client, workspace = _fixture(tmp_path, monkeypatch)
    launched = _launches(monkeypatch)
    request = {"action": "start", "topic": "Blocked part-way"}
    job_id = _post(client, request).json()["data"]["jobId"]
    state_file = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    project = workspace / "meta-analysis-runs" / job_id / "output" / "project"
    project.mkdir(parents=True)
    checkpoint = project / ".checkpoint"
    for completed, return_code in (
        (["protocol", "search", "ft_screening"], 2),        # refused before its manuscript
        (["protocol", "figures", "manuscript"], 0),         # a written, blocked package
    ):
        checkpoint.write_text(json.dumps({"schema_version": 2, "completed": completed}), encoding="utf-8")
        _mark(state_file, status="succeeded", releaseStatus="blocked", returnCode=return_code,
              blockingReasons=["protocol_method_input_required"])
        evimed_adapter._WORKERS.clear()
        again = _post(client, request).json()
        assert again["data"]["jobId"] == job_id
        assert again["data"]["reused"] is True and again["data"]["jobStatus"] == "succeeded"
        assert "resumed" not in again["data"]
        assert len(launched) == 1
        assert json.loads(state_file.read_text(encoding="utf-8"))["releaseStatus"] == "blocked"

