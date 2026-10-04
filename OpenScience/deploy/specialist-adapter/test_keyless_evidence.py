"""A deployment without an EviMed evidence key still serves the drug-safety adapter.

The adapter refused to serve unless the deployment's key file held a key, so on a
deployment without one the container was never healthy and the web service that
waits on it never started. The owner's ruling of 2026-10-04: a source nobody
configured is the researcher's to configure where they use it. The key is
reported in /health, never required for it.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _drug_safety(tmp_path: Path, monkeypatch, key_file: str | None):
    agent = tmp_path / "agent"
    (agent / "safety_agent" / "analysis").mkdir(parents=True)
    (agent / "safety_agent" / "analysis" / "pipeline.py").write_text("# marker\n", encoding="utf-8")
    (agent / "evimed_runner.py").write_text("# fixture runner\n", encoding="utf-8")
    signing = tmp_path / "signing.secret"
    signing.write_text("test-only-workload-signing-secret-32-bytes", encoding="utf-8")
    signing.chmod(0o600)
    model = tmp_path / "model.secret"
    model.write_text("test-model-key", encoding="utf-8")
    model.chmod(0o600)
    monkeypatch.setenv("EVIMED_SPECIALIST_KIND", "drug-safety-analysis")
    monkeypatch.setenv("EVIMED_AGENT_ROOT", str(agent))
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(tmp_path / "data"))
    monkeypatch.setenv("EVIMED_WORKLOAD_SIGNING_SECRET_FILE", str(signing))
    monkeypatch.setenv("LLM_API_KEY_FILE", str(model))
    monkeypatch.setenv("LLM_MODEL", "deepseek-flash")
    monkeypatch.delenv("EVIMED_ENGINE_MODEL_GATEWAY", raising=False)
    if key_file is None:
        monkeypatch.delenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", raising=False)
    else:
        monkeypatch.setenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", key_file)
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parent))
    sys.modules.pop("evimed_specialist_adapter.service", None)
    module = importlib.import_module("evimed_specialist_adapter.service")
    return module, TestClient(module.app)


@pytest.mark.parametrize("shape", ["unset", "dev-null", "empty-file", "directory"])
def test_a_deployment_without_an_evidence_key_serves_and_says_so(tmp_path, monkeypatch, shape) -> None:
    key_file = {
        "unset": None,
        "dev-null": "/dev/null",
        "empty-file": str(tmp_path / "empty.key"),
        "directory": str(tmp_path),
    }[shape]
    if shape == "empty-file":
        Path(key_file).write_text("", encoding="utf-8")
    module, client = _drug_safety(tmp_path, monkeypatch, key_file)

    health = client.get("/health").json()
    # What the container healthcheck reads, and what the web service waits for.
    assert health["serving"] is True and health["ready"] is True and health["status"] == "ok"
    assert health["evidenceSource"] == {"configured": False}
    assert module._model_ready() is True


def test_a_deployment_with_an_evidence_key_reports_it_configured_and_never_the_key(tmp_path, monkeypatch) -> None:
    key = tmp_path / "evimed.key"
    key.write_text("synthetic-evimed-evidence-key\n", encoding="utf-8")
    key.chmod(0o600)
    _, client = _drug_safety(tmp_path, monkeypatch, str(key))
    response = client.get("/health")
    assert response.json()["evidenceSource"] == {"configured": True}
    assert "synthetic-evimed-evidence-key" not in response.text


def test_only_the_drug_safety_adapter_reports_an_evidence_source(tmp_path, monkeypatch) -> None:
    from test_service import _load_service

    _, client, _, _ = _load_service(tmp_path, monkeypatch, kind="bibliometric-analysis")
    assert "evidenceSource" not in client.get("/health").json()
