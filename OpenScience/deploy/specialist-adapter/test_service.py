from __future__ import annotations

import base64
import hashlib
import hmac
import importlib
import json
import sqlite3
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient


def _encoded(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).decode().rstrip("=")


def _token(secret: str, *, user: str = "user1", project: str = "project1", expired: bool = False) -> str:
    now = int(time.time())
    header = _encoded({"alg": "HS256", "typ": "JWT"})
    body = _encoded({
        "v": 1,
        "aud": "evimed-adapter",
        "userId": user,
        "projectId": project,
        "iat": now - 120 if expired else now,
        "exp": now - 60 if expired else now + 300,
        "jti": "test-token-1",
    })
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return f"{header}.{body}.{signature}"


def _load_service(tmp_path: Path, monkeypatch):
    secret = "test-only-workload-signing-secret-32-bytes"
    agent = tmp_path / "agent"
    (agent / "src" / "bibliometric").mkdir(parents=True)
    (agent / "src" / "bibliometric" / "pipeline.py").write_text("# marker\n", encoding="utf-8")
    (agent / "evimed_runner.py").write_text(
        "import argparse,json\n"
        "from pathlib import Path\n"
        "p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output-dir');a=p.parse_args()\n"
        "out=Path(a.output_dir);(out/'report.md').write_text('# Verified report\\n\\nEvidence.',encoding='utf-8')\n"
        "(out/'result.json').write_text(json.dumps({'status':'succeeded'}),encoding='utf-8')\n",
        encoding="utf-8",
    )
    data = tmp_path / "data"
    workspace = data / "users" / "user1" / "projects" / "project1" / "workspace"
    workspace.mkdir(parents=True)
    signing = tmp_path / "signing.secret"
    signing.write_text(secret, encoding="utf-8")
    signing.chmod(0o600)
    model = tmp_path / "model.secret"
    model.write_text("test-model-key", encoding="utf-8")
    model.chmod(0o600)
    monkeypatch.setenv("EVIMED_SPECIALIST_KIND", "bibliometric-analysis")
    monkeypatch.setenv("EVIMED_AGENT_ROOT", str(agent))
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(data))
    monkeypatch.setenv("EVIMED_WORKLOAD_SIGNING_SECRET_FILE", str(signing))
    monkeypatch.setenv("LLM_API_KEY_FILE", str(model))
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-pro")
    parent = Path(__file__).resolve().parent
    monkeypatch.syspath_prepend(str(parent))
    sys.modules.pop("evimed_specialist_adapter.service", None)
    module = importlib.import_module("evimed_specialist_adapter.service")
    return module, TestClient(module.app), secret, workspace


def test_adapter_requires_scoped_workload_token(tmp_path, monkeypatch) -> None:
    _, client, secret, _ = _load_service(tmp_path, monkeypatch)
    endpoint = "/api/v1/evimed/bibliometric-analysis"
    assert client.post(endpoint, json={"action": "capabilities"}).status_code == 401
    assert client.post(
        endpoint,
        json={"action": "capabilities"},
        headers={"Authorization": f"Bearer {_token(secret, expired=True)}"},
    ).status_code == 401


def test_capabilities_prove_model_and_managed_service(tmp_path, monkeypatch) -> None:
    _, client, secret, _ = _load_service(tmp_path, monkeypatch)
    response = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "capabilities"},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["data"] == {"available": True, "model": "deepseek-v4-pro", "thinking": True}
    assert body["sources"][0]["source"] == "Bibliometric analysis"


def test_start_and_worker_publish_only_workspace_artifacts(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)

    class FakeProcess:
        def wait(self, timeout=None):
            return 0

    original_popen = module.subprocess.Popen
    monkeypatch.setattr(module.subprocess, "Popen", lambda *args, **kwargs: FakeProcess())
    response = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "start", "topic": "antimicrobial stewardship", "maxRecords": 20},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    monkeypatch.setattr(module.subprocess, "Popen", original_popen)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "warning"
    job_id = body["data"]["jobId"]
    state_path = workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["request"] == {"topic": "antimicrobial stewardship", "maxRecords": 20}
    assert module.run_job(str(state_path)) == 0

    finished = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "status", "jobId": job_id},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    ).json()
    assert finished["status"] == "success"
    paths = {item["path"] for item in finished["artifacts"]}
    assert any(path.endswith("/report.md") for path in paths)
    assert all(not path.startswith("/") and ".." not in Path(path).parts for path in paths)


def test_request_contract_rejects_unknown_fields(tmp_path, monkeypatch) -> None:
    _, client, secret, _ = _load_service(tmp_path, monkeypatch)
    response = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "start", "topic": "x", "command": "whoami"},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "request contains unsupported fields"

    ignored_job = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "start", "topic": "x", "jobId": "bibliometric-caller-selected"},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    assert ignored_job.status_code == 422


def test_interrupted_worker_is_not_reported_as_running(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)

    class MissingProcess:
        def poll(self):
            return 1

    monkeypatch.setattr(module.subprocess, "Popen", lambda *args, **kwargs: MissingProcess())
    started = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "start", "topic": "interrupted analysis"},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    ).json()
    job_id = started["data"]["jobId"]
    status_body = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "status", "jobId": job_id},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    ).json()
    assert status_body["status"] == "error"
    assert status_body["error"]["code"] == "specialist_execution_failed"
    state_path = workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json"
    assert json.loads(state_path.read_text(encoding="utf-8"))["status"] == "failed"


def test_evidence_adapter_is_authenticated_and_keeps_fixed_tool_mapping(tmp_path, monkeypatch) -> None:
    _, _, secret, _ = _load_service(tmp_path, monkeypatch)
    mcp_root = Path(__file__).resolve().parents[2] / "runtime" / "mcp" / "evimed-research"
    pharmacy = tmp_path / "pharmacy.sqlite"
    connection = sqlite3.connect(pharmacy)
    connection.executescript(
        "CREATE TABLE records(id INTEGER PRIMARY KEY, search_text TEXT NOT NULL);"
        "INSERT INTO records(search_text) VALUES ('aspirin');"
        "CREATE VIRTUAL TABLE records_fts USING fts5(search_text);"
    )
    connection.close()
    monkeypatch.setenv("EVIMED_MCP_ROOT", str(mcp_root))
    monkeypatch.setenv("EVIMED_PHARMACY_REFERENCE_DB", str(pharmacy))
    sys.modules.pop("evimed_specialist_adapter.evidence_service", None)
    module = importlib.import_module("evimed_specialist_adapter.evidence_service")
    calls = []

    def fake_call(name, arguments):
        calls.append((name, arguments))
        return {
            "summary": "Traceable evidence packet.",
            "data": {"items": [{"id": "one"}]},
            "sources": [{"id": "source-one", "source": "test", "retrievedAt": "2026-07-21T00:00:00Z"}],
        }

    monkeypatch.setattr(module.public_sources, "call", fake_call)
    client = TestClient(module.app)
    assert client.get("/health").json()["ready"] is True
    endpoint = "/api/v1/evimed/offlabel-evidence-packet"
    assert client.post(endpoint, json={"drug": "aspirin"}).status_code == 401
    response = client.post(
        endpoint,
        json={"drug": "aspirin"},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    assert response.status_code == 200
    assert response.json()["summary"] == "Traceable evidence packet."
    assert calls == [("evimed_offlabel_evidence_packet", {"drug": "aspirin"})]
