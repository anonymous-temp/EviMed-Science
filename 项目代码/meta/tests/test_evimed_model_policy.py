"""Meta's separate adapter shares per-job gateway policy without retaining credentials."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from new_meta import evimed_adapter
from test_evimed_adapter import _fixture, _token

TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJldmltZWQtZW5naW5lLW1vZGVsIn0.c2lnbmF0dXJl"


def test_meta_gateway_job_uses_the_selected_policy_without_a_provider_key(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_GATEWAY", "true")
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_TOKEN_URL", "http://gateway.invalid/internal/engines/v1/model-token")
    monkeypatch.delenv("LLM_API_KEY")
    monkeypatch.setenv("LLM_API_KEY_FILE", str(tmp_path / "no-provider-key"))
    context = {"v": 1, "sessionId": "s-off", "callId": "call-1", "rootCallId": "call-1",
               "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off"}
    requested = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, limit):
            return json.dumps({"data": {"token": TOKEN, "baseUrl": "http://gateway.invalid/internal/model/v1",
                "modelPolicy": {"reasoningEffort": "off", "source": "session", "sessionId": "s-off"}}}).encode()
    def opener(request, **kwargs):
        requested.append(json.loads(request.data))
        return Response()
    monkeypatch.setattr("urllib.request.urlopen", opener)
    launches = []
    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kw: launches.append(kw) or SimpleNamespace(pid=2_000_000_001))
    answer = client.post("/api/v1/evimed/meta-analysis", json={"action": "start", "topic": "A bounded review"},
        headers={"Authorization": "Bearer " + _token(), "X-EviMed-Execution-Context": json.dumps(context)}).json()
    assert answer["status"] == "warning", answer
    assert requested[0]["executionContext"] == context
    assert launches[0]["env"]["EVIMED_JOB_MODEL_TOKEN"] == TOKEN
    state_file = workspace / "meta-analysis-runs/.jobs" / (answer["data"]["jobId"] + ".json")
    state = json.loads(state_file.read_text())
    assert state["modelRoute"] == "gateway" and state["modelPolicy"]["reasoningEffort"] == "off"
    assert TOKEN not in state_file.read_text()


def test_meta_gateway_usage_is_not_reported_a_second_time(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    (project / "llm_usage_manifest.json").write_text("{}")
    state = {"jobId": "meta-job", "modelRoute": "gateway", "owner": {"userId": "u", "projectId": "p"}}
    monkeypatch.setattr(evimed_adapter.evimed_usage_report, "usage_from_manifest", lambda value:
        {"requests": 1, "cacheHitTokens": 0, "cacheMissTokens": 10, "outputTokens": 20, "model": "deepseek-flash"})
    monkeypatch.setattr(evimed_adapter, "_read_signing_secret", lambda: "s" * 40)
    report = Mock(return_value="recorded")
    monkeypatch.setattr(evimed_adapter.evimed_usage_report, "report", report)
    evimed_adapter._report_usage(tmp_path / "state.json", state, project, tmp_path / "log")
    report.assert_not_called()


def test_managed_meta_llm_serializes_off_and_selected_effort(monkeypatch):
    from new_meta.core.llm import LLMClient
    monkeypatch.setenv("EVIMED_MODEL_GATEWAY_POLICY", "managed-thinking")
    client = LLMClient.__new__(LLMClient)
    client.base_url = "http://open-science-web:8787/internal/model/v1"
    client.enable_thinking = True
    client.reasoning_effort = "low"
    assert client._chat_reasoning_effort(model="deepseek-flash") == "low"
    client.enable_thinking = False
    assert client._chat_extra_body(model="deepseek-flash") == {"thinking": {"type": "disabled"}}
    assert client._chat_reasoning_effort(model="deepseek-flash") is None


def test_independently_packaged_engine_clients_share_the_same_wire_contract():
    from new_meta.core import engine_model
    root = Path(__file__).resolve().parents[3]
    shared = root / "OpenScience/deploy/specialist-adapter/evimed_specialist_adapter/engine_model.py"
    assert Path(engine_model.__file__).read_bytes() == shared.read_bytes()


def test_meta_retry_refreshes_job_credentials_and_a_new_effort_is_a_new_execution(tmp_path, monkeypatch):
    from test_evimed_adapter import _mark
    client, workspace = _fixture(tmp_path, monkeypatch)
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_GATEWAY", "true")
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_TOKEN_URL", "http://gateway.invalid/token")
    context = {"v": 1, "sessionId": "s-low", "callId": "call-1", "rootCallId": "call-1",
               "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low"}
    def issue(**kwargs):
        policy = {"reasoningEffort": kwargs["execution_context"]["reasoningEffort"], "source": "session"}
        return {evimed_adapter.engine_model.TOKEN_ENV: TOKEN, evimed_adapter.engine_model.BASE_URL_ENV: "http://gateway.invalid/v1",
                evimed_adapter.engine_model.POLICY_ENV: json.dumps(policy)}
    mint = Mock(side_effect=issue)
    monkeypatch.setattr(evimed_adapter.engine_model, "request_credential", mint)
    launches = []
    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kw: launches.append(kw) or SimpleNamespace(pid=2_000_000_001))
    def start():
        return client.post("/api/v1/evimed/meta-analysis", json={"action": "start", "topic": "Same research question"},
            headers={"Authorization": "Bearer " + _token(), "X-EviMed-Execution-Context": json.dumps(context)}).json()
    first = start()
    state_file = workspace / "meta-analysis-runs/.jobs" / (first["data"]["jobId"] + ".json")
    state = _mark(state_file, status="failed", error="worker interrupted")
    project = Path(state["outputRoot"]) / "project"
    project.mkdir()
    (project / ".checkpoint").write_text("[]")
    resumed = start()
    assert resumed["data"]["resumed"] is True
    assert mint.call_count == 2
    assert launches[-1]["env"][evimed_adapter.engine_model.TOKEN_ENV] == TOKEN
    _mark(state_file, status="succeeded")
    context["reasoningEffort"] = "max"
    next_job = start()
    assert next_job["data"]["jobId"] != first["data"]["jobId"]
    assert mint.call_count == 3


def test_resume_adopts_new_gateway_policy_before_launching_legacy_checkpoint(tmp_path, monkeypatch):
    from test_evimed_adapter import _mark
    client, workspace = _fixture(tmp_path, monkeypatch)
    headers = {"Authorization": "Bearer " + _token()}
    args = {"action": "start", "topic": "Legacy interrupted review"}
    first = client.post("/api/v1/evimed/meta-analysis", json=args, headers=headers).json()
    state_file = workspace / "meta-analysis-runs/.jobs" / (first["data"]["jobId"] + ".json")
    state = _mark(state_file, status="failed", error="interrupted")
    project = Path(state["outputRoot"]) / "project"
    project.mkdir()
    (project / ".checkpoint").write_text("[]")
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_GATEWAY", "true")
    monkeypatch.setenv("EVIMED_ENGINE_MODEL_TOKEN_URL", "http://gateway.invalid/token")
    policy = {"reasoningEffort": "high", "source": "deployment-default"}
    monkeypatch.setattr(evimed_adapter.engine_model, "request_credential", lambda **kw: {
        evimed_adapter.engine_model.TOKEN_ENV: TOKEN, evimed_adapter.engine_model.BASE_URL_ENV: "http://gateway.invalid/v1",
        evimed_adapter.engine_model.POLICY_ENV: json.dumps(policy)})
    resumed = client.post("/api/v1/evimed/meta-analysis", json=args, headers=headers).json()
    assert resumed["data"]["resumed"] is True
    state = json.loads(state_file.read_text())
    assert state["modelRoute"] == "gateway"
    assert state["modelPolicy"] == policy
    # An omitted effort is resolved at admission, not a wildcard for any old choice.
    _mark(state_file, status="succeeded", modelPolicy={"reasoningEffort": "low", "source": "session"})
    changed = client.post("/api/v1/evimed/meta-analysis", json=args, headers=headers).json()
    assert changed["data"]["jobId"] != first["data"]["jobId"]
