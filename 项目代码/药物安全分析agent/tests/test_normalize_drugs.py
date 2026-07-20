"""Drug-name normalization tests: rules, brand map, unresolved behavior."""

from __future__ import annotations

import pytest

from safety_agent.normalize.drugs import normalize_drug, rule_candidates


def test_salt_suffix_stripped():
    result = _run(normalize_drug("Atorvastatin Calcium"))
    assert result.normalized == "atorvastatin"
    assert result.confidence >= 0.7


def test_strength_and_form_stripped():
    result = _run(normalize_drug("ATORVASTATIN 20 mg tablets"))
    assert result.normalized == "atorvastatin"


def test_case_and_whitespace_cleanup():
    result = _run(normalize_drug("  Rosuvastatin   10MG  "))
    assert result.normalized == "rosuvastatin"


def test_multi_salt_stripped():
    result = _run(normalize_drug("metoprolol succinate"))
    assert result.normalized == "metoprolol"


def test_brand_name_maps_to_generic():
    result = _run(normalize_drug("Lipitor"))
    assert result.normalized == "atorvastatin"
    assert result.method == "brand-map"
    assert result.confidence == pytest.approx(0.95)
    assert result.candidates[0].term == "atorvastatin"


def test_brand_name_case_insensitive():
    result = _run(normalize_drug("lIpItOr"))
    assert result.normalized == "atorvastatin"


def test_plain_generic_passes_through():
    result = _run(normalize_drug("metformin"))
    assert result.normalized == "metformin"
    assert result.confidence >= 0.7


def test_unknown_name_returns_low_confidence_candidates():
    result = _run(normalize_drug("someunknowncompoundxyz"))
    assert result.normalized == "someunknowncompoundxyz"  # passthrough, not a crash
    assert result.method == "rule"  # plausible-but-unvalidated, never "confirmed"
    assert result.confidence <= 0.8
    assert result.candidates  # rule variant offered as a candidate


def test_empty_query():
    result = _run(normalize_drug("   "))
    assert result.normalized is None
    assert result.method == "empty"
    assert result.confidence == 0.0


def test_rule_candidates_order_and_dedup():
    variants = rule_candidates("atorvastatin calcium tablets")
    assert variants[0] == "atorvastatin"  # most-processed guess first
    assert "atorvastatin calcium" in variants
    assert variants[-1] == "atorvastatin calcium tablets"
    assert len(variants) == len(set(variants))


def test_salt_stripping_only_trailing():
    # "sodium" mid-name must not be stripped; the trailing one must.
    variants = rule_candidates("sodium chloride complex sodium")
    assert variants[0] == "sodium chloride complex"


def test_salt_stripping_never_reduces_to_bare_element():
    # "potassium chloride" is itself a drug, not a salt form of "potassium".
    variants = rule_candidates("potassium chloride")
    assert "potassium chloride" in variants
    assert "potassium" not in variants


class _FakeLLM:
    async def suggest_generic_name(self, query: str) -> str | None:
        return "LLMGenericol"


class _FailingLLM:
    async def suggest_generic_name(self, query: str) -> str | None:
        raise RuntimeError("backend down")


def test_llm_fallback_seam_offers_candidate_without_overriding_rules():
    result = _run(normalize_drug("weirdname-not-in-any-map", llm_fallback=_FakeLLM()))
    assert any(c.source == "llm-fallback" and c.term == "llmgenericol" for c in result.candidates)
    # rules still win; the LLM suggestion never silently replaces them
    assert result.normalized != "llmgenericol"


def test_llm_fallback_failure_is_logged_not_raised():
    result = _run(normalize_drug("weirdname-not-in-any-map", llm_fallback=_FailingLLM()))
    assert result.normalized is not None  # degraded gracefully


def _run(coro):
    import asyncio

    return asyncio.run(coro)
