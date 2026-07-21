"""ADR-term normalization tests: zh map, en aliases, fuzzy candidates."""

from __future__ import annotations

import pytest

from safety_agent.normalize.adr import normalize_adr


@pytest.mark.parametrize(
    "query,expected_pt",
    [
        ("肌痛", "myalgia"),
        ("肌病", "myopathy"),
        ("横纹肌溶解", "rhabdomyolysis"),
        ("横纹肌溶解症", "rhabdomyolysis"),
        ("肝损伤", "hepatotoxicity"),
        ("肺炎", "pneumonia"),
        ("恶心", "nausea"),
        ("血小板减少", "thrombocytopenia"),
        ("过敏性休克", "anaphylactic shock"),
        ("急性肾损伤", "acute kidney injury"),
        ("尖端扭转型室速", "torsade de pointes"),
        ("史蒂文斯-约翰逊综合征", "stevens-johnson syndrome"),
    ],
)
def test_chinese_terms_hit_builtin_map(query, expected_pt):
    result = normalize_adr(query)
    assert result.normalized == expected_pt
    assert result.confidence == 1.0
    assert result.method == "zh-map"


def test_english_pt_passes_through_case_normalized():
    result = normalize_adr("Myalgia")
    assert result.normalized == "myalgia"
    assert result.method == "pt-direct"
    assert result.confidence == 1.0


def test_english_alias_resolves():
    result = normalize_adr("rhabdo")
    assert result.normalized == "rhabdomyolysis"
    assert result.method == "en-alias"


@pytest.mark.parametrize(
    "query,expected_pt",
    [
        ("gastrointestinal bleeding", "gastrointestinal haemorrhage"),
        ("GI bleeding", "gastrointestinal haemorrhage"),
        ("gastrointestinal hemorrhage", "gastrointestinal haemorrhage"),
        ("hemorrhage", "haemorrhage"),
        ("diarrhea", "diarrhoea"),
        ("anemia", "anaemia"),
        ("hematuria", "haematuria"),
        ("dyspnea", "dyspnoea"),
        ("peripheral edema", "peripheral oedema"),
        ("hypoglycemia", "hypoglycaemia"),
        ("hyperkalemia", "hyperkalaemia"),
    ],
)
def test_common_english_variants_resolve_to_meddra_pt(query, expected_pt):
    result = normalize_adr(query)
    assert result.normalized == expected_pt
    assert result.method == "en-alias"


def test_whitespace_is_tolerated():
    result = normalize_adr("  肌痛  ")
    assert result.normalized == "myalgia"


def test_unresolved_returns_candidates_not_a_guess():
    result = normalize_adr("rhabdomyolysi")  # typo: close to a known PT
    assert result.normalized is None
    assert result.confidence == 0.0
    assert result.method == "unresolved"
    assert any(c.term == "rhabdomyolysis" for c in result.candidates)


def test_totally_unknown_returns_empty_or_low_candidates():
    result = normalize_adr("某种不存在的不良反应xyz")
    assert result.normalized is None
    assert result.confidence == 0.0
    assert all(c.score <= 0.6 for c in result.candidates)


def test_empty_query():
    result = normalize_adr("")
    assert result.normalized is None
    assert result.method == "empty"
    assert result.candidates == []
