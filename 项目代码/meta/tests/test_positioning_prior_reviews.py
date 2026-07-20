"""Tests for novelty/positioning prior-review mining from search results."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from new_meta.core.positioning import build_review_positioning
from new_meta.schemas.protocol import PICO, ResearchProtocol


class FakeProject:
    """Minimal stand-in exposing only load_json, keyed by (filename, subdir)."""

    def __init__(self, data: dict):
        self._data = data

    def load_json(self, filename: str, subdir: str | None = None):
        return self._data.get((filename, subdir))


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does X reduce Y in adults?",
        pico=PICO(population="adults", intervention="X", comparator="placebo", outcome_primary="Y"),
    )


def test_positioning_mines_prior_reviews_from_search_results_pub_types():
    search = [
        {
            "title": "Effect of X on Y: a systematic review and meta-analysis",
            "pub_types": ["Journal Article", "Meta-Analysis"],
            "doi": "10.1/abc", "year": 2023, "journal": "BMJ",
        },
        {
            "title": "A randomized trial of X for Y",
            "pub_types": ["Randomized Controlled Trial", "Journal Article"], "doi": "10.1/rct",
        },
    ]
    project = FakeProject({("search_results.json", None): search})
    payload = build_review_positioning(project=project, protocol=_protocol(), extracted_studies=[], meta_results=None)

    titles = [r["title"] for r in payload["prior_reviews"]]
    assert any("systematic review and meta-analysis" in t for t in titles)
    assert all("randomized trial" not in t.lower() for t in titles)  # the RCT is not a prior review
    assert payload["category"] == "potential_update_or_expansion"
    assert payload["requires_human_novelty_review"] is True


def test_positioning_new_or_unclear_when_no_prior_reviews_and_no_anchor():
    search = [{"title": "A randomized trial of X for Y", "pub_types": ["Randomized Controlled Trial"]}]
    project = FakeProject({("search_results.json", None): search})
    payload = build_review_positioning(project=project, protocol=_protocol())
    assert payload["prior_reviews"] == []
    assert payload["category"] == "new_or_unclear"


def test_anchor_benchmark_takes_precedence_over_mined_reviews():
    project = FakeProject({
        ("known_source_reference_set.json", "extraction"): {
            "source_label": "WHO REACT 2020", "source_id": "who_react",
        },
        ("search_results.json", None): [
            {"title": "Steroids meta-analysis", "pub_types": ["Meta-Analysis"]},
        ],
    })
    payload = build_review_positioning(project=project, protocol=_protocol())
    assert payload["category"] == "reproduction_or_benchmark_alignment"
    assert payload["anchor_review"]["label"] == "WHO REACT 2020"


def test_prior_reviews_deduped_across_sources_by_doi():
    # Same review present in both background context and search results -> one entry.
    project = FakeProject({
        ("evidence_context.json", "analysis"): {"references": [
            {"title": "X for Y: a systematic review", "doi": "10.1/dup", "source_type": "systematic review"},
        ]},
        ("search_results.json", None): [
            {"title": "X for Y: a systematic review", "doi": "10.1/dup", "pub_types": ["Systematic Review"]},
        ],
    })
    payload = build_review_positioning(project=project, protocol=_protocol())
    dois = [r.get("doi") for r in payload["prior_reviews"]]
    assert dois.count("10.1/dup") == 1
