"""Retrieval must be visible and complete (R011, R012, R013)."""

import json

import pytest

from bibliometric.cleaning.normalizer import normalize_articles
from bibliometric.config import Config
from bibliometric.pubmed import connector as connector_module
from bibliometric.pubmed.parser import parse_articles
from bibliometric.pubmed.search_strategy import (
    ConceptBlock,
    SearchStrategyError,
    _compile_query,
)

_ESEARCH = (
    b'<?xml version="1.0"?><eSearchResult><Count>48213</Count><RetMax>0</RetMax>'
    b"<RetStart>0</RetStart><QueryKey>1</QueryKey><WebEnv>NCID_TEST</WebEnv>"
    b"</eSearchResult>"
)
_IDS = (
    b'<?xml version="1.0"?><eSearchResult><IdList>'
    + b"".join(b"<Id>%d</Id>" % i for i in range(1, 11))
    + b"</IdList></eSearchResult>"
)


class _Resp:
    def __init__(self, body):
        self.content = body
        self.text = body.decode()


class _Connector(connector_module.PubMedConnector):
    def __init__(self, config):
        super().__init__(config)
        self.calls = []

    def _request_with_retry(self, url, params):
        self.calls.append(dict(params))
        return _Resp(_ESEARCH if params.get("retmax") == 0 else _IDS)


def _connector():
    config = Config()
    config.rate_limit = 1000.0
    return _Connector(config)


# --------------------------------------------------------------------- R011

def test_esearch_sends_an_explicit_sort():
    conn = _connector()
    conn.search("semaglutide AND obesity", max_results=10)
    assert conn.calls[0]["sort"] == "relevance"


def test_esearch_sort_is_configurable_and_recorded():
    config = Config()
    config.rate_limit = 1000.0
    config.esearch_sort = "pub_date"
    conn = _Connector(config)
    conn.search("semaglutide", max_results=10)
    assert conn.calls[0]["sort"] == "pub_date"
    assert conn.last_search["sort"] == "pub_date"


def test_search_reports_the_count_pubmed_matched_not_the_cap():
    conn = _connector()
    pmids = conn.search("semaglutide AND obesity", max_results=10)
    assert len(pmids) == 10
    assert conn.last_search["total_found"] == 48213
    assert conn.last_search["retrieved"] == 10
    assert conn.last_search["max_records"] == 10
    assert conn.last_search["truncated"] is True


def test_pipeline_metadata_separates_identification_from_retrieval(tmp_path):
    from bibliometric.pipeline import AnalysisPipeline

    config = Config(output_dir=tmp_path)
    pipeline = AnalysisPipeline(config=config, query="semaglutide", max_records=10)
    pipeline.articles = [{"pmid": str(i)} for i in range(10)]
    pipeline.search_strategy = {"formal_query": "q"}
    pipeline._save_metadata(
        {"total_found": 48213, "max_records": 10, "truncated": True, "sort": "relevance"},
        10,
    )
    meta = json.loads((tmp_path / "data" / "search_metadata.json").read_text())
    assert meta["total_found"] == 48213
    assert meta["retrieved"] == 10
    assert meta["truncated"] is True
    assert meta["esearch_sort"] == "relevance"
    assert meta["searched_at"]


# --------------------------------------------------------------------- R012

def test_unresolved_concept_block_fails_instead_of_vanishing_from_the_AND():
    resolved = ConceptBlock(label="semaglutide", free_terms=["semaglutide"])
    unresolved = ConceptBlock(label="肥胖", free_terms=[])
    with pytest.raises(SearchStrategyError) as excinfo:
        _compile_query([resolved, unresolved])
    assert excinfo.value.code == "concept_block_unresolved"
    assert excinfo.value.labels == ["肥胖"]


def test_resolved_blocks_still_compile_to_an_AND_query():
    blocks = [
        ConceptBlock(label="semaglutide", free_terms=["semaglutide"]),
        ConceptBlock(label="obesity", free_terms=["obesity"]),
    ]
    query = _compile_query(blocks)
    assert query == '("semaglutide"[Title/Abstract]) AND ("obesity"[Title/Abstract])'


def test_runner_reports_the_error_code_for_an_unresolved_concept(tmp_path, monkeypatch):
    import evimed_runner

    class _FailingPipeline:
        def __init__(self, **kwargs):
            self.articles = []
            self.stats = {}

        def run(self):
            raise SearchStrategyError(
                "concept block(s) produced no searchable clause: '肥胖'",
                code="concept_block_unresolved",
                labels=["肥胖"],
            )

    class _FakeConfig:
        def __init__(self, output_dir):
            self.output_dir = output_dir

    monkeypatch.setattr("bibliometric.config.load_config", lambda output_dir: _FakeConfig(tmp_path))
    monkeypatch.setattr("bibliometric.pipeline.AnalysisPipeline", _FailingPipeline)

    request = tmp_path / "request.json"
    request.write_text(json.dumps({"topic": "semaglutide 肥胖", "maxRecords": 20}), encoding="utf-8")

    assert evimed_runner.run(request, tmp_path) == 1
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert result["errorCode"] == "concept_block_unresolved"
    assert result["errorDetail"] == {"unresolvedConcepts": ["肥胖"]}


# --------------------------------------------------------------------- R013

_MESH_XML = """<PubmedArticleSet><PubmedArticle><MedlineCitation>
<PMID>111</PMID>
<Article><ArticleTitle>Semaglutide for obesity</ArticleTitle>
<Abstract><AbstractText>x</AbstractText></Abstract>
<Journal><Title>Lancet</Title><JournalIssue><PubDate><Year>2023</Year></PubDate></JournalIssue></Journal>
</Article>
<MeshHeadingList>
  <MeshHeading><DescriptorName UI="D000067298">Semaglutide</DescriptorName>
    <QualifierName UI="Q000627">therapeutic use</QualifierName></MeshHeading>
  <MeshHeading><DescriptorName UI="D009765">Obesity</DescriptorName>
    <QualifierName UI="Q000188">drug therapy</QualifierName>
    <QualifierName UI="Q000453">epidemiology</QualifierName></MeshHeading>
</MeshHeadingList>
</MedlineCitation></PubmedArticle></PubmedArticleSet>"""


def test_mesh_qualifiers_are_parsed_apart_from_descriptors():
    article = parse_articles([_MESH_XML])[0]
    assert article["mesh_terms"] == ["Semaglutide", "Obesity"]
    assert article["mesh_qualifiers"] == ["therapeutic use", "drug therapy", "epidemiology"]


def test_mesh_qualifiers_never_reach_the_keyword_vocabulary():
    normalized = normalize_articles(parse_articles([_MESH_XML]))
    merged = normalized[0]["keywords_merged"]
    assert merged == ["Semaglutide", "Obesity"]
    for qualifier in ("drug therapy", "therapeutic use", "epidemiology"):
        assert qualifier not in merged


# ------------------------------------------------- module ledger (class D)

def _runner_result(tmp_path, monkeypatch, *, stats, report_text="# 报告\n" + "内容。" * 40):
    import evimed_runner

    class _Pipeline:
        def __init__(self, **kwargs):
            self.articles = [{"pmid": "1"}]
            self.stats = stats
            self.output_dir = kwargs["config"].output_dir
            self.search_strategy = {"formal_query": "q"}

        def run(self):
            (self.output_dir / "report.md").write_text(report_text, encoding="utf-8")

    class _Config:
        def __init__(self, output_dir):
            self.output_dir = output_dir

    monkeypatch.setattr("bibliometric.config.load_config", lambda output_dir: _Config(tmp_path))
    monkeypatch.setattr("bibliometric.pipeline.AnalysisPipeline", _Pipeline)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"topic": "semaglutide", "maxRecords": 20}), encoding="utf-8")
    code = evimed_runner.run(request, tmp_path)
    return code, json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))


def test_complete_citation_coverage_reports_an_undegraded_run(tmp_path, monkeypatch):
    code, result = _runner_result(tmp_path, monkeypatch, stats={
        "citation_coverage": {"total": 3, "observed": 3, "sources_unavailable": {}},
    })
    assert code == 0
    assert result["status"] == "succeeded"
    assert result["degraded"] is False
    assert result["modules"]["citationSource"] == {"status": "ok"}


def test_partial_citation_coverage_is_a_named_degraded_module(tmp_path, monkeypatch):
    code, result = _runner_result(tmp_path, monkeypatch, stats={
        "citation_coverage": {
            "total": 10, "observed": 4,
            "sources_unavailable": {"openalex": "api_key_missing"},
        },
    })
    assert code == 0
    assert result["status"] == "succeeded"  # artifacts exist; the tier is named, not the outcome
    assert result["degraded"] is True
    entry = result["modules"]["citationSource"]
    assert entry["status"] == "degraded"
    assert "4/10" in entry["reason"]
    assert "openalex: api_key_missing" in entry["reason"]


def test_a_citation_source_that_answered_for_nobody_fails_the_run(tmp_path, monkeypatch):
    """The citation source is not a degradable step: with zero observations the
    h-index, top-cited table and co-citation section have no basis at all."""
    code, result = _runner_result(tmp_path, monkeypatch, stats={
        "citation_coverage": {
            "total": 10, "observed": 0,
            "sources_unavailable": {"icite": "http_503", "openalex": "api_key_missing"},
        },
    })
    assert code == 1
    assert result["status"] == "failed"
    assert result["errorCode"] == "citation_source_unavailable"
    assert result["modules"]["citationSource"]["fatal"] is True
    assert result["degraded"] is True


def test_an_unresolved_concept_block_is_a_fatal_ledger_entry(tmp_path, monkeypatch):
    import evimed_runner

    class _Failing:
        def __init__(self, **kwargs):
            self.articles = []
            self.stats = {}

        def run(self):
            raise SearchStrategyError(
                "concept block(s) produced no searchable clause: '肥胖'",
                code="concept_block_unresolved", labels=["肥胖"],
            )

    class _Config:
        def __init__(self, output_dir):
            self.output_dir = output_dir

    monkeypatch.setattr("bibliometric.config.load_config", lambda output_dir: _Config(tmp_path))
    monkeypatch.setattr("bibliometric.pipeline.AnalysisPipeline", _Failing)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"topic": "semaglutide 肥胖", "maxRecords": 20}), encoding="utf-8")

    assert evimed_runner.run(request, tmp_path) == 1
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert result["modules"]["searchStrategy"]["fatal"] is True
    assert result["degraded"] is True
