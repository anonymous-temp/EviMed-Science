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


# --- the engine keys (2026-10-04) ------------------------------------------------
# A source nobody configured is the researcher's to configure when they use it, so
# what they saved reaches the engine for their job: UMLS (MR), NCBI/PubMed
# (bibliometrics, topic selection) and openFDA (drug safety), next to OpenGWAS.

_CREDENTIAL_URL = "http://control-plane.internal/internal/connectors/v1/credential"
_ENGINE_KEYS = ("UMLS_API_KEY", "NCBI_API_KEY", "OPENFDA_API_KEY", "OPENGWAS_JWT")


def _control_plane(module, monkeypatch, token, asked):
    """A control plane that answers `alice-<connector>` and records who asked, how."""

    def fake_urlopen(request, timeout=None):
        connector = request.full_url.rsplit("connector=", 1)[1]
        asked.append((connector, request.get_header("Authorization")))
        return _Answer({"data": {"connector": connector, "source": "user", "value": f"alice-{connector}"}})

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)


def test_each_engine_is_asked_for_the_keys_it_reads_and_nothing_else(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", _CREDENTIAL_URL)
    for name in _ENGINE_KEYS:
        monkeypatch.delenv(name, raising=False)
    token = _token(secret)
    asked = []
    _control_plane(module, monkeypatch, token, asked)
    expected = {
        "mendelian-randomization": {
            "EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT": "alice-opengwas",
            "EVIMED_JOB_CREDENTIAL_UMLS_API_KEY": "alice-umls",
        },
        "bibliometric-analysis": {"EVIMED_JOB_CREDENTIAL_NCBI_API_KEY": "alice-ncbi"},
        "research-topic-selection": {"EVIMED_JOB_CREDENTIAL_NCBI_API_KEY": "alice-ncbi"},
        "drug-safety-analysis": {"EVIMED_JOB_CREDENTIAL_OPENFDA_API_KEY": "alice-openfda"},
        "peer-review": {},
    }
    for kind, wanted in expected.items():
        asked.clear()
        monkeypatch.setattr(module, "_kind", lambda kind=kind: kind)
        assert module._job_credentials(token) == wanted, kind
        assert len(asked) == len(wanted), kind
        # The caller's own workload token, as before: nothing weaker, nothing else.
        assert {header for _, header in asked} <= {f"Bearer {token}"}, kind
    # Without a workload token or an endpoint, nothing is asked at all.
    asked.clear()
    monkeypatch.setattr(module, "_kind", lambda: "bibliometric-analysis")
    assert module._job_credentials(None) == {}
    monkeypatch.delenv("EVIMED_CONNECTOR_CREDENTIAL_URL")
    assert module._job_credentials(token) == {}
    assert asked == []


def test_a_container_that_holds_the_key_is_not_asked_and_its_value_stays(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", _CREDENTIAL_URL)
    for name in _ENGINE_KEYS:
        monkeypatch.delenv(name, raising=False)
    # Deployment first: UMLS is configured on the container, so only OpenGWAS —
    # whose token belongs to a person and keeps its older shape — is asked.
    monkeypatch.setenv("UMLS_API_KEY", "deployment-umls")
    asked = []
    token = _token(secret)
    _control_plane(module, monkeypatch, token, asked)
    monkeypatch.setattr(module, "_kind", lambda: "mendelian-randomization")
    assert module._job_credentials(token) == {"EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT": "alice-opengwas"}
    assert [connector for connector, _ in asked] == ["opengwas"]
    # A blank value is no value: the researcher's key is asked for.
    monkeypatch.setenv("UMLS_API_KEY", "   ")
    asked.clear()
    assert "EVIMED_JOB_CREDENTIAL_UMLS_API_KEY" in module._job_credentials(token)
    # The worker keeps the container's own value where nothing was handed over.
    monkeypatch.setenv("UMLS_API_KEY", "deployment-umls")
    monkeypatch.setattr(module, "_kind", lambda: "bibliometric-analysis")
    environment = module._child_environment()
    assert environment["UMLS_API_KEY"] == "deployment-umls"
    assert not any(name.startswith("EVIMED_JOB_CREDENTIAL_") for name in environment)
    # And where one was handed over, the engine sees it under its own name, once.
    monkeypatch.delenv("UMLS_API_KEY")
    monkeypatch.setenv("EVIMED_JOB_CREDENTIAL_UMLS_API_KEY", "alice-umls")
    environment = module._child_environment()
    assert environment["UMLS_API_KEY"] == "alice-umls"
    assert "EVIMED_JOB_CREDENTIAL_UMLS_API_KEY" not in environment


def test_a_readiness_probe_asks_about_opengwas_alone(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", _CREDENTIAL_URL)
    for name in _ENGINE_KEYS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(module, "_kind", lambda: "mendelian-randomization")
    asked = []
    token = _token(secret)
    _control_plane(module, monkeypatch, token, asked)
    assert module._job_credentials(token, only=("opengwas",)) == {"EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT": "alice-opengwas"}
    assert [connector for connector, _ in asked] == ["opengwas"]


def test_an_engine_key_reaches_the_worker_environment_and_no_file_or_log_holds_it(tmp_path, monkeypatch, capsys, caplog) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", _CREDENTIAL_URL)
    for name in _ENGINE_KEYS:
        monkeypatch.delenv(name, raising=False)
    value = "alice-own-ncbi-key-7c1f9a"
    monkeypatch.setattr(
        module.urllib.request, "urlopen",
        lambda request, timeout=None: _Answer({"data": {"connector": "ncbi", "source": "user", "value": value}}),
    )
    calls = []
    monkeypatch.setattr(module.subprocess, "Popen", _fake_popen(calls))
    response = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "start", "topic": "antimicrobial stewardship", "maxRecords": 20},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )
    assert response.status_code == 200
    # Only the job's process environment holds it, under the prefixed name the worker maps.
    assert calls[0][1]["env"]["EVIMED_JOB_CREDENTIAL_NCBI_API_KEY"] == value
    # The worker is what maps it onto the engine's own name, inside its own process.
    assert calls[0][1]["env"].get("NCBI_API_KEY") != value
    # Not in any file the adapter wrote, not in the response, not in a log.
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert value.encode() not in path.read_bytes(), path
    assert value not in response.text
    captured = capsys.readouterr()
    assert value not in captured.out + captured.err
    assert value not in caplog.text


def test_the_adapter_roster_is_the_control_planes_job_scoped_list() -> None:
    """The adapter may only ask for what the control plane answers for."""
    import re

    source = (Path(__file__).resolve().parent / "evimed_specialist_adapter" / "service.py").read_text(encoding="utf-8")
    block = re.search(r"_JOB_CONNECTOR_ENV = \{(.*?)\n\}", source, re.S).group(1)
    connectors = set(re.findall(r'"([a-z][a-z0-9-]*)":\s*"[A-Z][A-Z0-9_]*"', block))
    assert connectors == {"opengwas", "umls", "ncbi", "openfda"}
