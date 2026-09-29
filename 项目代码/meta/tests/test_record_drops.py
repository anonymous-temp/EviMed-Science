"""Every record the engine drops before inclusion is counted and listed.

Cases come from the ma-001 production run (tranexamic acid in total knee
arthroplasty, 2026-09-28): 400 records identified, 196 cut by a fixed
relevance cap of 200 with no list, 882 PubMed hits never retrieved, 148
OpenAlex records cut without a trace, and 38 records included at
title/abstract that vanished before full-text assessment.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from new_meta.agents import paper_retriever
from new_meta.agents.paper_retriever import PaperRetriever, screening_budget
from new_meta.core import record_drops
from new_meta.core.project import PRISMAFlow, Project
from new_meta.tools import pubmed

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ma001_record_drops.json").read_text(encoding="utf-8"))


@pytest.fixture
def default_budget(monkeypatch):
    """The documented defaults, whatever the environment sets."""
    monkeypatch.setattr(paper_retriever, "TA_SCREENING_FLOOR", 400)
    monkeypatch.setattr(paper_retriever, "TA_SCREENING_FRACTION", 0.5)
    monkeypatch.setattr(paper_retriever, "TA_SCREENING_CEILING", 1000)
    monkeypatch.setattr(paper_retriever, "PUBMED_CANDIDATE_POOL_MIN", 50)
    monkeypatch.setattr(paper_retriever, "PUBMED_CANDIDATE_POOL_MULTIPLIER", 5)


def _records(origin: str) -> list[dict]:
    rows = []
    for record in FIXTURE["search_records"]:
        if record["_origin"] == origin:
            row = {key: value for key, value in record.items() if key != "_origin"}
            row.pop("retrieval_sources", None)
            rows.append(row)
    return rows


def _ledger(project) -> dict:
    return project.load_json(record_drops.LEDGER_FILENAME, subdir=record_drops.LEDGER_SUBDIR)


def _stage(project, stage: str) -> dict:
    return next(item for item in _ledger(project)["entries"] if item["stage"] == stage)


# ── the screening budget ───────────────────────────────────────────────────


def test_screening_budget_screens_everything_up_to_the_floor(default_budget) -> None:
    # ma-001 had 396 de-duplicated records and screened 200 of them.
    assert screening_budget(396) == 396
    assert screening_budget(400) == 400
    assert screening_budget(0) == 0


def test_screening_budget_screens_the_more_relevant_half_of_a_larger_topic(default_budget) -> None:
    assert screening_budget(1150) == 575
    assert screening_budget(801) == 401
    assert screening_budget(3000) == 1000


def test_an_explicit_maximum_remains_a_ceiling(default_budget) -> None:
    assert screening_budget(1150, explicit_max=100) == 100
    assert screening_budget(396, explicit_max=2000) == 396
    assert screening_budget(3000, explicit_max=None) == 1000


def test_pubmed_retrieval_sees_the_topic_without_an_explicit_maximum(default_budget) -> None:
    assert paper_retriever._pubmed_retrieval_limit(None) == 1000
    assert paper_retriever._pubmed_retrieval_limit(10) == 50
    assert paper_retriever._pubmed_retrieval_limit(300) == 1000


# ── PubMed hit count ───────────────────────────────────────────────────────


def _esearch_xml(count: int, ids: list[str]) -> str:
    id_list = "".join(f"<Id>{pmid}</Id>" for pmid in ids)
    return (
        '<?xml version="1.0" encoding="UTF-8" ?>'
        "<eSearchResult>"
        f"<Count>{count}</Count><RetMax>{len(ids)}</RetMax><RetStart>0</RetStart>"
        f"<IdList>{id_list}</IdList>"
        "<TranslationSet/>"
        "<TranslationStack><TermSet><Term>\"TXA\"[tiab]</Term><Field>tiab</Field>"
        "<Count>5140</Count><Explode>N</Explode></TermSet><OP>GROUP</OP></TranslationStack>"
        "<QueryTranslation>(\"Arthroplasty, Replacement, Knee\"[MeSH Terms])</QueryTranslation>"
        "</eSearchResult>"
    )


def test_search_with_count_reports_hits_and_lists_the_unretrieved(monkeypatch) -> None:
    ids = [str(40000000 + index) for index in range(1082)]
    calls: list[dict] = []

    class Response:
        text = _esearch_xml(1082, ids)

        def raise_for_status(self):
            return None

    def fake_post(url, data, timeout):
        calls.append(dict(data))
        return Response()

    monkeypatch.setattr(pubmed, "PUBMED_EMAIL", "")
    monkeypatch.setattr(pubmed, "PUBMED_API_KEY", "")
    monkeypatch.setattr(pubmed.requests, "post", fake_post)

    result = pubmed.search_with_count(FIXTURE["search_query"], max_results=1000)

    # The per-term <Count> of the translation stack is not the query's count.
    assert result.count == 1082
    assert result.pmids == ids[:1000]
    assert result.unretrieved_pmids == ids[1000:]
    assert result.unretrieved_count == 82
    assert result.unretrieved_listed is True
    assert len(calls) == 1
    assert calls[0]["retmax"] == pubmed.PUBMED_ESEARCH_PAGE_SIZE
    assert calls[0]["sort"] == "relevance"


def test_search_keeps_returning_a_plain_id_list(monkeypatch) -> None:
    class Response:
        text = _esearch_xml(1082, ["1", "2"])

        def raise_for_status(self):
            return None

    monkeypatch.setattr(pubmed, "PUBMED_EMAIL", "")
    monkeypatch.setattr(pubmed.requests, "post", lambda url, data, timeout: Response())

    assert pubmed.search("q", max_results=2) == ["1", "2"]
    assert pubmed._count_from_esearch_xml(Response.text) == 1082


# ── the search ledger ──────────────────────────────────────────────────────


def _stub_sources(monkeypatch, *, pubmed_result, fetched: list[dict], internal: list[dict], openalex: list[dict]):
    monkeypatch.setattr(paper_retriever, "ENABLE_PUBMED_PRECISION_SUPPLEMENT", False)
    monkeypatch.setattr(paper_retriever, "ENABLE_CLINICALTRIALS_FALLBACK", False)
    monkeypatch.setattr(paper_retriever, "ENABLE_REGISTRY_SEED_FALLBACK", False)
    monkeypatch.setattr(paper_retriever.internal_db, "search_internal_db", lambda query: [dict(row) for row in internal])
    monkeypatch.setattr(pubmed, "search_with_count", lambda query, **kwargs: pubmed_result)
    monkeypatch.setattr(pubmed, "fetch_details", lambda pmids: [dict(row) for row in fetched])
    def fake_aggregate(query, max_per_source, year_range=None, include_semantic_scholar=True, **kwargs):
        # Only the first supplement query of a run (the one that also asks
        # Semantic Scholar) returns records, so a re-run sees the same sources.
        if not include_semantic_scholar:
            return [], {"OpenAlex": 0}
        return [dict(row) for row in openalex], {"OpenAlex": len(openalex) + 1}

    monkeypatch.setattr(paper_retriever.multi_search, "aggregate_search", fake_aggregate)


def _run_ma001_search(monkeypatch, tmp_path: Path, *, date_range: str = "2010-2026") -> tuple[Project, list[dict]]:
    pubmed_rows = _records("pubmed")
    pmids = [row["pmid"] for row in pubmed_rows] + ["30755381"]
    openalex_rows = _records("openalex")
    internal_rows = _records("internal_db")
    internal = [
        *internal_rows,
        dict(internal_rows[0]),  # returned twice by the internal database
        {**pubmed_rows[0], "pmid": pubmed_rows[0]["pmid"]},  # also found by PubMed
        {"pmid": "internal_old", "title": "Tranexamic acid in knee arthroplasty, 2005 cohort", "year": 2005},
    ]
    result = pubmed.PubMedSearchResult(
        pmids=pmids,
        count=len(pmids) + 4,
        # 26048730 is past PubMed's limit but OpenAlex retrieved it.
        unretrieved_pmids=["33313098", "26048730", "28455182", "23906869"],
        unretrieved_listed=True,
    )
    _stub_sources(
        monkeypatch,
        pubmed_result=result,
        fetched=pubmed_rows,  # 30755381 is never returned by efetch
        internal=internal,
        openalex=openalex_rows,
    )
    project = Project("ma-001 record drops", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(FIXTURE["search_query"], project, date_range=date_range)
    return project, papers


def test_every_search_drop_is_listed_and_prisma_reconciles(monkeypatch, tmp_path: Path, default_budget) -> None:
    monkeypatch.setattr(paper_retriever, "TA_SCREENING_FLOOR", 3)
    monkeypatch.setattr(paper_retriever, "ACADEMIC_SUPPLEMENT_MAX_RESULTS", 1)

    project, papers = _run_ma001_search(monkeypatch, tmp_path)
    identification = project.prisma.to_dict()["identification"]

    # identified = what every source yielded, PubMed counted by its hits.
    counts = project.load_json("search_source_counts.json")
    assert counts == {"internal_db": 5, "pubmed": 9, "OpenAlex": 3}
    assert identification["records_identified"] == 17
    assert identification["database_hits"]["pubmed"] == {"hits": 9, "retrieved": 5, "not_retrieved": 4}
    assert (
        identification["records_identified"]
        - identification["duplicates_removed"]
        - identification["automation_excluded"]
        - identification["records_removed_other"]
    ) == len(papers)
    assert identification["records_after_dedup"] == identification["records_identified"] - identification["duplicates_removed"]
    assert identification["records_not_screened"] == (
        identification["automation_excluded"] + identification["records_removed_other"]
    )

    ledger = _ledger(project)
    assert ledger["schema_version"] == 1
    slots = ledger["totals"]
    assert slots["duplicates_removed"] == identification["duplicates_removed"]
    assert slots["automation_ineligible"] == identification["automation_excluded"]
    assert (
        slots["removed_other_reasons"] + slots["not_retrieved_from_source"]
        == identification["records_removed_other"]
    )

    duplicate = _stage(project, "internal_db_duplicates")
    assert duplicate["records"][0]["kept_as"] == "0_89_69858a37f07b005405e93719"
    merged = _stage(project, "merged_duplicates")
    assert {record["kept_as"] for record in merged["records"]} >= {"27058218"}

    date_filter = _stage(project, "internal_db_date_filter")
    assert date_filter["prisma_slot"] == "removed_other_reasons"
    assert [record["id"] for record in date_filter["records"]] == ["internal_old"]
    assert date_filter["rule"]["start_year"] == 2010

    missing = _stage(project, "pubmed_metadata_unavailable")
    assert [record["pmid"] for record in missing["records"]] == ["30755381"]

    unretrieved = _stage(project, "pubmed_retrieval_limit")
    assert unretrieved["prisma_slot"] == "not_retrieved_from_source"
    assert unretrieved["prisma_line"] == "removed_other_reasons"
    assert unretrieved["count"] == 3
    assert [record["rank"] for record in unretrieved["records"]] == [6, 8, 9]
    assert unretrieved["rule"]["retrieval_limit"] == 1000
    assert _stage(project, "pubmed_unretrieved_duplicates")["records"][0]["kept_as"] == "26048730"

    supplement = _stage(project, "academic_supplement_cap")
    assert supplement["prisma_slot"] == "automation_ineligible"
    assert supplement["rule"]["cap"] == 1
    assert all("fallback_score" in record and record["rank"] > 1 for record in supplement["records"])
    assert _stage(project, "academic_supplement_duplicates")["count"] == 1  # counted inside the aggregate query

    cap = _stage(project, "relevance_cap")
    assert cap["rule"]["formula"] == "B(T) = min(T, max(floor, ceil(fraction * T)), ceiling)"
    total = cap["rule"]["T"]
    assert cap["rule"]["budget"] == len(papers) == max(3, -(-total // 2))
    assert cap["count"] == total - len(papers)
    for record in cap["records"]:
        assert record["title"] and record["rank"] > 0
        assert set(record["score"]) >= {"concept_groups_matched", "lexical", "quality", "citations"}
        assert "abstract" not in record
    assert identification["screening_cap"]["cut"] == cap["count"]
    assert identification["automation_excluded_reasons"]["relevance cap before screening"] == cap["count"]


def test_the_search_ledger_is_idempotent_on_rerun(monkeypatch, tmp_path: Path, default_budget) -> None:
    monkeypatch.setattr(paper_retriever, "TA_SCREENING_FLOOR", 3)
    project, first = _run_ma001_search(monkeypatch, tmp_path)
    before = _ledger(project)
    flow_before = project.prisma.to_dict()

    rerun = Project("resume", resume_dir=project.base_dir)
    PaperRetriever().search_and_fetch(FIXTURE["search_query"], rerun, date_range="2010-2026")

    after = _ledger(rerun)
    assert [item["stage"] for item in after["entries"]] == [item["stage"] for item in before["entries"]]
    assert after["totals"] == before["totals"]
    assert rerun.prisma.to_dict()["identification"] == flow_before["identification"]


def test_a_topic_below_the_floor_is_screened_whole(monkeypatch, tmp_path: Path, default_budget) -> None:
    project, papers = _run_ma001_search(monkeypatch, tmp_path)
    cap = _stage(project, "relevance_cap")

    assert cap["count"] == 0
    assert cap["rule"]["budget"] == cap["rule"]["T"] == len(papers)
    assert project.prisma.to_dict()["identification"]["automation_excluded"] == 0


def test_monotherapy_search_uses_the_same_budget_and_ledger(monkeypatch, tmp_path: Path, default_budget) -> None:
    monkeypatch.setattr(paper_retriever, "TA_SCREENING_FLOOR", 2)
    pubmed_rows = _records("pubmed")
    internal_rows = _records("internal_db")
    monkeypatch.setattr(paper_retriever.internal_db, "search_internal_db", lambda query: [dict(row) for row in internal_rows])
    results = {
        "mono": pubmed.PubMedSearchResult(pmids=[r["pmid"] for r in pubmed_rows[:2]], count=5, unretrieved_pmids=["1", "2", "3"]),
        "broad": pubmed.PubMedSearchResult(pmids=[r["pmid"] for r in pubmed_rows], count=6, unretrieved_pmids=["2", "4"]),
    }
    monkeypatch.setattr(
        pubmed,
        "search_with_count",
        lambda query, **kwargs: results["mono" if "[ti]" in query else "broad"],
    )
    by_pmid = {row["pmid"]: row for row in pubmed_rows}
    monkeypatch.setattr(pubmed, "fetch_details", lambda pmids: [dict(by_pmid[pmid]) for pmid in pmids])

    project = Project("monotherapy ledger", output_dir=tmp_path)
    papers = PaperRetriever().search_monotherapy_priority(
        FIXTURE["search_query"], '"tranexamic acid"', project, date_range="2010-2026",
    )
    identification = project.prisma.to_dict()["identification"]

    # Internal DB twice (2 + 2), then each PubMed query by its hits (5 and 6).
    assert identification["records_identified"] == 4 + 5 + 6
    assert (
        identification["records_identified"]
        - identification["duplicates_removed"]
        - identification["automation_excluded"]
        - identification["records_removed_other"]
    ) == len(papers)
    # "2" was past the limit of both queries: one hit is a duplicate of the other.
    assert _stage(project, "pubmed_retrieval_limit")["count"] == 4
    assert _stage(project, "relevance_cap")["rule"]["ranking"].startswith("monotherapy")


# ── reports sought for retrieval ───────────────────────────────────────────


def test_reports_not_retrieved_are_counted_and_listed_from_the_production_run(tmp_path: Path) -> None:
    from new_meta.main import _partition_full_text_sources

    included = [dict(row) for row in FIXTURE["pdf_download_results"]]
    with_text, without_text = _partition_full_text_sources(included)
    project = Project("ma-001 reports", output_dir=tmp_path)
    project.prisma = PRISMAFlow.from_dict(FIXTURE["prisma_flow"])

    record_drops.apply_full_text_retrieval(project, sought=included, not_retrieved=without_text)
    record_drops.apply_full_text_retrieval(project, sought=included, not_retrieved=without_text)

    eligibility = project.prisma.to_dict()["eligibility"]
    assert (len(included), len(with_text), len(without_text)) == (59, 21, 38)
    assert eligibility["full_text_sought"] == 59
    assert eligibility["not_retrieved"] == 38
    assert eligibility["not_retrieved_reasons"] == {"abstract only": 33, "no text retrieved": 5}
    assert eligibility["full_text_sought"] - eligibility["not_retrieved"] == eligibility["full_text_assessed"] == 21

    entries = [item for item in _ledger(project)["entries"] if item["step"] == "full_text"]
    assert len(entries) == 1
    listed = entries[0]["records"]
    assert entries[0]["prisma_slot"] == "reports_not_retrieved"
    assert len(listed) == 38
    assert {record["unavailability"] for record in listed} == {"abstract only", "no text retrieved"}
    assert {"pmid": "27227798", "fulltext_route": "none"}.items() <= next(
        record for record in listed if record["pmid"] == "27227798"
    ).items()


# ── PRISMAFlow and its consumers ───────────────────────────────────────────


def test_the_production_prisma_flow_still_loads() -> None:
    flow = PRISMAFlow.from_dict(FIXTURE["prisma_flow"])
    identification = flow.to_dict()["identification"]

    assert identification["records_identified"] == 400
    assert identification["duplicates_removed"] == 4
    assert identification["records_not_screened"] == 196
    assert identification["records_not_screened_reasons"] == {"relevance cap before screening": 196}
    assert identification["automation_excluded"] == 196
    assert identification["records_removed_other"] == 0
    assert "full_text_sought" not in flow.to_dict()["eligibility"]
    assert flow.to_dict()["screening"]["title_abstract_screened"] == 200


def test_legacy_reasons_other_than_the_cap_are_not_automation() -> None:
    flow = PRISMAFlow.from_dict({
        "identification": {
            "records_identified": 50,
            "records_after_dedup": 50,
            "records_not_screened": 20,
            "automation_excluded": 20,
            "records_not_screened_reasons": {"relevance cap before screening": 12, "legacy filter": 5},
        },
    })

    assert flow.automation_excluded == 15  # 12 named plus 3 the old file left unexplained
    assert flow.records_removed_other_reasons == {"legacy filter": 5}
    assert flow.records_not_screened == 20


def _replayed_flow() -> dict:
    """ma-001 under the new rule: PubMed read to 1,000 of 1,082 hits.

    1,432 identified; 82 PubMed hits not retrieved; OpenAlex 200 returned,
    2 duplicates and 148 cut by the supplement cap; 50 cross-source
    duplicates; T = 1,150 in range, of which B(T) = 575 are screened.
    """
    flow = PRISMAFlow()
    flow.set_search_counts(
        identified_by_source={"internal_db": 150, "pubmed": 1082, "OpenAlex": 200},
        duplicates_removed=52,
        automation_reasons={"relevance cap before screening": 575, "supplementary-source relevance cap": 148},
        other_reasons={"not retrieved from the source (retrieval limit)": 82},
        database_hits={"pubmed": {"hits": 1082, "retrieved": 1000, "not_retrieved": 82}},
        screening_cap={
            "formula": "B(T) = min(T, max(floor, ceil(fraction * T)), ceiling)",
            "T": 1150, "floor": 400, "fraction": 0.5, "ceiling": 1000,
            "explicit_max": None, "budget": 575, "cut": 575,
            "ranking": paper_retriever.MERGED_RANKING_RULE,
        },
    )
    flow.title_abstract_screened = 575
    flow.title_abstract_excluded = 516
    flow.set_full_text_retrieval(sought=59, not_retrieved_reasons={"abstract only": 33, "no text retrieved": 5})
    flow.full_text_assessed = 21
    flow.full_text_excluded = 16
    flow.studies_included = 5
    return flow.to_dict()


def test_the_prisma_diagram_draws_the_removal_lines(monkeypatch, tmp_path: Path) -> None:
    import matplotlib.axes
    from new_meta.engines import visualization

    texts: list[str] = []
    original = matplotlib.axes.Axes.text

    def capture(self, x, y, s, *args, **kwargs):
        texts.append(str(s))
        return original(self, x, y, s, *args, **kwargs)

    monkeypatch.setattr(matplotlib.axes.Axes, "text", capture)
    visualization.prisma_flow_diagram(_replayed_flow(), str(tmp_path / "prisma.png"))
    drawn = "\n".join(texts)

    assert "Records removed before screening:" in drawn
    assert "Duplicate records removed (n = 52)" in drawn
    assert "Marked ineligible by automation tools (n = 723)" in drawn
    assert "Removed for other reasons (n = 82)" in drawn
    assert "not retrieved (retrieval limit): 82" in drawn
    assert "PubMed 1,082 (1,000 retrieved)" in drawn
    assert "Reports sought for\nretrieval (n = 59)" in drawn
    assert "Reports not retrieved\n(n = 38)\nabstract only 33; no text 5" in drawn
    assert (tmp_path / "prisma.png").exists()


def test_manuscript_text_states_the_slots_and_the_cap_rule() -> None:
    from new_meta.agents.writing_agent import WritingAgent
    from new_meta.core.manuscript_facts import _prisma_facts

    prisma = _prisma_facts(_replayed_flow())
    assert prisma["full_text_sought"] == 59 and prisma["not_retrieved"] == 38
    assert prisma["screening_cap"]["budget"] == 575
    assert prisma["automation_excluded"] == 723 and prisma["records_removed_other"] == 82

    en = WritingAgent(lang="en")
    phrase = en._screening_entry_phrase(prisma, "after deduplication removed 52 records, 1380 unique records remained")
    assert "805 were not screened (575 ranked beyond the relevance cap for screening; " in phrase
    assert "148 ranked beyond the supplementary-source cap" in phrase
    assert "82 were matched by the search but not retrieved (retrieval limit)" in phrase
    assert "575 title/abstract records were screened" in phrase

    legend = en._fallback_prisma_flow_legend(prisma=prisma, n_primary=5)
    assert "59 reports sought for retrieval, 38 not retrieved (abstract only 33; no text retrieved 5)" in legend
    assert "min(T, max(400, ⌈0.5 × T⌉), 1000)" in legend
    assert "of 1,150 de-duplicated records within the date range, 575 were screened" in legend
    assert "The remaining 575 records were not screened, which is a limitation of this review." in legend
    assert "The PubMed search matched 1,082 records; 1,000 were retrieved" in legend

    checklist = en._fallback_prisma_2020_checklist(prisma=prisma, search_date="2026-09-28", has_rob=True, has_grade=True)
    assert "limited by a relevance cap" in checklist
    assert "Full text: 59 reports sought for retrieval, 38 not retrieved" in checklist

    zh = WritingAgent(lang="zh")
    zh_legend = zh._fallback_prisma_flow_legend(prisma=prisma, n_primary=5)
    assert "寻求全文59篇，其中38篇未获取全文（仅有摘要33篇；未获取任何文本5篇），全文评估21篇" in zh_legend
    assert "min(T, max(400, ⌈0.5×T⌉), 1000)筛选575条" in zh_legend
    assert "PubMed检索式命中1,082条记录" in zh_legend


def test_no_cap_sentence_when_nothing_was_cut() -> None:
    from new_meta.agents.writing_agent import WritingAgent
    from new_meta.core.manuscript_facts import _prisma_facts

    flow = _replayed_flow()
    flow["identification"]["screening_cap"]["cut"] = 0
    flow["identification"]["database_hits"]["pubmed"]["not_retrieved"] = 0
    assert WritingAgent(lang="en")._screening_cap_methods_text(_prisma_facts(flow)) == ""


def test_the_prisma_audit_checks_the_removal_arithmetic_as_notices() -> None:
    from new_meta.core.artifact_package import _prisma_logical_issues

    flow = _replayed_flow()
    assert _prisma_logical_issues(flow) == []

    flow["eligibility"]["not_retrieved"] = 30
    flow["identification"]["records_removed_other"] = 0
    codes = {issue["code"]: issue["severity"] for issue in _prisma_logical_issues(flow)}
    assert codes == {
        "prisma_reports_not_retrieved_mismatch": "warn",
        "prisma_removed_before_screening_split": "warn",
    }
