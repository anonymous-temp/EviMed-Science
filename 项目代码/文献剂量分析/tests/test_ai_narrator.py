import json

from bibliometric.config import Config
from bibliometric.insight import ai_narrator


NARRATIVE_KEYS = {
    "introduction",
    "discussion",
    "conclusion",
    "results_trends",
    "results_authors",
    "results_institutions",
    "results_journals",
    "results_countries",
    "results_keyword_network",
    "results_clusters",
    "results_hotspots",
    "results_frontiers",
    "results_citation",
}


class _FakeClient:
    available = True
    calls = []

    @classmethod
    def from_config(cls, config):
        assert config.deepseek_api_key == "test-key"
        return cls()

    def complete(self, messages, **kwargs):
        type(self).calls.append((messages, kwargs))
        return json.dumps({key: f"{key} text" for key in NARRATIVE_KEYS})


def test_ai_narratives_use_pro_json_mode(monkeypatch):
    _FakeClient.calls = []
    monkeypatch.setattr("bibliometric.llm.client.DeepSeekClient", _FakeClient)
    cfg = Config(deepseek_api_key="test-key", llm_max_tokens=6000)

    result = ai_narrator._try_deepseek_api("summary", cfg, lang="zh")

    assert set(result) == NARRATIVE_KEYS
    kwargs = _FakeClient.calls[0][1]
    assert kwargs["tier"] == "pro"
    assert kwargs["json_mode"] is True
    assert kwargs["max_tokens"] == 6000


def test_ai_narratives_fall_back_without_key(monkeypatch):
    class _UnavailableClient:
        available = False

        @classmethod
        def from_config(cls, config):
            return cls()

    monkeypatch.setattr(
        "bibliometric.llm.client.DeepSeekClient", _UnavailableClient
    )
    result = ai_narrator.generate_ai_narratives(
        query="diabetes",
        articles=[{"year": "2024"}],
        stats={},
        networks={},
        config=Config(),
        lang="en",
    )
    assert NARRATIVE_KEYS.issubset(result)
    assert "1 publications" in result["introduction"]


def test_invalid_json_falls_back_to_none(monkeypatch):
    class _InvalidClient(_FakeClient):
        def complete(self, messages, **kwargs):
            return "not json"

    monkeypatch.setattr("bibliometric.llm.client.DeepSeekClient", _InvalidClient)
    assert ai_narrator._try_deepseek_api(
        "summary", Config(deepseek_api_key="test-key")
    ) is None
