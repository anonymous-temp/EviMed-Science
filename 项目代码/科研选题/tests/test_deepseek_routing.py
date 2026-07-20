"""DeepSeek V4 configuration and routing contract tests."""

import asyncio
import json

import httpx
from openai import AuthenticationError

from config.settings import settings
from services.llm_service import LLMService


MESSAGES = [{"role": "user", "content": "test"}]


def test_deepseek_configuration_is_active():
    assert settings.LLM_PROVIDER == "deepseek"
    assert settings.DEEPSEEK_BASE_URL == "https://api.deepseek.com"
    assert settings.DEEPSEEK_FLASH_MODEL == "deepseek-v4-flash"
    assert settings.DEEPSEEK_PRO_MODEL == "deepseek-v4-pro"
    assert settings.JAVA_WS_URL == settings.JAVA_WS_URL.strip()
    assert settings.LLM_MAX_CONCURRENT == 2
    assert settings.LLM_MAX_RETRIES == 2
    assert settings.MODULE_TIMEOUT_SECONDS >= (
        settings.DEEPSEEK_PRO_TIMEOUT_SECONDS * settings.LLM_MAX_RETRIES + 30
    )


def test_flash_request_disables_thinking_and_keeps_temperature():
    service = LLMService()
    model, tier, timeout, kwargs = service._request_kwargs(
        messages=MESSAGES,
        model=None,
        model_tier="flash",
        temperature=0.2,
        max_tokens=1000,
        json_mode=True,
        stream=False,
    )

    assert model == "deepseek-v4-flash"
    assert tier == "flash"
    assert timeout == settings.DEEPSEEK_FLASH_TIMEOUT_SECONDS
    assert kwargs["temperature"] == 0.2
    assert kwargs["max_tokens"] == 1000
    assert kwargs["extra_body"]["thinking"]["type"] == "disabled"
    assert kwargs["response_format"] == {"type": "json_object"}
    assert "reasoning_effort" not in kwargs


def test_pro_request_enables_thinking_and_reserves_reasoning_tokens():
    service = LLMService()
    model, tier, timeout, kwargs = service._request_kwargs(
        messages=MESSAGES,
        model=None,
        model_tier="pro",
        temperature=0.2,
        max_tokens=1000,
        json_mode=False,
        stream=True,
    )

    assert model == "deepseek-v4-pro"
    assert tier == "pro"
    assert timeout == settings.DEEPSEEK_PRO_TIMEOUT_SECONDS
    assert kwargs["max_tokens"] == 5096
    assert kwargs["extra_body"]["thinking"]["type"] == "enabled"
    assert kwargs["reasoning_effort"] == "high"
    assert "temperature" not in kwargs


def test_unknown_model_tier_is_rejected():
    service = LLMService()
    try:
        service.model_for_tier("unknown")
    except ValueError as exc:
        assert "不支持" in str(exc)
    else:
        raise AssertionError("unknown model tier must raise ValueError")


def test_single_pro_model_alias_keeps_thinking_enabled(monkeypatch):
    monkeypatch.setattr(settings, "DEEPSEEK_FLASH_MODEL", "deepseek-v4-pro")
    monkeypatch.setattr(settings, "DEEPSEEK_PRO_MODEL", "deepseek-v4-pro")
    service = LLMService()

    model, tier, timeout, kwargs = service._request_kwargs(
        messages=MESSAGES,
        model=None,
        model_tier="flash",
        temperature=0.2,
        max_tokens=1000,
        json_mode=True,
        stream=False,
    )

    assert model == "deepseek-v4-pro"
    assert tier == "pro"
    assert timeout == settings.DEEPSEEK_PRO_TIMEOUT_SECONDS
    assert kwargs["extra_body"]["thinking"]["type"] == "enabled"
    assert kwargs["reasoning_effort"] == "high"
    assert "temperature" not in kwargs


def test_deepseek_client_bypasses_system_proxy_environment(monkeypatch):
    captured = {}

    class FakeHttpClient:
        def __init__(self, **kwargs):
            captured["http"] = kwargs

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured["openai"] = kwargs

    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr("services.llm_service.httpx.AsyncClient", FakeHttpClient)
    monkeypatch.setattr("services.llm_service.AsyncOpenAI", FakeOpenAI)

    LLMService()

    assert captured["http"]["trust_env"] is False
    assert isinstance(captured["openai"]["http_client"], FakeHttpClient)
    assert captured["openai"]["max_retries"] == 0


def test_managed_gateway_rotation_rebuilds_client_without_exposing_token(monkeypatch, tmp_path):
    model_config = tmp_path / "opencode.json"
    model_config.write_text(json.dumps({
        "provider": {
            "deepseek": {
                "options": {
                    "apiKey": "rotated-token",
                    "baseURL": "http://127.0.0.1:8798/internal/model/v1/",
                }
            }
        }
    }), encoding="utf-8")
    created = []

    class PreviousClient:
        async def close(self):
            self.closed = True

    previous = PreviousClient()

    def fake_new_client(api_key, base_url):
        created.append((api_key, base_url))
        return object()

    monkeypatch.setenv("EVIMED_MODEL_CONFIG_FILE", str(model_config))
    service = LLMService()
    service.client = previous
    service._client_api_key = "stale-token"
    monkeypatch.setattr(service, "_new_client", fake_new_client)

    refreshed = asyncio.run(service._refresh_managed_client(previous))

    assert refreshed is True
    assert created == [("rotated-token", "http://127.0.0.1:8798/internal/model/v1")]
    assert service._client_api_key == "rotated-token"
    assert previous.closed is True


def test_managed_gateway_rotation_does_not_retry_an_unchanged_token(monkeypatch, tmp_path):
    model_config = tmp_path / "opencode.json"
    model_config.write_text(json.dumps({
        "provider": {
            "deepseek": {
                "options": {"apiKey": "same-token", "baseURL": "http://127.0.0.1:8798/internal/model/v1"}
            }
        }
    }), encoding="utf-8")
    monkeypatch.setenv("EVIMED_MODEL_CONFIG_FILE", str(model_config))
    service = LLMService()
    service.client = object()
    service._client_api_key = "same-token"

    assert asyncio.run(service._refresh_managed_client(service.client)) is False


def test_401_retries_once_with_the_rotated_managed_gateway_token(monkeypatch, tmp_path):
    model_config = tmp_path / "opencode.json"
    model_config.write_text(json.dumps({
        "provider": {
            "deepseek": {
                "options": {"apiKey": "fresh-token", "baseURL": "http://127.0.0.1:8798/internal/model/v1"}
            }
        }
    }), encoding="utf-8")

    class Completions:
        def __init__(self, result=None):
            self.result = result

        async def create(self, **_kwargs):
            if self.result is None:
                response = httpx.Response(401, request=httpx.Request("POST", "http://gateway.test/chat"))
                raise AuthenticationError("expired", response=response, body={"error": "expired"})
            return self.result

    class FakeClient:
        def __init__(self, result=None):
            self.chat = type("Chat", (), {"completions": Completions(result)})()

        async def close(self):
            return None

    monkeypatch.setenv("EVIMED_MODEL_CONFIG_FILE", str(model_config))
    service = LLMService()
    service.client = FakeClient()
    service._client_api_key = "expired-token"
    monkeypatch.setattr(service, "_new_client", lambda *_args: FakeClient("fresh-response"))

    result = asyncio.run(service._create_completion_with_refresh({"model": "deepseek-v4-pro"}, 2))

    assert result == "fresh-response"
    assert service._client_api_key == "fresh-token"
