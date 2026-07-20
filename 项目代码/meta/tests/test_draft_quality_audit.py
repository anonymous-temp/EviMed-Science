"""Tests for the deterministic draft quality scorer used by the generalization gate."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from new_meta.core.draft_quality_audit import (
    audit_draft,
    audit_project_dir,
    citation_reference_consistency,
    expand_citation_numbers,
    fact_consistency,
    find_near_duplicate_sentences,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_expand_citation_numbers_handles_ranges_and_separators():
    assert expand_citation_numbers("5,8-10,12") == [5, 8, 9, 10, 12]
    assert expand_citation_numbers("1, 2, 3") == [1, 2, 3]
    assert expand_citation_numbers("14-16") == [14, 15, 16]
    # full-width separators / dashes used in Chinese drafts
    assert expand_citation_numbers("5，8-10，12") == [5, 8, 9, 10, 12]
    assert expand_citation_numbers("4至6") == [4, 5, 6]


def test_citation_reference_consistency_flags_unused_and_dangling():
    draft = (
        "## Introduction\nA claim [1]. Another claim [3]. A dangling one [9].\n\n"
        "## References\n"
        "[1] Author A. Title. Journal. 2020.\n"
        "[2] Author B. Title. Journal. 2021.\n"
        "[3] Author C. Title. Journal. 2022.\n"
    )
    result = citation_reference_consistency(draft)
    assert result["reference_entries"] == 3
    assert result["cited_unique"] == 3  # 1, 3, 9
    assert result["unused_references"] == [2]      # entry 2 never cited
    assert result["dangling_citations"] == [9]     # 9 cited but no entry


def test_find_near_duplicate_sentences_detects_exact_doubling():
    draft = (
        "## Results\n"
        "The certainty rating was moderate because GRADE downgraded for risk of bias [24].\n\n"
        "## Discussion\n"
        "The certainty rating was moderate because GRADE downgraded for risk of bias [24].\n"
    )
    dups = find_near_duplicate_sentences(draft)
    assert any(d["type"] == "exact" for d in dups)


def test_find_near_duplicate_sentences_ignores_distinct_sentences():
    draft = (
        "## Discussion\n"
        "Corticosteroids reduced mortality in critically ill adults with COVID-19.\n\n"
        "Future trials should report safety outcomes by respiratory-support stratum.\n"
    )
    assert find_near_duplicate_sentences(draft) == []


def test_find_near_duplicate_sentences_ignores_abstract_restating_results():
    # An abstract that restates the headline result is correct manuscript
    # structure, not a robotic doubling, and must not be flagged.
    draft = (
        "## Abstract\n"
        "The pooled effect was OR 0.66 (95% CI 0.53 to 0.82), favoring treatment.\n\n"
        "## Results\n"
        "The pooled fixed-effect estimate was OR 0.66 (95% CI 0.53 to 0.82), favoring treatment.\n"
    )
    assert find_near_duplicate_sentences(draft) == []


def test_find_near_duplicate_sentences_detects_intra_body_doubling_not_abstract():
    draft = (
        "## Abstract\n"
        "The pooled effect was OR 0.66 (95% CI 0.53 to 0.82), favoring treatment.\n\n"
        "## Results\n"
        "The certainty rating was moderate because GRADE downgraded for risk of bias.\n\n"
        "## Discussion\n"
        "The certainty rating was moderate because GRADE downgraded for risk of bias.\n"
    )
    dups = find_near_duplicate_sentences(draft)
    assert len(dups) == 1
    assert dups[0]["type"] == "exact"


def test_fact_consistency_detects_headline_number_drift():
    draft = "## Results\nThe pooled effect was OR 0.80 (95% CI 0.60 to 0.95), favoring treatment.\n"
    facts = {"primary_effect": {
        "effect_measure": "OR", "pooled_effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82,
    }}
    result = fact_consistency(draft, facts)
    assert result["status"] == "checked"
    fields = {m["field"] for m in result["mismatches"]}
    assert {"pooled_effect", "ci_lower", "ci_upper"}.issubset(fields)


def test_fact_consistency_passes_when_prose_matches_facts():
    draft = "## Results\nThe pooled effect was OR 0.66 (95% CI 0.53 to 0.82) (p<0.001).\n"
    facts = {"primary_effect": {
        "effect_measure": "OR", "pooled_effect": 0.6593, "ci_lower": 0.5322, "ci_upper": 0.8167,
        "i_squared": 15.6,
    }}
    result = fact_consistency(draft, facts)
    assert result["mismatches"] == []


def test_audit_draft_clean_passes_and_doubled_fails():
    clean = (
        "## Introduction\nA background claim about disease severity [1].\n\n"
        "## Results\nThe pooled effect was OR 0.66 (95% CI 0.53 to 0.82) [2].\n\n"
        "## References\n[1] A. Title. J. 2020.\n[2] B. Title. J. 2021.\n"
    )
    facts = {"primary_effect": {"effect_measure": "OR", "pooled_effect": 0.66,
                                "ci_lower": 0.53, "ci_upper": 0.82}}
    clean_result = audit_draft(clean, facts=facts)
    assert clean_result["summary"]["fact_mismatches"] == 0
    assert clean_result["summary"]["exact_duplicate_sentences"] == 0

    doubled = clean.replace(
        "## Results\nThe pooled effect was OR 0.66 (95% CI 0.53 to 0.82) [2].",
        "## Results\nThe pooled effect was OR 0.66 (95% CI 0.53 to 0.82) [2].\n\n"
        "## Discussion\nThe pooled effect was OR 0.66 (95% CI 0.53 to 0.82) [2].",
    )
    doubled_result = audit_draft(doubled, facts=facts)
    assert doubled_result["summary"]["exact_duplicate_sentences"] >= 1
    assert doubled_result["gate"] == "fail"


def test_evidence_gap_report_is_not_scored_as_publishable():
    draft = (
        "# Systematic Review Evidence-Gap Report\n\n"
        "## Current Conclusion\nThis run is classified as evidence_gap with status blocked.\n"
    )
    facts = {"report_type": "evidence_gap", "evidence_readiness": {"status": "blocked"}}
    result = audit_draft(draft, facts=facts)
    assert result["gate"] == "evidence_gap"
    assert result["score"] is None
    assert result["summary"]["is_publication_manuscript"] is False


def test_publication_manuscript_with_zero_references_fails():
    draft = (
        "## Results\nThe pooled effect was OR 0.66 (95% CI 0.53 to 0.82), favoring treatment.\n"
    )
    facts = {"report_type": "meta", "primary_effect": {
        "effect_measure": "OR", "pooled_effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82,
    }}
    result = audit_draft(draft, facts=facts)
    assert result["gate"] == "fail"
    assert result["summary"]["reference_entries"] == 0


@pytest.mark.parametrize("fixture_dir", [
    "output/benchmark_runs/20260530_en_covid_quality_gate_v2",
])
def test_audit_project_dir_on_existing_benchmark_if_present(fixture_dir):
    base = REPO_ROOT / fixture_dir
    if not (base / "manuscript" / "draft.md").exists():
        pytest.skip(f"benchmark fixture not present: {fixture_dir}")
    result = audit_project_dir(str(base))
    assert "error" not in result
    assert isinstance(result["score"], float)
    # The May-31 COVID-EN draft contains a verbatim certainty sentence twice.
    assert result["summary"]["exact_duplicate_sentences"] >= 1
