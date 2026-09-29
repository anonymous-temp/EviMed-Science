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
