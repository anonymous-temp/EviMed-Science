"""CJK handling tests: translator, drug-name fallback, ADR fallback, pipeline.

All LLM behavior is mocked — no network, no API key.
"""

from __future__ import annotations

import pytest

from safety_agent.core.exceptions import NoResults
from safety_agent.llm.fallbacks import DeepSeekNameTranslator, _sanitize, contains_cjk
from safety_agent.normalize.adr import normalize_adr_async
from safety_agent.normalize.drugs import normalize_drug


class _FakeDeepSeekClient:
    """Duck-typed DeepSeekClient returning canned completions."""

    def __init__(self, reply: str = "metformin"):
        self.reply = reply
        self.calls: list[dict] = []

    async def complete(self, messages, *, tier, temperature, max_tokens, **kwargs):
        self.calls.append(
            {"messages": messages, "tier": tier, "max_tokens": max_tokens}
        )
        return self.reply


class _FakeOpenFDA:
    """Validates translated names: only 'metformin'/'atorvastatin' have reports."""

    def __init__(self):
        self.queries: list[str] = []

    async def count_total(self, search=None):
        self.queries.append(search or "")
        if '"metformin"' in (search or "") or '"atorvastatin"' in (search or ""):
            return 1234
        raise NoResults(search=search)

    async def search_labels(self, drug=None, *, search=None, limit=3):
        return []


# -- translator unit behavior -----------------------------------------------------


def test_contains_cjk():
    assert contains_cjk("阿托伐他汀")
    assert contains_cjk("二甲双胍的ADR")
    assert not contains_cjk("atorvastatin")
    assert not contains_cjk("")


def test_sanitize_rules():
    assert _sanitize('"Atorvastatin"\n') == "atorvastatin"
    assert _sanitize("metformin hydrochloride") == "metformin hydrochloride"
    assert _sanitize("  Lactic Acidosis. ") == "lactic acidosis"
    assert _sanitize("阿托伐他汀") is None  # still CJK -> unusable
    assert _sanitize("") is None
    assert _sanitize("x" * 100) is None
    assert _sanitize("a@b.com") is None  # illegal characters survive cleaning


async def test_translator_uses_flash_and_sanitizes():
    client = _FakeDeepSeekClient("  Metformin \nextra line ignored")
    translator = DeepSeekNameTranslator(client)
    assert await translator.suggest_generic_name("二甲双胍") == "metformin"
    call = client.calls[0]
    assert call["tier"] == "flash"
    assert call["max_tokens"] <= 64
    assert "二甲双胍" in call["messages"][-1]["content"]


async def test_translator_rejects_cjk_answer():
    translator = DeepSeekNameTranslator(_FakeDeepSeekClient("二甲双胍"))
    assert await translator.suggest_generic_name("二甲双胍") is None


async def test_translator_adr_prompt_differs():
    client = _FakeDeepSeekClient("lactic acidosis")
    translator = DeepSeekNameTranslator(client)
    assert await translator.suggest_adr_pt("乳酸性酸中毒") == "lactic acidosis"
    assert "MedDRA" in client.calls[0]["messages"][0]["content"]


# -- drug-name CJK path in normalize_drug -------------------------------------------


class _FakeNameFallback:
    def __init__(self, suggestion="metformin", error: Exception | None = None):
        self.suggestion = suggestion
        self.error = error
        self.calls = 0

    async def suggest_generic_name(self, query: str) -> str | None:
        self.calls += 1
        if self.error:
            raise self.error
        return self.suggestion


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def test_cjk_drug_name_upgraded_after_openfda_validation():
    result = _run(
        normalize_drug(
            "二甲双胍",
            client=_FakeOpenFDA(),
            llm_fallback=_FakeNameFallback("metformin"),
        )
    )
    assert result.normalized == "metformin"
    assert result.method == "llm-fallback+openfda"
    assert result.confidence == pytest.approx(0.7)


def test_cjk_drug_name_translation_not_on_openfda_keeps_original():
    class StrictOpenFDA(_FakeOpenFDA):
        async def count_total(self, search=None):
            raise NoResults(search=search)

        async def search_labels(self, drug=None, *, search=None, limit=3):
            return []

    result = _run(
        normalize_drug(
            "二甲双胍",
            client=StrictOpenFDA(),
            llm_fallback=_FakeNameFallback("notarealdrug"),
        )
    )
    # translation could not be confirmed -> original text stands (NoData
    # semantics downstream), no silent upgrade
    assert result.normalized == "二甲双胍"
    assert result.confidence < 0.8


def test_cjk_drug_name_offline_accepts_translation_low_confidence():
    result = _run(
        normalize_drug("二甲双胍", client=None, llm_fallback=_FakeNameFallback("metformin"))
    )
    assert result.normalized == "metformin"
    assert result.method == "llm-fallback"
    assert result.confidence == pytest.approx(0.5)


def test_fallback_failure_keeps_rule_result():
    result = _run(
        normalize_drug(
            "二甲双胍",
            client=_FakeOpenFDA(),
            llm_fallback=_FakeNameFallback(error=RuntimeError("llm down")),
        )
    )
    assert result.normalized == "二甲双胍"  # degraded, not crashed


def test_english_name_does_not_trigger_translation():
    fallback = _FakeNameFallback("should-not-be-used")
    result = _run(
        normalize_drug("metformin", client=None, llm_fallback=fallback)
    )
    assert result.normalized == "metformin"
    # rule confidence for a clean generic is 0.75 < 0.8, so the fallback is
    # consulted but its suggestion must not upgrade a non-CJK query
    assert result.method == "rule"


# -- ADR CJK path in normalize_adr_async ----------------------------------------------


class _FakeAdrFallback:
    def __init__(self, suggestion="lactic acidosis", error: Exception | None = None):
        self.suggestion = suggestion
        self.error = error

    async def suggest_adr_pt(self, query: str) -> str | None:
        if self.error:
            raise self.error
        return self.suggestion


def test_adr_map_hit_short_circuits_llm():
    fallback = _FakeAdrFallback("must-not-be-used")
    result = _run(normalize_adr_async("肌痛", llm_fallback=fallback))
    assert result.normalized == "myalgia"
    assert result.method == "zh-map"


def test_adr_cjk_unmapped_uses_llm_translation():
    result = _run(
        normalize_adr_async("乳酸性酸中毒", llm_fallback=_FakeAdrFallback("lactic acidosis"))
    )
    assert result.normalized == "lactic acidosis"
    assert result.method == "llm-fallback"
    assert result.confidence == pytest.approx(0.6)


def test_adr_llm_translation_to_unknown_pt_accepted_low_confidence():
    result = _run(
        normalize_adr_async(
            "乳酸性酸中毒", llm_fallback=_FakeAdrFallback("some rare syndrome")
        )
    )
    assert result.normalized == "some rare syndrome"
    assert result.confidence == pytest.approx(0.4)


def test_adr_llm_failure_stays_unresolved():
    result = _run(
        normalize_adr_async(
            "乳酸性酸中毒", llm_fallback=_FakeAdrFallback(error=RuntimeError("down"))
        )
    )
    assert result.normalized is None
    assert result.method == "unresolved"


def test_adr_no_fallback_stays_unresolved():
    result = _run(normalize_adr_async("乳酸性酸中毒"))
    assert result.normalized is None


# -- WS rule extraction ---------------------------------------------------------


def test_ws_extract_basic_patterns():
    from safety_agent.api.ws_client import extract_drug_and_reactions

    assert extract_drug_and_reactions("帮我分析二甲双胍的不良反应") == ("二甲双胍", [])
    assert extract_drug_and_reactions("分析阿托伐他汀的ADR") == ("阿托伐他汀", [])
    assert extract_drug_and_reactions("分析阿托伐他汀的肌痛不良反应") == (
        "阿托伐他汀",
        ["肌痛"],
    )
    assert extract_drug_and_reactions("atorvastatin 的肌痛ADR") == (
        "atorvastatin",
        ["肌痛"],
    )
    assert extract_drug_and_reactions("metformin") == ("metformin", [])
    assert extract_drug_and_reactions("  ") == ("", [])


def test_ws_extract_suffixless_split_requires_known_pt():
    from safety_agent.api.ws_client import extract_drug_and_reactions

    # reaction part resolves to a known PT -> accept the split
    assert extract_drug_and_reactions("rituximab 的肺炎") == ("rituximab", ["肺炎"])
    # reaction part is not an ADR -> do not misread as drug+ADR
    drug, reactions = extract_drug_and_reactions("二甲双胍的价格")
    assert reactions == []


# -- pipeline integration -------------------------------------------------------------


async def test_pipeline_resolves_cjk_drug_via_fallback():
    from safety_agent.analysis.pipeline import AnalysisPipeline

    class StubOpenFDA:
        async def count_total(self, search=None):
            if search is None:
                return 2000
            if '"metformin"' in search:
                if "receivedate" in search:
                    return 5
                if "patientonsetage" in search:
                    return 20
                if "seriousness" in search:
                    return 30
                if "reactionmeddrapt" in search:
                    return 10
                return 100
            if "reactionmeddrapt" in search:
                return 30
            raise NoResults(search=search)

        async def count_terms(self, field, search=None, *, limit=100):
            from safety_agent.openfda.client import CountTerm

            return [CountTerm("Nausea", 40)]

        async def search_labels(self, drug=None, *, search=None, limit=3):
            return []

    class StubTranslator:
        async def suggest_generic_name(self, query):
            return "metformin" if "二甲双胍" in query else None

        async def suggest_adr_pt(self, query):
            return "lactic acidosis"

    pipeline = AnalysisPipeline(
        openfda=StubOpenFDA(),
        llm=None,
        evidence=None,
        name_fallback=StubTranslator(),
        adr_fallback=StubTranslator(),
    )
    result = await pipeline.run("帮我分析二甲双胍的不良反应", ["乳酸性酸中毒"])
    assert result.drug_normalized == "metformin"
    reactions = {r.normalized for r in result.reactions}
    assert "lactic acidosis" in reactions
    assert any(r.method == "llm-fallback" for r in result.reactions)
