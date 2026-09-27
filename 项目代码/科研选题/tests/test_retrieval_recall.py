"""Retrieval recall and the thin-evidence path (2026-09-27 incident).

Production job topic-20260927082804 (brief ordinary-constrained-cohort,
"Identify actionable questions about missed dialysis sessions and
adherence.") failed after 31 s with "仅检索到2篇相关文献…系统将执行简化分析"
and no report. Replayed live the same day, retrieval had found 688 records;
the relevance filter kept 3. It made every PICO entity its own required
phrase, so "missed dialysis sessions" and "adherence" each had to appear
verbatim in every paper, although the model's own sub-queries ORed them.
Then the blueprint refused anything under five records, although the
diagnosis had just cleared one-to-four records for a thin-evidence report.

``tests/data/missed_dialysis_retrieval_2026_09_27.json`` holds 48 of those
688 records verbatim, the pre-fix query structure, and the concept groups
the revised prompt produced live.
"""

import asyncio
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

import evimed_runner
from core.new_report_generator import ReportGenerator
from models.schemas import (
    AnalysisReport,
    EvidenceStats,
    LiteratureRecord,
    ModuleOutput,
    SearchDiagnostics,
    TaskStatus,
)
from services.llm_service import LLMService, llm_service
from services.pubmed_service import PubMedSearchResult, SubQueryOutcome
from services.task_service import TaskService

DATA = Path(__file__).parent / "data"
RECORDED = json.loads(
    (DATA / "missed_dialysis_retrieval_2026_09_27.json").read_text(encoding="utf-8")
)
RECORDS = [LiteratureRecord.model_validate(item) for item in RECORDED["records"]]


def _text(record):
    return TaskService._normalized_evidence_text(
        " ".join([record.title or "", record.abstract or "", *record.keywords, *record.mesh_terms])
    )


# -- (a) the relevance filter reads the model's concept groups ---------------


def test_per_entity_filter_is_what_kept_three_of_688():
    """The recorded incident, reproduced on the recorded records."""
    kept = TaskService._filter_relevant_records(
        RECORDS, RECORDED["legacy_query_structure"], raw_query=RECORDED["direction"]
    )
    assert RECORDED["retrieved_total"] == 688
    assert RECORDED["legacy_kept_total"] == 3
    assert len(kept) == 3


def test_declared_concept_groups_decide_what_a_relevant_record_is():
    structure = {**RECORDED["legacy_query_structure"], "concept_groups": RECORDED["concept_groups"]}
    kept = TaskService._filter_relevant_records(RECORDS, structure, raw_query=RECORDED["direction"])

    assert len(kept) == 33
    groups = TaskService._required_concept_groups(structure)
    assert len(groups) == 2
    for record in kept:
        text = f" {_text(record)} "
        assert all(any(f" {form} " in text for form in group) for group in groups)
    # The filter still filters: records addressing neither concept stay out.
    assert len(kept) < len(RECORDS)


def test_groups_drop_generic_words_and_malformed_entries():
    groups = TaskService._required_concept_groups(
        {"concept_groups": [["Patients", "Hemodialysis"], ["adults"], "not-a-group", [7, ""]]}
    )
    assert groups == [{"hemodialysis"}]


def test_query_understanding_keeps_well_formed_concept_groups_only():
    parsed = LLMService()._validate_query_structure(
        {
            "pico_entities": {},
            "logical_structure": "x",
            "concept_groups": [["hemodialysis", " dialysis "], [], ["adherence", 3], "loose"],
        }
    )
    assert parsed["concept_groups"] == [["hemodialysis", "dialysis"], ["adherence"]]


def test_the_prompt_asks_for_the_groups_the_filter_reads():
    prompt = LLMService()._build_query_understanding_prompt(
        SimpleNamespace(cleaned=RECORDED["direction"])
    )
    assert '"concept_groups"' in prompt


# -- retrieval runs the same structure the filter applies --------------------


def test_concept_groups_compose_one_pubmed_query():
    query = LLMService.concept_groups_query(
        [["hemodialysis", "end-stage renal disease"], ['missed "sessions"', "adherence", "Adherence"]]
    )
    assert query == (
        '(("hemodialysis"[Title/Abstract] OR "end-stage renal disease"[Title/Abstract]) AND '
        '("missed sessions"[Title/Abstract] OR "adherence"[Title/Abstract]))'
    )
    assert LLMService.concept_groups_query([["dialysis"]]) == '("dialysis"[Title/Abstract])'
    assert LLMService.concept_groups_query([]) == ""


def test_multi_source_search_runs_the_groups_query_beside_the_model_queries(monkeypatch):
    service = TaskService()
    seen = {}

    async def no_internal(_text):
        return []

    async def capture(sub_queries, max_results, date_range):
        seen["sub_queries"] = list(sub_queries)
        return PubMedSearchResult(records=[], outcomes=[])

    monkeypatch.setattr("services.task_service.search_internal_db", no_internal)
    monkeypatch.setattr(service.pubmed_service, "search_with_subqueries", capture)
    structure = {
        "sub_queries": ["(hemodialysis[Title/Abstract])"],
        "concept_groups": RECORDED["concept_groups"],
    }
    _, sub_queries, _ = asyncio.run(service._multi_source_search(RECORDED["direction"], structure))

    groups_query = LLMService.concept_groups_query(RECORDED["concept_groups"])
    assert seen["sub_queries"] == ["(hemodialysis[Title/Abstract])", groups_query]
    assert sub_queries == seen["sub_queries"]


# -- the diagnosis says which step thinned the evidence ----------------------


def test_diagnosis_distinguishes_retrieval_from_filtering():
    service = TaskService()
    structure = {"concept_groups": [["hemodialysis"], ["missed sessions"]]}

    thin = service._diagnose_search_results(RECORDS[:3], [], structure, retrieved_count=688)
    assert thin.status == "low_recall" and thin.can_proceed
    assert "检索到688篇" in thin.diagnosis and "仅纳入3篇" in thin.diagnosis
    assert "「hemodialysis」" in thin.diagnosis
    assert "简化分析" not in thin.diagnosis and "仅检索到" not in thin.diagnosis

    none = service._diagnose_search_results([], [], structure, retrieved_count=688)
    assert none.status == "no_results" and not none.can_proceed
    assert "检索到688篇" in none.diagnosis and "没有文献同时涉及全部核心概念" in none.diagnosis


# -- (b) a thin evidence base delivers a marked report -----------------------


def _stubbed_service(monkeypatch, records):
    service = TaskService()

    async def understand(_preprocessed):
        return {
            "pico_entities": {"population": [], "intervention": [], "comparison": [], "outcome": []},
            "synonyms": {},
            "logical_structure": "",
            "concept_groups": RECORDED["concept_groups"],
            "sub_queries": ["(hemodialysis[Title/Abstract])"],
        }

    async def internal(_text):
        return []

    async def pubmed(sub_queries, max_results, date_range):
        return PubMedSearchResult(
            records=list(records),
            outcomes=[SubQueryOutcome(query=q, status="ok", attempts=1) for q in sub_queries],
        )

    async def module(module_id, **_kwargs):
        return ModuleOutput(module_id=module_id, status="success", data={"ok": True})

    async def report(**kwargs):
        cover = ReportGenerator()._render_cover(
            "thin", kwargs["evidence_stats"], RECORDED["direction"]
        )
        return AnalysisReport(
            report_id="r", task_id=kwargs["task_id"], title="thin",
            generated_at=datetime.now(), content=cover,
        )

    monkeypatch.setattr(llm_service, "analyze_query_structure", understand)
    monkeypatch.setattr("services.task_service.search_internal_db", internal)
    monkeypatch.setattr(service.pubmed_service, "search_with_subqueries", pubmed)
    monkeypatch.setattr(service.analysis_engine, "execute_module", module)
    monkeypatch.setattr(service.report_generator, "generate", report)
    return service


def _run(service):
    async def go():
        task = await service.create_task(RECORDED["direction"], {})
        return await service.process_task(task.task_id)

    return asyncio.run(go())


def test_a_job_with_three_relevant_records_completes_with_a_report(monkeypatch):
    structure = {"concept_groups": RECORDED["concept_groups"]}
    relevant = TaskService._filter_relevant_records(RECORDS, structure, raw_query="")[:3]
    service = _stubbed_service(monkeypatch, relevant)

    task = _run(service)

    assert task.status == TaskStatus.COMPLETED, task.error_message
    assert task.report is not None
    assert task.blueprint.can_proceed is True
    assert task.blueprint.search_diagnostics.status == "low_recall"
    assert "证据基础薄弱" in task.report.content


def test_a_job_with_no_relevant_record_fails_naming_the_filter(monkeypatch):
    unrelated = [
        LiteratureRecord(id="x", pmid="1", title="Fluid infusion in postpartum hemorrhage"),
    ]
    service = _stubbed_service(monkeypatch, unrelated)

    task = _run(service)

    assert task.status == TaskStatus.FAILED
    assert task.report is None
    assert "检索到1篇" in task.error_message
    assert "没有文献同时涉及全部核心概念" in task.error_message


def test_the_cover_marks_a_thin_evidence_base_and_only_then():
    thin = ReportGenerator._thin_evidence_notice(EvidenceStats(evidence_count=3))
    assert "证据基础薄弱" in thin and "3 篇" in thin
    assert ReportGenerator._thin_evidence_notice(EvidenceStats(evidence_count=5)) == ""


def test_runner_ledger_marks_a_thin_evidence_base_degraded():
    diagnostics = SearchDiagnostics(
        status="low_recall", retrieved_count=3, diagnosis="检索到688篇文献…仅纳入3篇", can_proceed=True
    )
    completed = SimpleNamespace(
        module_outputs={},
        blueprint=SimpleNamespace(search_diagnostics=diagnostics),
    )
    modules = evimed_runner._module_ledger(completed, RECORDS[:3])
    assert modules["evidenceRetrieval"] == {"status": "degraded", "reason": diagnostics.diagnosis}
    assert evimed_runner._degraded(modules)

    ample = SimpleNamespace(module_outputs={}, blueprint=None)
    assert evimed_runner._module_ledger(ample, RECORDS)["evidenceRetrieval"] == {"status": "ok"}


@pytest.mark.parametrize("count", [1, 4])
def test_blueprint_follows_the_diagnosis(count):
    service = TaskService()
    diagnostics = service._diagnose_search_results(RECORDS[:count], [], {}, retrieved_count=688)
    blueprint = service._create_analysis_blueprint(
        SimpleNamespace(task_id="t"),
        EvidenceStats(evidence_count=count),
        SimpleNamespace(enabled_modules=[], resource_estimate={}),
        diagnostics,
    )
    assert blueprint.can_proceed is True
