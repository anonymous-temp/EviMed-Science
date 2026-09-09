"""A researcher's own connector credential reaches one job, through its spawn
environment only, resolved from the control plane with the caller's workload
token while that token is still valid."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from test_service import _load_service, _token


class _Answer:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def read(self, _limit: int) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _fake_popen(calls):
    class FakeProcess:
        returncode = None

        def wait(self, timeout=None):
            return 0

        def poll(self):
            return None

    def fake_popen(command, *args, **kwargs):
        calls.append((command, kwargs))
        return FakeProcess()

    return fake_popen


def test_mr_job_receives_the_workload_users_opengwas_token_in_its_environment_only(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch, kind="bibliometric-analysis")
    # The bibliometric fixture engine is enough: the credential map is keyed by
    # kind, so this test drives it as the MR kind for the lookup only.
    monkeypatch.setattr(module, "_kind", lambda: "mendelian-randomization")
    monkeypatch.setattr(module, "_JOB_CONNECTOR_ENV", {"mendelian-randomization": {"opengwas": "OPENGWAS_JWT"}})
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", "http://control-plane.internal/internal/connectors/v1/credential")
    monkeypatch.setenv("OPENGWAS_JWT", "deployment-token")
    asked = []

    def fake_urlopen(request, timeout=None):
        asked.append((request.full_url, request.get_header("Authorization")))
        return _Answer({"data": {"connector": "opengwas", "source": "user", "value": "alice-own-token"}})

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)
    token = _token(secret)
    workload = {"OPENGWAS_JWT": "deployment-token"}
    assert module._job_credentials(token) == {"EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT": "alice-own-token"}
    assert asked == [("http://control-plane.internal/internal/connectors/v1/credential?connector=opengwas", f"Bearer {token}")]

    # The worker maps the prefixed value onto the engine's own variable, in
    # place of the container's, and the prefixed name does not survive. The
    # child environment resolves the fixture engine's root, so the kind is the
    # fixture's again here.
    monkeypatch.setattr(module, "_kind", lambda: "bibliometric-analysis")
    monkeypatch.setenv("EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT", "alice-own-token")
    environment = module._child_environment()
    assert environment["OPENGWAS_JWT"] == "alice-own-token"
    assert "EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT" not in environment
    monkeypatch.delenv("EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT")
    assert module._child_environment()["OPENGWAS_JWT"] == workload["OPENGWAS_JWT"]


def test_a_missing_endpoint_or_credential_leaves_the_engine_on_the_container_environment(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setattr(module, "_kind", lambda: "mendelian-randomization")
    # No endpoint configured: nothing is asked.
    monkeypatch.delenv("EVIMED_CONNECTOR_CREDENTIAL_URL", raising=False)
    assert module._job_credentials(_token(secret)) == {}
    # Endpoint configured, control plane answers 404: still nothing, no error.
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", "http://control-plane.internal/internal/connectors/v1/credential")

    def refuse(request, timeout=None):
        raise module.urllib.error.HTTPError(request.full_url, 404, "missing", {}, None)

    monkeypatch.setattr(module.urllib.request, "urlopen", refuse)
    assert module._job_credentials(_token(secret)) == {}
    # A value with whitespace or control characters is not passed on.
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda request, timeout=None: _Answer({"data": {"value": "bad token"}}))
    assert module._job_credentials(_token(secret)) == {}
    assert module._job_credentials(None) == {}


def test_a_start_request_spawns_the_worker_with_the_credential_and_the_state_file_without_it(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setattr(module, "_JOB_CONNECTOR_ENV", {"bibliometric-analysis": {"opengwas": "OPENGWAS_JWT"}})
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", "http://control-plane.internal/internal/connectors/v1/credential")
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda request, timeout=None: _Answer({"data": {"value": "alice-own-token"}}))
    calls = []
    monkeypatch.setattr(module.subprocess, "Popen", _fake_popen(calls))
    response = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "start", "topic": "antimicrobial stewardship", "maxRecords": 20},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    assert response.status_code == 200
    job_id = response.json()["data"]["jobId"]
    assert calls[0][1]["env"]["EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT"] == "alice-own-token"
    state_path = workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json"
    assert "alice-own-token" not in state_path.read_text(encoding="utf-8")
    # A status poll asks the control plane for nothing.
    calls.clear()
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda request, timeout=None: (_ for _ in ()).throw(AssertionError("status must not resolve credentials")))
    polled = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "status", "jobId": job_id},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    assert polled.status_code == 200
