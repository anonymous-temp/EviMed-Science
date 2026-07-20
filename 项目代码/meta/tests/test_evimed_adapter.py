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
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-pro")
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
        "model": "deepseek-v4-pro",
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
        (project / "analysis" / "meta_analysis.json").write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", fake_run)
    assert evimed_adapter.run_job(str(state_file)) == 0
    assert captured["command"][:3] == [evimed_adapter.sys.executable, "-m", "new_meta.main"]
    assert captured["command"][captured["command"].index("--model") + 1] == "deepseek-v4-pro"
    assert "--skip-confirm" in captured["command"]
    assert captured["command"][captured["command"].index("--run-mode") + 1] == "review"

    terminal = _post(client, {"action": "status", "jobId": job_id})
    assert terminal.status_code == 200
    body = terminal.json()
    assert body["status"] == "success"
    assert body["data"]["releaseStatus"] == "ready"
    assert body["artifacts"]
    assert all(not Path(item["path"]).is_absolute() for item in body["artifacts"])


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
