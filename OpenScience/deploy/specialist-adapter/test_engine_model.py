"""A job's engine calls the model through the gateway, under a credential for
that job alone (gap E4): asked for at admission with the runtime's workload
token and this service's signature, handed to the worker through its spawn
environment only, seen by the engine as its API key and base URL, and never
reported again after the job, because the gateway already booked every call."""
from __future__ import annotations

import io
import json
import subprocess
import sys
import urllib.error
from pathlib import Path

from test_service import _load_service, _token

from evimed_specialist_adapter import engine_model

GATEWAY = "http://open-science-web:8787/internal/model/v1"
TOKEN_URL = "http://open-science-web:8787/internal/engines/v1/model-token"
JOB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJldmltZWQtZW5naW5lLW1vZGVsIn0.c2lnbmF0dXJl"


class _Answer:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def read(self, _limit: int) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _gateway_on(monkeypatch, *, drop_key: bool = True) -> None:
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_GATEWAY", "true")
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_TOKEN_URL", TOKEN_URL)
    if drop_key:
        # With the lever on, the container is not meant to hold a provider key.
        monkeypatch.delenv("LLM_API_KEY_FILE", raising=False)


def test_the_request_signature_matches_the_control_planes_pinned_vector() -> None:
    # The same vector sits in apps/server/test/modelGatewayEngineTokens.test.mjs.
    body = b'{"v":1,"kind":"bibliometric-analysis","jobId":"bibliometric-20260929120000-abcdef012345"}'
    assert engine_model.signature("test-only-engine-model-secret-with-more-than-32-bytes", body) == (
        "02fd4d3dd95453829a454e0409b83a654af86399b9a656cfad137764fa896e2c"
    )


def test_a_credential_request_carries_both_proofs_and_names_the_job() -> None:
    sent = []

    def opener(request, timeout=None):
        sent.append((request, timeout))
        return _Answer({"data": {"token": JOB_TOKEN, "baseUrl": GATEWAY + "/", "runId": "run_1"}})

    resolved = engine_model.request_credential(
        url=TOKEN_URL, secret="s" * 40, workload_token="workload.token.value",
        kind="peer-review", job_id="review-20260929120000-abcdef012345", opener=opener,
    )
    assert resolved == {engine_model.TOKEN_ENV: JOB_TOKEN, engine_model.BASE_URL_ENV: GATEWAY}
    request, timeout = sent[0]
    assert timeout == 5
    assert request.get_header("Authorization") == "Bearer workload.token.value"
    assert json.loads(request.data) == {"v": 1, "kind": "peer-review", "jobId": "review-20260929120000-abcdef012345"}
    assert request.get_header("X-evimed-engine-signature") == f"v1={engine_model.signature('s' * 40, request.data)}"


def test_a_refusal_or_a_malformed_answer_names_why_without_a_secret() -> None:
    def refuse(request, timeout=None):
        body = io.BytesIO(json.dumps({"error": "off", "code": "engine_model_gateway_disabled"}).encode())
        raise urllib.error.HTTPError(request.full_url, 503, "off", {}, body)

    for opener, expected in (
        (refuse, "HTTP 503, engine_model_gateway_disabled"),
        (lambda request, timeout=None: _Answer({"data": {"token": "not a token", "baseUrl": GATEWAY}}), "without a usable credential"),
        (lambda request, timeout=None: _Answer({"data": {"token": JOB_TOKEN, "baseUrl": "file:///etc/passwd"}}), "absolute HTTP(S) URL"),
    ):
        try:
            engine_model.request_credential(url=TOKEN_URL, secret="s" * 40, workload_token="w.t.v",
                                            kind="peer-review", job_id="review-20260929120000-abcdef012345", opener=opener)
        except engine_model.EngineModelUnavailable as error:
            assert expected in str(error)
            assert "w.t.v" not in str(error)
        else:
            raise AssertionError("a refusal must not produce a credential")
    try:
        engine_model.request_credential(url=TOKEN_URL, secret="s" * 40, workload_token=None,
                                        kind="peer-review", job_id="review-20260929120000-abcdef012345")
    except engine_model.EngineModelUnavailable as error:
        assert "workload token" in str(error)


def test_with_the_lever_on_the_container_serves_without_a_provider_key(tmp_path, monkeypatch) -> None:
    module, client, secret, _ = _load_service(tmp_path, monkeypatch)
    _gateway_on(monkeypatch)
    health = client.get("/health").json()
    assert (health["serving"], health["modelRoute"]) == (True, "gateway")
    capabilities = client.post("/api/v1/evimed/bibliometric-analysis", json={"action": "capabilities"},
                               headers={"Authorization": f"Bearer {_token(secret)}"}).json()
    assert capabilities["status"] == "success"
    # Without its token endpoint the gateway route is not configured at all.
    monkeypatch.delenv("EVIMED_ENGINE_MODEL_TOKEN_URL")
    assert client.get("/health").json()["serving"] is False


def test_a_gateway_job_hands_its_credential_to_the_engine_only(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    _gateway_on(monkeypatch)
    asked = []

    def control_plane(request, timeout=None):
        asked.append(request)
        return _Answer({"data": {"token": JOB_TOKEN, "baseUrl": GATEWAY}})

    monkeypatch.setattr(engine_model.urllib.request, "urlopen", control_plane)
    spawned = []

    class Worker:
        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(module.subprocess, "Popen", lambda command, **kwargs: spawned.append((command, kwargs)) or Worker())
    token = _token(secret)
    response = client.post("/api/v1/evimed/bibliometric-analysis",
                           json={"action": "start", "topic": "antimicrobial stewardship", "maxRecords": 20},
                           headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    job_id = response.json()["data"]["jobId"]
    assert asked[0].get_header("Authorization") == f"Bearer {token}"
    assert json.loads(asked[0].data) == {"v": 1, "kind": "bibliometric-analysis", "jobId": job_id}
    worker_env = spawned[0][1]["env"]
    assert worker_env[engine_model.TOKEN_ENV] == JOB_TOKEN
    state_text = (workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json").read_text()
    assert JOB_TOKEN not in state_text
    assert json.loads(state_text)["modelRoute"] == "gateway"

    # What the engine itself sees: the job's credential under every name the
    # six engines read, the gateway as every base URL, the thinking policy the
    # gateway enforces -- and neither the worker-only names nor a key path.
    for name, value in worker_env.items():
        monkeypatch.setenv(name, value)
    engine_env = module._child_environment()
    for name in ("DEEPSEEK_API_KEY", "LLM_API_KEY"):
        assert engine_env[name] == JOB_TOKEN
    for name in ("DEEPSEEK_BASE_URL", "LLM_BASE_URL"):
        assert engine_env[name] == GATEWAY
    assert engine_env["EVIMED_MODEL_GATEWAY_POLICY"] == "high-thinking"
    assert engine_env["DEEPSEEK_FLASH_MODEL"] == engine_env["DEEPSEEK_PRO_MODEL"] == "deepseek-flash"
    for name in (engine_model.TOKEN_ENV, engine_model.BASE_URL_ENV, "LLM_API_KEY_FILE"):
        assert name not in engine_env


def test_a_refused_credential_refuses_the_job_and_reserves_nothing(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    _gateway_on(monkeypatch)

    def refuse(request, timeout=None):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(engine_model.urllib.request, "urlopen", refuse)
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no worker")))
    body = client.post("/api/v1/evimed/bibliometric-analysis", json={"action": "start", "topic": "sepsis"},
                       headers={"Authorization": f"Bearer {_token(secret)}"}).json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "specialist_model_gateway_unavailable"
    assert body["error"]["retryable"] is True
    assert not (workspace / "bibliometric-analysis-runs").exists()


def test_the_direct_route_is_unchanged_with_the_lever_off(tmp_path, monkeypatch) -> None:
    module, _, _, _ = _load_service(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com/")
    engine_env = module._child_environment()
    assert engine_env["DEEPSEEK_API_KEY"] == engine_env["LLM_API_KEY"] == "test-model-key"
    assert engine_env["DEEPSEEK_BASE_URL"] == "https://api.deepseek.com"
    assert "EVIMED_MODEL_GATEWAY_POLICY" not in engine_env
    assert module._model_ready() is True


def test_a_gateway_job_runs_to_completion_and_is_not_reported_twice(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    _gateway_on(monkeypatch)
    # The fixture engine records what it was given and reports usage as the
    # real runners do; with the gateway metering each call, the adapter must
    # not forward those totals.
    runner = tmp_path / "agent" / "evimed_runner.py"
    runner.write_text(
        "import argparse,json,os\n"
        "from pathlib import Path\n"
        "p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output-dir');a=p.parse_args()\n"
        "out=Path(a.output_dir);(out/'report.md').write_text('# Report\\n',encoding='utf-8')\n"
        "(out/'seen.json').write_text(json.dumps({k:os.environ.get(k) for k in ('DEEPSEEK_API_KEY','LLM_BASE_URL')}),encoding='utf-8')\n"
        "(out/'result.json').write_text(json.dumps({'status':'succeeded','usage':{'requests':3,'cacheHitTokens':1,"
        "'cacheMissTokens':2,'outputTokens':3,'model':'deepseek-flash'}}),encoding='utf-8')\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(engine_model.urllib.request, "urlopen",
                        lambda request, timeout=None: _Answer({"data": {"token": JOB_TOKEN, "baseUrl": GATEWAY}}))
    monkeypatch.setenv("EVIMED_USAGE_REPORT_URL", "http://127.0.0.1:9/internal/usage/v1/engine")
    original_popen = subprocess.Popen
    spawned = []

    class Worker:
        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(module.subprocess, "Popen", lambda command, **kwargs: spawned.append((command, kwargs)) or Worker())
    job_id = client.post("/api/v1/evimed/bibliometric-analysis", json={"action": "start", "topic": "sepsis"},
                         headers={"Authorization": f"Bearer {_token(secret)}"}).json()["data"]["jobId"]
    command, kwargs = spawned[0]
    monkeypatch.setattr(module.subprocess, "Popen", original_popen)
    completed = subprocess.run(command, cwd=kwargs["cwd"], env=kwargs["env"], check=False)
    assert completed.returncode == 0
    output = workspace / "bibliometric-analysis-runs" / job_id / "output"
    assert json.loads((output / "seen.json").read_text()) == {"DEEPSEEK_API_KEY": JOB_TOKEN, "LLM_BASE_URL": GATEWAY}
    log = (workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.log").read_text()
    assert "usage report: not sent (metered per call by the model gateway)" in log
    assert JOB_TOKEN not in (workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json").read_text()


def test_the_keyless_overlay_takes_the_key_out_of_every_adapter_and_needs_the_lever() -> None:
    import yaml

    root = Path(__file__).resolve().parents[2]
    overlay = yaml.safe_load((root / "deploy/web/docker-compose.engine-keyless.yml").read_text())
    base = yaml.safe_load((root / "deploy/web/docker-compose.yml").read_text())
    adapters = {name for name, service in base["services"].items()
                if (service.get("build") or {}).get("dockerfile") == "OpenScience/deploy/specialist-adapter/Dockerfile"}
    adapters.add("evimed-meta-agent")
    assert set(overlay["services"]) == adapters and len(adapters) == 6
    for name in adapters:
        service = overlay["services"][name]
        assert service["volumes"] == [{"type": "bind", "source": "/dev/null",
                                       "target": "/run/secrets/deepseek-api-key", "read_only": True}]
        assert service["environment"]["EVIMED_ENGINE_MODEL_GATEWAY"].startswith("${OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED:?")
        # The base file routes the same lever to the adapter and names where
        # the credential is asked for.
        environment = base["services"][name]["environment"]
        assert environment["EVIMED_ENGINE_MODEL_GATEWAY"] == "${OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED:-true}"
        assert environment["EVIMED_ENGINE_MODEL_TOKEN_URL"].endswith("/internal/engines/v1/model-token}")
    assert "OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED" in base["services"]["open-science-web"]["environment"]


def test_job_policy_is_signed_forwarded_and_overrides_container_defaults(tmp_path, monkeypatch):
    context = {"v": 1, "sessionId": "s-low", "callId": "call-1", "rootCallId": "call-1",
               "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low"}
    sent = []
    def opener(request, timeout=None):
        sent.append(json.loads(request.data))
        return _Answer({"data": {"token": JOB_TOKEN, "baseUrl": GATEWAY,
                                "modelPolicy": {"reasoningEffort": "low", "source": "session", "sessionId": "s-low"}}})
    credential = engine_model.request_credential(url=TOKEN_URL, secret="s" * 40, workload_token="w.t.v",
        kind="peer-review", job_id="review-20260929-policy", execution_context=context, opener=opener)
    assert sent[0]["executionContext"] == context
    module, _, _, _ = _load_service(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_REASONING_EFFORT", "high")
    for name, value in credential.items(): monkeypatch.setenv(name, value)
    child = module._child_environment()
    assert child["LLM_REASONING_EFFORT"] == "low"
    assert child["LLM_ENABLE_THINKING"] == "true"
    assert child["LLM_API_KEY"] == JOB_TOKEN
    assert "LLM_API_KEY_FILE" not in child


def test_off_is_a_valid_job_policy_without_forcing_thinking():
    env = engine_model.child_environment(JOB_TOKEN, GATEWAY, {"reasoningEffort": "off", "source": "session"})
    assert env["LLM_REASONING_EFFORT"] == "off"
    assert env["LLM_ENABLE_THINKING"] == "false"


def test_context_and_policy_reject_non_scalar_protocol_values():
    import pytest
    context = {"v": 1, "sessionId": "s-one", "callId": "call-1", "rootCallId": "call-1",
               "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low"}
    for key, values in {"v": [True, "1"], "model": [[], {}], "reasoningEffort": [[], {}, True, "medium"]}.items():
        for value in values:
            with pytest.raises(engine_model.EngineModelUnavailable):
                engine_model.validate_context({**context, key: value})
    for value in ([], {}, True, "medium", None):
        with pytest.raises(engine_model.EngineModelUnavailable):
            engine_model.model_policy({"reasoningEffort": value})


def test_judge_environment_uses_the_same_scoped_job_credential_and_control_plane_origin():
    environment = engine_model.child_environment(JOB_TOKEN, GATEWAY)
    assert environment["EVIMED_JUDGE_GATEWAY_TOKEN"] == JOB_TOKEN
    assert environment["EVIMED_JUDGE_GATEWAY_URL"] == GATEWAY.split("/internal/model/v1")[0] + "/internal/judge/v1/ask"
