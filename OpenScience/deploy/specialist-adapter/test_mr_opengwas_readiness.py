"""Without an OpenGWAS JWT the MR adapter says so, and refuses what cannot run.

The 2026-09-26 audit found the MR engine healthy and `ready` in production
with `OPENGWAS_JWT` empty and no researcher credential saved: every remote
request it accepted could only fail inside the engine. Now `/health` reports
OpenGWAS and is not ready, `capabilities` warns the run, and `start` refuses a
request that needs OpenGWAS as "blocked: OpenGWAS token missing" -- while the
container stays healthy (`serving`) so web, which waits on it, still starts.
"""
from __future__ import annotations

import base64
import json
import re
import time
from pathlib import Path

from test_job_credentials import _Answer
from test_mr_inputs import local_source, setup_mr
from test_service import _token

ENDPOINT = "/api/v1/evimed/mendelian-randomization"
HERE = Path(__file__).resolve().parent


def jwt(exp: float) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'RS256'})}.{part({'exp': int(exp)})}.sig"


def _start(client, secret, **request):
    return client.post(
        ENDPOINT,
        json={"action": "start", "exposure": "BMI", "outcome": "CHD", **request},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    )


def _no_worker(service, monkeypatch):
    spawned = []
    monkeypatch.setattr(service.subprocess, "Popen", lambda command, **_k: spawned.append(command))
    return spawned


def _healthcheck_expression(text: str) -> str:
    match = re.search(r"raise SystemExit\((0 if value\.get\([^\n\"]*?\) else 1)\)", text)
    assert match, "healthcheck command not found"
    return match.group(1)


# -- /health ---------------------------------------------------------------------


def test_health_is_not_ready_without_a_token_but_the_container_stays_healthy(tmp_path, monkeypatch):
    service, client, _, _ = setup_mr(tmp_path, monkeypatch)
    monkeypatch.delenv("OPENGWAS_JWT", raising=False)
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", "http://control-plane.internal/credential")
    health = client.get("/health").json()
    assert health["ready"] is False
    assert health["status"] == "degraded"
    assert health["serving"] is True
    assert health["opengwas"] == {
        "ready": False, "reason": "opengwas_token_missing", "expiresAt": None,
        "source": "none", "perAccountCredentials": True,
    }
    # Both healthchecks the platform runs read `serving`: a missing token must
    # not make web's `depends_on: service_healthy` fail.
    dockerfile = (HERE / "Dockerfile").read_text(encoding="utf-8")
    compose = (HERE.parent / "web" / "docker-compose.yml").read_text(encoding="utf-8")
    mr_block = compose.split("\n  evimed-mr-agent:\n", 1)[1].split("\n  evimed-bibliometric-agent:\n", 1)[0]
    for text in (dockerfile, mr_block):
        assert eval(_healthcheck_expression(text), {"value": health}) == 0  # noqa: S307 — our own file
    # And an adapter older than the field still answers `ready`.
    assert eval(_healthcheck_expression(dockerfile), {"value": {"ready": True}}) == 0  # noqa: S307


def test_health_is_ready_with_a_live_token_and_names_an_expired_one(tmp_path, monkeypatch):
    _, client, _, _ = setup_mr(tmp_path, monkeypatch)
    live = jwt(time.time() + 14 * 86400)
    monkeypatch.setenv("OPENGWAS_JWT", live)
    health = client.get("/health").json()
    assert (health["ready"], health["status"], health["opengwas"]["source"]) == (True, "ok", "deployment")
    assert live not in json.dumps(health)
    monkeypatch.setenv("OPENGWAS_JWT", jwt(time.time() - 60))
    health = client.get("/health").json()
    assert health["ready"] is False
    assert health["opengwas"]["reason"] == "opengwas_token_expired"


def test_an_unloadable_helper_reports_not_serving_instead_of_failing(tmp_path, monkeypatch):
    service, client, _, _ = setup_mr(tmp_path, monkeypatch)

    def unavailable(*_args):
        raise service.MRInputSupportUnavailable("Managed MR input support is unavailable.")

    monkeypatch.setattr(service, "_opengwas_state", unavailable)
    response = client.get("/health")
    assert response.status_code == 200
    assert (response.json()["serving"], response.json()["ready"]) == (False, False)


def test_other_specialists_report_serving_equal_to_ready(tmp_path, monkeypatch):
    from test_service import _load_service

    _, client, _, _ = _load_service(tmp_path, monkeypatch)
    health = client.get("/health").json()
    assert health["serving"] is health["ready"] is True
    assert "opengwas" not in health


# -- start -----------------------------------------------------------------------


def test_a_remote_request_without_a_token_is_blocked_before_any_job_exists(tmp_path, monkeypatch):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    monkeypatch.delenv("OPENGWAS_JWT", raising=False)
    monkeypatch.delenv("EVIMED_CONNECTOR_CREDENTIAL_URL", raising=False)
    spawned = _no_worker(service, monkeypatch)
    body = _start(client, secret).json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "mr_input_remote_auth_required"
    assert body["error"]["message"].startswith("blocked: OpenGWAS token missing.")
    assert body["error"]["retryable"] is False
    assert any("账户→连接器" in action for action in body["next_actions"])
    assert spawned == []
    assert not (workspace / "mendelian-randomization-runs").exists()


def test_an_opengwas_source_without_a_token_is_blocked_too(tmp_path, monkeypatch):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    monkeypatch.delenv("OPENGWAS_JWT", raising=False)
    (workspace / "data").mkdir()
    (workspace / "data/exposure.csv").write_text("variant,effect,stderr,A1,A2,freq,p\n")
    spawned = _no_worker(service, monkeypatch)
    body = _start(
        client, secret,
        exposureSource=local_source("data/exposure.csv"),
        outcomeSource={"type": "opengwas", "gwasId": "ieu-a-7"},
    ).json()
    assert body["error"]["code"] == "mr_input_remote_auth_required"
    assert spawned == []


def test_an_expired_deployment_token_blocks_and_says_expired(tmp_path, monkeypatch):
    service, client, secret, _ = setup_mr(tmp_path, monkeypatch)
    monkeypatch.setenv("OPENGWAS_JWT", jwt(time.time() - 3600))
    monkeypatch.delenv("EVIMED_CONNECTOR_CREDENTIAL_URL", raising=False)
    _no_worker(service, monkeypatch)
    body = _start(client, secret).json()
    assert body["error"]["message"].startswith("blocked: OpenGWAS token expired (")


def test_a_researchers_own_token_admits_their_remote_job(tmp_path, monkeypatch):
    service, client, secret, _ = setup_mr(tmp_path, monkeypatch)
    monkeypatch.delenv("OPENGWAS_JWT", raising=False)
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", "http://control-plane.internal/credential")
    own = jwt(time.time() + 86400)
    monkeypatch.setattr(
        service.urllib.request, "urlopen",
        lambda request, timeout=None: _Answer({"data": {"value": own}}),
    )
    calls = []

    class Worker:
        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(
        service.subprocess, "Popen", lambda command, **kwargs: calls.append(kwargs) or Worker()
    )
    body = _start(client, secret).json()
    assert body["status"] == "warning", body
    assert calls[0]["env"]["EVIMED_JOB_CREDENTIAL_OPENGWAS_JWT"] == own


def test_two_preclumped_local_files_are_admitted_without_any_token(tmp_path, monkeypatch):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    monkeypatch.delenv("OPENGWAS_JWT", raising=False)
    (workspace / "data").mkdir()
    for role in ("exposure", "outcome"):
        (workspace / f"data/{role}.csv").write_text("variant,effect,stderr,A1,A2,freq,p\n")

    class Worker:
        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(service.subprocess, "Popen", lambda command, **_k: Worker())
    body = _start(
        client, secret,
        exposureSource=local_source("data/exposure.csv"),
        outcomeSource=local_source("data/outcome.csv", clumped=False),
    ).json()
    assert body["status"] == "warning", body


# -- capabilities ----------------------------------------------------------------


def test_capabilities_warn_the_run_that_opengwas_is_blocked(tmp_path, monkeypatch):
    _, client, secret, _ = setup_mr(tmp_path, monkeypatch)
    monkeypatch.delenv("OPENGWAS_JWT", raising=False)
    monkeypatch.delenv("EVIMED_CONNECTOR_CREDENTIAL_URL", raising=False)
    body = client.post(
        ENDPOINT, json={"action": "capabilities"},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    ).json()
    assert body["status"] == "warning"
    assert body["data"]["available"] is True
    assert body["data"]["opengwas"]["reason"] == "opengwas_token_missing"
    assert body["warnings"][0].startswith("blocked: OpenGWAS token missing")
    assert body["next_actions"]

    monkeypatch.setenv("OPENGWAS_JWT", jwt(time.time() + 3600))
    body = client.post(
        ENDPOINT, json={"action": "capabilities"},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    ).json()
    assert body["status"] == "success"
    assert body["data"]["opengwas"]["ready"] is True
