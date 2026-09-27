"""PubMed throttling is recorded, retried within a budget, and diagnosed.

The live replay of brief ordinary-constrained-cohort on 2026-09-27 hit
repeated HTTP 429s from NCBI (the engine had no NCBI_API_KEY). ``_esearch``
then returned ``[]`` and ``_efetch`` dropped the batch, so a throttled
sub-query was indistinguishable from one with no hits and a thin result read
as the size of the literature. These tests drive the real client against a
fake E-utilities endpoint.
"""

import asyncio
import json
from datetime import datetime

import pytest

import evimed_runner
from config.settings import settings
from core.new_report_generator import ReportGenerator
from models.schemas import AnalysisReport, ModuleOutput, TaskStatus
from services import pubmed_service as pubmed_module
from services.llm_service import llm_service
from services.pubmed_service import (
    PubMedRequestError,
    PubMedSearchResult,
    PubMedSearchService,
    SubQueryOutcome,
)
from services.task_service import TaskService


def _article(pmid: str) -> str:
    return (
        "<PubmedArticle><MedlineCitation>"
        f"<PMID>{pmid}</PMID><Article><ArticleTitle>Missed hemodialysis sessions study {pmid}</ArticleTitle>"
        "<Abstract><AbstractText>Hemodialysis adherence and missed sessions.</AbstractText></Abstract>"
        "<Journal><Title>Kidney Journal</Title><JournalIssue><PubDate><Year>2025</Year></PubDate>"
        "</JournalIssue></Journal></Article></MedlineCitation></PubmedArticle>"
    )


class FakeResponse:
    def __init__(self, status: int, body):
        self.status = status
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def json(self):
        return self._body

    async def text(self):
        return self._body


class FakeEutils:
    """esearch/efetch with a per-term script of statuses.

    ``esearch_script[term]`` is a list of statuses consumed per call; when it
    runs out the term answers 200. ``efetch_429`` names PMIDs whose efetch
    batch answers 429. ``hang`` names terms that never answer.
    """

    def __init__(self, hits, esearch_script=None, efetch_429=(), hang=()):
        self.hits = hits
        self.esearch_script = {term: list(codes) for term, codes in (esearch_script or {}).items()}
        self.efetch_429 = set(efetch_429)
        self.hang = set(hang)
        self.calls = []

    def get(self, url, params=None, timeout=None):
        return self._respond(url, params or {})

    def _respond(self, url, params):
        if url.endswith("esearch.fcgi"):
            term = params["term"]
            self.calls.append(("esearch", term))
            if term in self.hang:
                return Hanging()
            script = self.esearch_script.get(term, [])
            if script:
                status = script.pop(0)
                if status != 200:
                    return FakeResponse(status, {})
            return FakeResponse(200, {"esearchresult": {"idlist": list(self.hits.get(term, []))}})
        ids = params["id"].split(",")
        self.calls.append(("efetch", ids[0]))
        if self.efetch_429 & set(ids):
            return FakeResponse(429, "")
        return FakeResponse(200, "<PubmedArticleSet>" + "".join(_article(i) for i in ids) + "</PubmedArticleSet>")


class Hanging(FakeResponse):
    def __init__(self):
        super().__init__(200, {})

    async def __aenter__(self):
        await asyncio.Event().wait()


@pytest.fixture
def fast(monkeypatch):
    """No real waiting: backoff sleeps return at once; budget stays real."""
    real_sleep = asyncio.sleep

    async def no_wait(seconds, *args, **kwargs):
        await real_sleep(0)

    monkeypatch.setattr(pubmed_module.asyncio, "sleep", no_wait)
    monkeypatch.setattr(settings, "PUBMED_RETRY_ROUNDS", 2)
    monkeypatch.setattr(settings, "PUBMED_RETRY_BACKOFF_SECONDS", 10.0)
    monkeypatch.setattr(settings, "PUBMED_SEARCH_BUDGET_SECONDS", 240.0)


def _service(fake: FakeEutils) -> PubMedSearchService:
    service = PubMedSearchService()
    service.min_interval = 0

    async def session():
        return fake

    service._get_session = session
    return service


def _search(service, queries):
    return asyncio.run(service.search_with_subqueries(queries, max_results=300, date_range=(2022, 2026)))


# -- the client says "throttled", not "no hits" ------------------------------


def test_three_429s_raise_throttled_instead_of_returning_no_hits(fast):
    fake = FakeEutils({"q": ["1"]}, esearch_script={"q": [429, 429, 429]})
    service = _service(fake)
    with pytest.raises(PubMedRequestError) as raised:
        asyncio.run(service._esearch("q", 300, (2022, 2026)))
    assert raised.value.reason == "throttled" and raised.value.stage == "esearch"


def test_a_real_empty_answer_is_still_an_empty_answer(fast):
    result = _search(_service(FakeEutils({})), ["nothing"])
    assert result.records == []
    assert [(o.status, o.found) for o in result.outcomes] == [("ok", 0)]
    assert result.unfinished == []


# -- bounded retry --------------------------------------------------------------


def test_a_throttled_sub_query_is_retried_and_recovers(fast):
    fake = FakeEutils(
        {"a": ["1", "2"], "b": ["3"]},
        esearch_script={"b": [429, 429, 429]},  # the whole first attempt is throttled
    )
    result = _search(_service(fake), ["a", "b"])

    assert [o.status for o in result.outcomes] == ["ok", "ok"]
    assert result.outcomes[1].attempts == 2
    assert sorted(r.pmid for r in result.records) == ["1", "2", "3"]


def test_throttling_that_outlasts_the_retry_rounds_is_recorded(fast):
    fake = FakeEutils({"a": ["1"], "b": ["3"]}, esearch_script={"b": [429] * 99})
    result = _search(_service(fake), ["a", "b"])

    assert [o.status for o in result.outcomes] == ["ok", "throttled"]
    assert result.outcomes[1].attempts == 1 + settings.PUBMED_RETRY_ROUNDS
    assert [r.pmid for r in result.records] == ["1"]
    assert len(result.throttled) == 1
    # Bounded: three esearch calls per attempt, one first pass plus two rounds.
    assert sum(1 for kind, term in fake.calls if term == "b") == 3 * (1 + settings.PUBMED_RETRY_ROUNDS)


def test_no_retry_round_starts_past_the_budget(fast, monkeypatch):
    monkeypatch.setattr(settings, "PUBMED_SEARCH_BUDGET_SECONDS", 5.0)  # < first backoff (10 s)
    fake = FakeEutils({"b": ["3"]}, esearch_script={"b": [429] * 99})
    result = _search(_service(fake), ["b"])
    assert result.outcomes[0].status == "throttled"
    assert result.outcomes[0].attempts == 1


def test_a_sub_query_the_budget_cuts_off_is_timed_out_not_empty(fast, monkeypatch):
    monkeypatch.setattr(settings, "PUBMED_SEARCH_BUDGET_SECONDS", 0.2)
    fake = FakeEutils({"a": ["1"]}, hang={"slow"})
    result = _search(_service(fake), ["a", "slow"])
    assert [o.status for o in result.outcomes] == ["ok", "timed_out"]
    assert [r.pmid for r in result.records] == ["1"]


def test_an_efetch_batch_throttled_keeps_the_batches_already_fetched(fast):
    pmids = [str(n) for n in range(1, 251)]  # two efetch batches: 200 + 50
    fake = FakeEutils({"big": pmids}, efetch_429={"250"})
    result = _search(_service(fake), ["big"])

    outcome = result.outcomes[0]
    assert outcome.status == "throttled"
    assert outcome.found == 250 and outcome.fetched == 200
    assert len(result.records) == 200


# -- the job's diagnosis names the throttling -----------------------------------


def _pubmed(throttled: int, total: int, records=()):
    return PubMedSearchResult(
        records=list(records),
        outcomes=[
            SubQueryOutcome(query=f"q{i}", status="throttled" if i < throttled else "ok", attempts=3)
            for i in range(total)
        ],
    )


def test_diagnosis_of_an_empty_throttled_search_blames_pubmed_not_the_literature():
    diagnostics = TaskService()._diagnose_search_results([], [], {}, retrieved_count=0, pubmed=_pubmed(4, 6))
    assert diagnostics.can_proceed is False
    assert diagnostics.retrieval_incomplete
    assert (diagnostics.pubmed_throttled, diagnostics.pubmed_subqueries) == (4, 6)
    assert "PubMed 限流 4/6 个子查询" in diagnostics.diagnosis
    assert "不说明该主题缺少文献" in diagnostics.diagnosis
    assert "未检索到相关文献" not in diagnostics.diagnosis
    assert diagnostics.retrieval_note().startswith("PubMed throttled 4 of 6 sub-queries")


def test_diagnosis_of_a_partial_search_says_it_is_incomplete():
    from models.schemas import LiteratureRecord

    records = [LiteratureRecord(id=str(i), pmid=str(i), title="t") for i in range(3)]
    diagnostics = TaskService()._diagnose_search_results(
        records, [], {}, retrieved_count=3, pubmed=_pubmed(2, 6, records)
    )
    assert diagnostics.can_proceed is True
    assert diagnostics.diagnosis.startswith("检索不完整：PubMed 限流 2/6 个子查询")
    assert diagnostics.status == "low_recall"


def test_a_complete_search_carries_no_throttling_note():
    diagnostics = TaskService()._diagnose_search_results([], [], {}, pubmed=_pubmed(0, 6))
    assert not diagnostics.retrieval_incomplete
    assert "PubMed 限流" not in diagnostics.diagnosis


# -- end to end: runner result and report ----------------------------------------


def _stubbed(monkeypatch, pubmed_result):
    service = TaskService()

    async def understand(_preprocessed):
        return {
            "pico_entities": {"population": [], "intervention": [], "comparison": [], "outcome": []},
            "synonyms": {}, "logical_structure": "",
            "concept_groups": [["hemodialysis"], ["missed sessions", "adherence"]],
            "sub_queries": ["(hemodialysis[Title/Abstract])"],
        }

    async def internal(_text):
        return []

    async def pubmed(sub_queries, max_results, date_range):
        return pubmed_result

    async def module(module_id, **_kwargs):
        return ModuleOutput(module_id=module_id, status="success", data={"ok": True})

    async def report(**kwargs):
        cover = ReportGenerator()._render_cover(
            "t", kwargs["evidence_stats"], "q", None, kwargs.get("search_diagnostics")
        )
        return AnalysisReport(report_id="r", task_id=kwargs["task_id"], title="t",
                              generated_at=datetime.now(), content=cover)

    monkeypatch.setattr(llm_service, "analyze_query_structure", understand)
    monkeypatch.setattr("services.task_service.search_internal_db", internal)
    monkeypatch.setattr(service.pubmed_service, "search_with_subqueries", pubmed)
    monkeypatch.setattr(service.analysis_engine, "execute_module", module)
    monkeypatch.setattr(service.report_generator, "generate", report)
    return service


def test_runner_reports_a_throttled_empty_search_as_retryable(tmp_path, monkeypatch):
    service = _stubbed(monkeypatch, _pubmed(4, 6))

    async def analyze(request, output_dir):
        return await evimed_runner._analyze_with_service(request, output_dir, service)

    monkeypatch.setattr(evimed_runner, "_analyze", analyze)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"researchDirection": "Missed hemodialysis sessions and adherence"}))

    assert evimed_runner.run(request, tmp_path / "out") == 75
    result = json.loads((tmp_path / "out" / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert result["errorCode"] == "pubmed_throttled"
    assert "PubMed 限流 4/6" in result["error"]
    assert result["modules"]["evidenceRetrieval"]["reason"].startswith("PubMed throttled 4 of 6 sub-queries")


def test_a_partial_search_delivers_a_report_that_says_it_is_incomplete(monkeypatch):
    from models.schemas import LiteratureRecord

    records = [
        LiteratureRecord(id=f"pubmed_{i}", pmid=str(i), title=f"Missed sessions in hemodialysis {i}",
                         abstract="hemodialysis missed sessions adherence")
        for i in range(8)
    ]
    service = _stubbed(monkeypatch, _pubmed(2, 6, records))

    async def go():
        task = await service.create_task("Missed hemodialysis sessions and adherence", {})
        return await service.process_task(task.task_id)

    task = asyncio.run(go())
    assert task.status == TaskStatus.COMPLETED, task.error_message
    assert "检索不完整" in task.report.content and "PubMed 限流 2/6" in task.report.content
    modules = evimed_runner._module_ledger(task, task.evidence_records)
    assert modules["evidenceRetrieval"]["status"] == "degraded"
    assert modules["evidenceRetrieval"]["reason"].startswith("PubMed throttled 2 of 6 sub-queries")


def test_the_cover_is_silent_about_retrieval_when_nothing_was_throttled():
    from models.schemas import SearchDiagnostics

    diagnostics = SearchDiagnostics(status="success", pubmed_subqueries=6)
    assert ReportGenerator._incomplete_retrieval_notice(diagnostics) == ""
    assert ReportGenerator._incomplete_retrieval_notice(None) == ""
