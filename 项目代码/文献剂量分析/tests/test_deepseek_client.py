from types import SimpleNamespace

import httpx
import openai
import pytest

from bibliometric.llm.client import DeepSeekClient


def _response(content="ok", finish_reason="stop"):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content),
                finish_reason=finish_reason,
            )
        ],
        usage=SimpleNamespace(prompt_tokens=7, completion_tokens=3),
    )


class _SyncCompletions:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs.copy())
        return next(self.responses)


def _sync_client(responses, **kwargs):
    client = DeepSeekClient(api_key="test-key", **kwargs)
    completions = _SyncCompletions(responses)
    client._sync_client = SimpleNamespace(
        chat=SimpleNamespace(completions=completions)
    )
    return client, completions


def test_flash_and_pro_payload_contracts():
    flash, flash_api = _sync_client([_response("flash")])
    assert flash.complete([{"role": "user", "content": "x"}], tier="flash", max_tokens=1000) == "flash"
    flash_call = flash_api.calls[0]
    assert flash_call["model"] == "deepseek-v4-flash"
    assert flash_call["max_tokens"] == 1000
    assert flash_call["temperature"] == 0.3
    assert flash_call["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "reasoning_effort" not in flash_call

    pro, pro_api = _sync_client([_response("pro")])
    assert pro.complete([{"role": "user", "content": "x"}], tier="pro", max_tokens=1000) == "pro"
    pro_call = pro_api.calls[0]
    assert pro_call["model"] == "deepseek-v4-pro"
    assert pro_call["max_tokens"] == 5096
    assert pro_call["reasoning_effort"] == "high"
    assert pro_call["extra_body"] == {"thinking": {"type": "enabled"}}
    assert "temperature" not in pro_call


def test_json_mode_and_json_parser():
    client, api = _sync_client([_response('{"answer": 1}')])
    text = client.complete(
        [{"role": "user", "content": "json"}],
        tier="pro",
        json_mode=True,
    )
    assert api.calls[0]["response_format"] == {"type": "json_object"}
    assert client.parse_json(f"```json\n{text}\n```") == {"answer": 1}


def test_pro_retries_once_with_expanded_budget_after_truncation():
    client, api = _sync_client(
        [_response("partial", "length"), _response("complete")],
        pro_reasoning_reserve_tokens=100,
        max_output_tokens=1000,
    )
    assert client.complete(
        [{"role": "user", "content": "x"}], tier="pro", max_tokens=10
    ) == "complete"
    assert [call["max_tokens"] for call in api.calls] == [110, 220]


def test_empty_flash_response_is_rejected():
    client, _ = _sync_client([_response("   ")])
    with pytest.raises(RuntimeError, match="empty content"):
        client.complete([{"role": "user", "content": "x"}], tier="flash")


def test_invalid_tier_and_missing_key_are_rejected():
    client = DeepSeekClient(api_key="")
    with pytest.raises(ValueError, match="Unsupported"):
        client.model_for_tier("unknown")
    with pytest.raises(ValueError, match="DEEPSEEK_API_KEY"):
        client.complete([{"role": "user", "content": "x"}], tier="flash")


def test_sync_client_bypasses_system_proxy_environment(monkeypatch):
    captured = {}

    class FakeHttpClient:
        def __init__(self, **kwargs):
            captured["http"] = kwargs

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured["openai"] = kwargs

    monkeypatch.setattr(httpx, "Client", FakeHttpClient)
    monkeypatch.setattr(openai, "OpenAI", FakeOpenAI)
    client = DeepSeekClient(api_key="test-key")

    assert client._get_sync_client() is not None
    assert captured["http"]["trust_env"] is False
    assert isinstance(captured["openai"]["http_client"], FakeHttpClient)


class _AsyncStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        self._iter = iter(self._chunks)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class _AsyncCompletions:
    def __init__(self, chunks):
        self.chunks = chunks
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs.copy())
        return _AsyncStream(self.chunks)


def _chunk(content=None, finish_reason=None):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=content),
                finish_reason=finish_reason,
            )
        ]
    )


@pytest.mark.asyncio
async def test_pro_stream_yields_nonempty_answer():
    client = DeepSeekClient(api_key="test-key")
    completions = _AsyncCompletions(
        [
            _chunk("答"),
            _chunk("案"),
            _chunk(finish_reason="stop"),
            SimpleNamespace(
                choices=[],
                usage=SimpleNamespace(prompt_tokens=2, completion_tokens=2),
            ),
        ]
    )
    client._async_client = SimpleNamespace(
        chat=SimpleNamespace(completions=completions)
    )
    parts = [part async for part in client.astream(
        [{"role": "user", "content": "x"}], tier="pro", max_tokens=20
    )]
    assert "".join(parts) == "答案"
    assert completions.calls[0]["model"] == "deepseek-v4-pro"
    assert completions.calls[0]["stream_options"] == {"include_usage": True}


@pytest.mark.asyncio
async def test_empty_stream_is_rejected():
    client = DeepSeekClient(api_key="test-key")
    completions = _AsyncCompletions([_chunk(finish_reason="stop")])
    client._async_client = SimpleNamespace(
        chat=SimpleNamespace(completions=completions)
    )
    with pytest.raises(RuntimeError, match="empty stream"):
        async for _ in client.astream(
            [{"role": "user", "content": "x"}], tier="flash"
        ):
            pass
