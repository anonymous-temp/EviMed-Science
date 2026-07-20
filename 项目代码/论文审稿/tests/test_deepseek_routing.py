import asyncio
import json
from types import SimpleNamespace

import pytest

from src.services import llm_gateway as gateway_module
from src.services.llm_gateway import LLMGateway, LLMProvider, ModelTier


class _FakeContent:
    def __init__(self, lines):
        self._lines = lines

    def __aiter__(self):
        self._iterator = iter(self._lines)
        return self

    async def __anext__(self):
        try:
            return next(self._iterator)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _FakeResponse:
    def __init__(
        self,
        request,
        content="ok",
        finish_reason="stop",
        status=200,
        stream_lines=None,
    ):
        self.request = request
        self._content = content
        self._finish_reason = finish_reason
        self.status = status
        self.content = _FakeContent(stream_lines or [])

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def json(self):
        return {
            "choices": [
                {
                    "message": {"content": self._content},
                    "finish_reason": self._finish_reason,
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }

    async def text(self):
        return "test error"


class _FakeSession:
    def __init__(self, requests, response_factory=None):
        self.requests = requests
        self.response_factory = response_factory

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def post(self, url, headers, json):
        request = {"url": url, "headers": headers, "json": dict(json)}
        self.requests.append(request)
        if self.response_factory:
            return self.response_factory(request)
        return _FakeResponse(request)


def _gateway(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash")
    monkeypatch.setenv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro")
    return LLMGateway(provider=LLMProvider.DEEPSEEK, api_key="test-key")


def test_model_tiers_map_to_flash_and_pro(monkeypatch):
    gateway = _gateway(monkeypatch)
    assert gateway.model_mapping[ModelTier.FAST] == "deepseek-v4-flash"
    assert gateway.model_mapping[ModelTier.STANDARD] == "deepseek-v4-pro"
    assert gateway.model_mapping[ModelTier.ADVANCED] == "deepseek-v4-pro"


@pytest.mark.asyncio
async def test_request_payload_switches_thinking_with_model(monkeypatch):
    requests = []
    monkeypatch.setattr(
        gateway_module,
        "_make_session",
        lambda timeout: _FakeSession(requests),
    )
    gateway = _gateway(monkeypatch)

    for tier in (ModelTier.FAST, ModelTier.ADVANCED):
        await gateway._call_llm(
            messages=[{"role": "user", "content": "test"}],
            model=gateway.model_mapping[tier],
            temperature=0.2,
            max_tokens=10,
        )

    flash_payload, pro_payload = (request["json"] for request in requests)
    assert flash_payload["model"] == "deepseek-v4-flash"
    assert flash_payload["max_tokens"] == 10
    assert flash_payload["thinking"] == {"type": "disabled"}
    assert flash_payload["temperature"] == 0.2
    assert "reasoning_effort" not in flash_payload

    assert pro_payload["model"] == "deepseek-v4-pro"
    assert pro_payload["max_tokens"] == 4106
    assert pro_payload["thinking"] == {"type": "enabled"}
    assert pro_payload["reasoning_effort"] == "high"
    assert "temperature" not in pro_payload


@pytest.mark.asyncio
async def test_json_output_is_forwarded(monkeypatch):
    requests = []
    monkeypatch.setattr(
        gateway_module,
        "_make_session",
        lambda timeout: _FakeSession(requests),
    )
    gateway = _gateway(monkeypatch)
    await gateway._call_llm(
        messages=[{"role": "user", "content": "json"}],
        model=gateway.model_mapping[ModelTier.FAST],
        temperature=0,
        max_tokens=20,
        response_format={"type": "json_object"},
    )
    assert requests[0]["json"]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_empty_response_is_rejected(monkeypatch):
    monkeypatch.setattr(
        gateway_module,
        "_make_session",
        lambda timeout: _FakeSession(
            [], response_factory=lambda request: _FakeResponse(request, content="")
        ),
    )
    gateway = _gateway(monkeypatch)

    with pytest.raises(RuntimeError, match="empty content"):
        await gateway._call_llm(
            messages=[{"role": "user", "content": "test"}],
            model=gateway.model_mapping[ModelTier.FAST],
            temperature=0,
            max_tokens=10,
        )


@pytest.mark.asyncio
async def test_truncated_pro_response_retries_with_expanded_budget(monkeypatch):
    requests = []

    def response_factory(request):
        truncated = len(requests) == 1
        return _FakeResponse(
            request,
            content="partial" if truncated else "complete",
            finish_reason="length" if truncated else "stop",
        )

    monkeypatch.setattr(
        gateway_module,
        "_make_session",
        lambda timeout: _FakeSession(requests, response_factory=response_factory),
    )
    gateway = _gateway(monkeypatch)

    result = await gateway._call_llm(
        messages=[{"role": "user", "content": "test"}],
        model=gateway.model_mapping[ModelTier.ADVANCED],
        temperature=0,
        max_tokens=10,
    )

    assert result["content"] == "complete"
    assert [request["json"]["max_tokens"] for request in requests] == [4106, 8212]


@pytest.mark.asyncio
async def test_http_error_and_timeout_are_reported(monkeypatch):
    gateway = _gateway(monkeypatch)
    monkeypatch.setattr(
        gateway_module,
        "_make_session",
        lambda timeout: _FakeSession(
            [], response_factory=lambda request: _FakeResponse(request, status=503)
        ),
    )
    with pytest.raises(RuntimeError, match="API Error 503"):
        await gateway._call_llm(
            [{"role": "user", "content": "x"}],
            gateway.model_mapping[ModelTier.FAST],
            0,
            10,
        )

    class TimeoutSession(_FakeSession):
        def post(self, url, headers, json):
            raise asyncio.TimeoutError

    monkeypatch.setattr(
        gateway_module,
        "_make_session",
        lambda timeout: TimeoutSession([]),
    )
    with pytest.raises(RuntimeError, match="timed out"):
        await gateway._call_llm(
            [{"role": "user", "content": "x"}],
            gateway.model_mapping[ModelTier.FAST],
            0,
            10,
        )


@pytest.mark.asyncio
async def test_stream_parses_content_and_checks_finish_reason(monkeypatch):
    requests = []
    lines = [
        b'data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n',
        b'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n',
        b'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n',
        b'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n',
        b"data: [DONE]\n",
    ]
    monkeypatch.setattr(
        gateway_module,
        "_make_session",
        lambda timeout: _FakeSession(
            requests,
            response_factory=lambda request: _FakeResponse(
                request, stream_lines=lines
            ),
        ),
    )
    gateway = _gateway(monkeypatch)
    chunks = [
        chunk
        async for chunk in gateway.stream_text(
            [{"role": "user", "content": "x"}],
            model_tier=ModelTier.ADVANCED,
            max_tokens=10,
        )
    ]
    assert chunks == ["hello"]
    assert requests[0]["json"]["model"] == "deepseek-v4-pro"
    assert requests[0]["json"]["stream_options"] == {"include_usage": True}


@pytest.mark.asyncio
async def test_chat_uses_flash_without_report_and_pro_with_report(monkeypatch):
    from src.api import main as api_main

    tiers = []

    class FakeGateway:
        async def stream_text(self, messages, model_tier):
            tiers.append(model_tier)
            yield "ok"

    monkeypatch.setattr(
        api_main,
        "get_orchestrator",
        lambda: SimpleNamespace(llm_gateway=FakeGateway()),
    )

    async def send_msg(payload):
        return None

    await api_main._stream_reply_no_file("hello", send_msg, "m1", "s1")
    await api_main._stream_reply_no_file(
        "question", send_msg, "m2", "s2", report_context="report"
    )
    assert tiers == [ModelTier.FAST, ModelTier.ADVANCED]
