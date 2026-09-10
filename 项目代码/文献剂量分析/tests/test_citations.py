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
