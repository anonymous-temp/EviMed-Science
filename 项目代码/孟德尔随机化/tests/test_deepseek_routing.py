from types import SimpleNamespace

import httpx
import openai
import pytest

from mr_agent.analysis.pipeline import MRPipeline
from mr_agent.dialog.intent import recognize_intent
from mr_agent.llm.client import LLMClient


class _FakeCompletions:
    def __init__(self, content='{"ok": true}', finish_reason="stop"):
        self.requests = []
        self.content = content
        self.finish_reason = finish_reason

    def create(self, **kwargs):
        self.requests.append(dict(kwargs))
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=self.content),
                    finish_reason=self.finish_reason,
                )
            ]
        )


def _client(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    client = LLMClient()
    completions = _FakeCompletions()
    client._client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return client, completions


def test_chat_routes_flash_and_pro_with_thinking_modes(monkeypatch):
    client, completions = _client(monkeypatch)

    client.chat([{"role": "user", "content": "classify"}], model_tier="flash")
    client.chat([{"role": "user", "content": "analyze"}], model_tier="pro")

    flash_request, pro_request = completions.requests
    assert flash_request["model"] == "deepseek-v4-flash"
    assert flash_request["max_tokens"] == 4096
    assert flash_request["extra_body"] == {"thinking": {"type": "disabled"}}
    assert flash_request["temperature"] == 0.3
    assert "reasoning_effort" not in flash_request

    assert pro_request["model"] == "deepseek-v4-pro"
    assert pro_request["max_tokens"] == 8192
    assert pro_request["extra_body"] == {"thinking": {"type": "enabled"}}
    assert pro_request["reasoning_effort"] == "high"
    assert "temperature" not in pro_request


def test_json_mode_uses_deepseek_json_output(monkeypatch):
    client, completions = _client(monkeypatch)

    assert client.chat_json(
        [{"role": "user", "content": "json"}], model_tier="flash"
    ) == {"ok": True}
    assert completions.requests[0]["response_format"] == {"type": "json_object"}


def test_intent_recognition_requests_flash_model():
    class FakeLLM:
        def __init__(self):
            self.kwargs = None

        def chat_structured(self, **kwargs):
            self.kwargs = kwargs
            return {"intent": "start_analysis", "confidence": 1.0}

    llm = FakeLLM()
    recognize_intent("BMI 对糖尿病的因果影响", llm)
    assert llm.kwargs["model_tier"] == "flash"


def test_medical_term_translation_requests_flash_model():
    class FakeLLM:
        def __init__(self):
            self.kwargs = None

        def chat(self, **kwargs):
            self.kwargs = kwargs
            return "body mass index"

    pipeline = object.__new__(MRPipeline)
    pipeline.llm = FakeLLM()
    pipeline.on_progress = lambda *args: None

    assert pipeline._translate_single("体重指数") == "body mass index"
    assert pipeline.llm.kwargs["model_tier"] == "flash"


def test_unknown_model_tier_is_rejected(monkeypatch):
    client, _ = _client(monkeypatch)
    with pytest.raises(ValueError, match="Unsupported DeepSeek model tier"):
        client.model_for_tier("unknown")


def test_empty_response_is_rejected(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    client = LLMClient()
    client._client = SimpleNamespace(
        chat=SimpleNamespace(completions=_FakeCompletions(content=""))
    )

    with pytest.raises(RuntimeError, match="empty content"):
        client._chat_openai([], "", 0, 10, client.flash_model, False)


def test_truncated_pro_response_retries_with_expanded_budget(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    client = LLMClient()

    class SequencedCompletions:
        def __init__(self):
            self.requests = []

        def create(self, **kwargs):
            self.requests.append(dict(kwargs))
            truncated = len(self.requests) == 1
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content="partial" if truncated else "complete"
                        ),
                        finish_reason="length" if truncated else "stop",
                    )
                ]
            )

    completions = SequencedCompletions()
    client._client = SimpleNamespace(chat=SimpleNamespace(completions=completions))

    result = client._chat_openai([], "", 0, 10, client.pro_model, False)

    assert result == "complete"
    assert [request["max_tokens"] for request in completions.requests] == [4106, 8212]


def test_pro_budget_is_capped(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "5000")
    client = LLMClient()
    assert client.effective_max_tokens(client.pro_model, 4000) == 5000


def test_openai_client_bypasses_system_proxy_environment(monkeypatch):
    captured = {}

    class FakeHttpClient:
        def __init__(self, **kwargs):
            captured["http"] = kwargs

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured["openai"] = kwargs

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(httpx, "Client", FakeHttpClient)
    monkeypatch.setattr(openai, "OpenAI", FakeOpenAI)
    client = LLMClient()

    assert client._get_openai_client() is not None
    assert captured["http"]["trust_env"] is False
    assert isinstance(captured["openai"]["http_client"], FakeHttpClient)
