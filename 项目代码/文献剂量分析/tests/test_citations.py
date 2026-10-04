"""Citation data must be observed, never estimated (R010)."""

import pytest

from bibliometric.analysis import citations


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class _Session:
    """Records calls; answers iCite from a fixture, refuses everything else."""

    def __init__(self, icite_rows=None, icite_status=200):
        self.icite_rows = icite_rows or []
        self.icite_status = icite_status
        self.gets = []
        self.posts = []

    def get(self, url, params=None, timeout=None):
        self.gets.append((url, params))
        if url == citations.ICITE_URL:
            return _Response({"data": self.icite_rows}, self.icite_status)
        raise AssertionError(f"unexpected GET {url}")

    def post(self, url, params=None, json=None, timeout=None):
        self.posts.append((url, json))
        raise RuntimeError("semantic scholar unreachable in tests")


def _articles():
    return [
        {"pmid": "1", "title": "A", "year": "2015"},
        {"pmid": "2", "title": "B", "year": "2016"},
        {"pmid": "3", "title": "C", "year": "2017"},
    ]


def test_no_estimator_is_reachable_from_the_module():
    # The simulator (journal tier x age x type x log-normal noise) is gone.
    assert not hasattr(citations, "_estimate_citations")
    assert not hasattr(citations, "simulate_citations")


def test_unobserved_article_stays_missing_instead_of_being_estimated():
    session = _Session(icite_rows=[{"pmid": 1, "citation_count": 12,
                                    "references": [90], "cited_by": [70, 71]}])
    articles, coverage = citations.fetch_citations(
        _articles(), session=session, openalex_api_key="",
    )
    observed = [a for a in articles if "citations" in a]
    assert [a["pmid"] for a in observed] == ["1"]
    for article in articles[1:]:
        assert article["citation_source"] == citations.SOURCE_MISSING
        assert "citations" not in article  # no zero-fill, no guess
    assert coverage["observed"] == 1
    assert coverage["total"] == 3
    assert coverage["by_source"] == {citations.SOURCE_ICITE: 1}


def test_openalex_without_a_key_is_recorded_unavailable_not_skipped():
    session = _Session(icite_rows=[], icite_status=503)
    _, coverage = citations.fetch_citations(
        _articles(), session=session, openalex_api_key="",
    )
    assert coverage["sources_unavailable"][citations.SOURCE_OPENALEX] == "api_key_missing"
    assert coverage["sources_unavailable"][citations.SOURCE_ICITE] == "http_503"
    assert coverage["observed"] == 0


def test_statistics_are_computed_over_the_observed_subset_only():
    session = _Session(icite_rows=[
        {"pmid": 1, "citation_count": 10},
        {"pmid": 2, "citation_count": 4},
    ])
    articles, _ = citations.fetch_citations(
        _articles(), session=session, openalex_api_key="",
    )
    stats = citations.compute_citation_statistics(articles)
    assert stats["coverage"] == {
        "observed": 2, "total": 3, "by_source": {citations.SOURCE_ICITE: 2},
    }
    # 14, not 14/3 spread over a fabricated third article.
    assert stats["total_citations"] == 14
    assert stats["mean_citations"] == 7.0
    assert stats["h_index"] == 2


def test_statistics_report_zero_coverage_without_inventing_metrics():
    session = _Session(icite_rows=[])
    articles, _ = citations.fetch_citations(
        _articles(), session=session, openalex_api_key="",
    )
    stats = citations.compute_citation_statistics(articles)
    assert stats == {"coverage": {"observed": 0, "total": 3, "by_source": {}}}


def test_cocitation_counts_documents_that_cite_both_not_shared_keywords():
    session = _Session(icite_rows=[
        {"pmid": 1, "citation_count": 3, "cited_by": [900, 901, 902]},
        {"pmid": 2, "citation_count": 2, "cited_by": [901, 902]},
        {"pmid": 3, "citation_count": 1, "cited_by": [999]},
    ])
    articles, _ = citations.fetch_citations(
        _articles(), session=session, openalex_api_key="",
    )
    # Same keywords for all three: keyword overlap would pair every one of them.
    for article in articles:
        article["keywords_merged"] = ["obesity", "glp-1"]

    pairs = citations.build_cocitation_pairs(articles)
    assert len(pairs) == 1
    row = pairs.iloc[0]
    assert {row["source_pmid"], row["target_pmid"]} == {"1", "2"}
    assert row["cocitation_strength"] == 2  # documents 901 and 902


def test_cocitation_is_empty_when_no_reference_relations_were_observed():
    session = _Session(icite_rows=[{"pmid": 1, "citation_count": 5}])
    articles, coverage = citations.fetch_citations(
        _articles(), session=session, openalex_api_key="",
    )
    for article in articles:
        article["keywords_merged"] = ["obesity"]
    assert coverage["reference_relations"] == 0
    assert citations.build_cocitation_pairs(articles).empty


def test_bibliographic_coupling_counts_shared_references():
    session = _Session(icite_rows=[
        {"pmid": 1, "citation_count": 1, "references": [10, 11, 12]},
        {"pmid": 2, "citation_count": 1, "references": [11, 12, 13]},
        {"pmid": 3, "citation_count": 1, "references": [99]},
    ])
    articles, _ = citations.fetch_citations(
        _articles(), session=session, openalex_api_key="",
    )
    pairs = citations.build_bibliographic_coupling_pairs(articles)
    assert len(pairs) == 1
    assert pairs.iloc[0]["shared_references"] == 2


@pytest.mark.parametrize("raw,expected", [
    ([10, 11], ["10", "11"]),
    ("10 11", ["10", "11"]),
    ("10,11", ["10", "11"]),
    (None, []),
])
def test_icite_relation_field_accepts_both_shapes(raw, expected):
    assert citations._pmid_list(raw) == expected


# ---------------------------------------------------------------------------
# A source that could not be used is said, not left to the log.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("reason, status", [
    ("api_key_missing", citations.STATUS_NOT_CONFIGURED),
    ("http_401", citations.STATUS_REFUSED),
    ("http_403", citations.STATUS_REFUSED),
    ("http_429", citations.STATUS_REFUSED),
    ("http_500", citations.STATUS_UNREACHABLE),
    ("http_404", citations.STATUS_UNREACHABLE),
    ("bad_json: Expecting value", citations.STATUS_UNREACHABLE),
    ("request_failed: Connection refused", citations.STATUS_UNREACHABLE),
])
def test_an_unavailable_reason_is_one_of_three_status_words(reason, status):
    assert citations.unavailable_status(reason) == status


def test_the_coverage_ledger_lists_which_sources_were_not_used_and_why():
    session = _Session(icite_rows=[{"pmid": 1, "citation_count": 12}])
    _, coverage = citations.fetch_citations(_articles(), session=session, openalex_api_key="")
    assert citations.sources_not_used(coverage) == [
        {"source": "openalex", "label": "OpenAlex", "status": "not_configured", "reason": "api_key_missing"},
        {"source": "semantic_scholar", "label": "Semantic Scholar", "status": "unreachable",
         "reason": "request_failed: semantic scholar unreachable in tests"},
    ]
    # Nothing was asked of iCite when there was no PMID to ask about: not a failed source.
    _, empty = citations.fetch_citations([{"title": "no pmid"}], session=_Session())
    assert citations.sources_not_used(empty) == []
    assert citations.sources_not_used(None) == []


def test_the_citation_section_names_what_could_not_be_used_beside_what_was():
    from bibliometric.report import results_sections

    coverage = {"total": 3, "observed": 2, "missing": 1, "by_source": {"icite": 2},
                "sources_unavailable": {"openalex": "api_key_missing", "semantic_scholar": "http_429"}}
    stats = {"citation_stats": {"coverage": coverage, "h_index": 1, "total_citations": 10,
                                "mean_citations": 5, "median_citations": 5}}
    for lang, expected in (
        ("en", "Citation sources that could not be used: OpenAlex (not configured), Semantic Scholar (refused)."),
        ("zh", "未能使用的引用数据来源：OpenAlex（未配置）、Semantic Scholar（被拒绝）。"),
    ):
        section = results_sections._results_citation({"stats": stats, "lang": lang, "fig_counter": 0, "table_counter": 0})
        assert expected in section, section
        assert section.index("iCite 2") < section.index(expected), "said where the sources are listed"
    clean = {**coverage, "sources_unavailable": {}}
    section = results_sections._results_citation(
        {"stats": {"citation_stats": {**stats["citation_stats"], "coverage": clean}}, "lang": "en",
         "fig_counter": 0, "table_counter": 0})
    assert "could not be used" not in section
