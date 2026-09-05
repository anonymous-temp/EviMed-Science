"""Resource constraints and actionable, evidence-linked portfolio contracts."""

import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from models.schemas import EvidenceStats, LiteratureRecord, ModuleOutput, StandardizedInput, TaskStatus
from modules.new_analysis_modules import M5_BreakthroughOpportunityModule, M6_ResearchAgendaModule
from services.task_service import TaskService


CONTEXT = {
    "availableData": "Existing records from 240 adults; no biospecimens",
    "population": "Adults receiving maintenance dialysis",
    "studySetting": "One community hospital",
    "resourceConstraints": ["Six months", "No prospective recruitment", "One part-time analyst"],
}


def test_task_persists_validated_context_without_changing_retrieval_direction():
    service = TaskService()
    options = deepcopy(CONTEXT)
    task = asyncio.run(service.create_task("Dialysis treatment adherence", options))
    assert task.input_text == "Dialysis treatment adherence"
    assert task.options == CONTEXT
    options["resourceConstraints"].append("Caller mutation")
    assert task.options["resourceConstraints"] == CONTEXT["resourceConstraints"]
    standardized = service._build_standardized_input(None, {}, task.options)
    assert json.loads(standardized["research_context"]) == task.options


@pytest.mark.parametrize("options", [
    {"availableData": {"path": "private.csv"}}, {"population": ["adults"]},
    {"studySetting": 5}, {"resourceConstraints": "low budget"},
    {"resourceConstraints": ["six months", {}]}, {"resourceConstraints": [""]},
    {"resourceConstraints": ["x"] * 21}, {"availableData": "x" * 4001},
    {"population": "x" * 1001}, {"resourceConstraints": ["x" * 201]},
    {"resourceConstraints": None}, {"command": "run arbitrary input"}, [],
])
def test_task_rejects_invalid_context_before_creating_state(options):
    service = TaskService()
    with pytest.raises(ValueError):
        asyncio.run(service.create_task("Dialysis treatment adherence", options))
    assert service.tasks == {}


@pytest.mark.parametrize("module_class,method,result", [
    (M5_BreakthroughOpportunityModule, "_mine_breakthrough_opportunities", {"opportunities": []}),
    (M6_ResearchAgendaModule, "_generate_research_agenda", {"research_topics": []}),
])
def test_modules_receive_supplied_research_context(monkeypatch, module_class, method, result):
    module = module_class()
    captured = AsyncMock(return_value=result)
    monkeypatch.setattr(module, method, captured)
    monkeypatch.setattr(module, "_create_chart_safe", AsyncMock(return_value=None))
    standardized = StandardizedInput(
        core_entities={}, query_terms={"en": ["Dialysis"]},
        research_context=json.dumps(CONTEXT),
    )
    asyncio.run(module.execute(standardized, [], EvidenceStats(evidence_count=0)))
    prompt_context = captured.call_args.args[-1]
    for value in CONTEXT["resourceConstraints"]:
        assert value in prompt_context
    assert CONTEXT["availableData"] in prompt_context


def test_portfolio_retains_supplied_design_and_explicit_gaps():
    from core.research_portfolio import build_research_portfolio

    source = {"opportunity_id": "BOM1", "title": "Residual adherence uncertainty", "evidence_pmids": ["420001"],
              "support_level": "indirect", "support_rationale": "Single observational study"}
    topic = {"topic_id": "R1", "source_opportunity_id": "BOM1", "title": "Adherence and missed sessions",
             "hypothesis": "Missed sessions are associated with transport access",
             "study_design": {"type": "Retrospective cohort", "rationale": "Available records"},
             "estimand": "Adjusted risk difference", "data_requirements": ["Transport access", "Attendance"],
             "falsification": "No adjusted association", "feasibility": {"basis": "Existing records"},
             "novelty_basis": {"closest_work_pmids": ["420001"], "remaining_question": "Community setting"}}
    validated = M6_ResearchAgendaModule._validate_topics([topic], [source])
    evidence = [LiteratureRecord(id="pubmed_420001", pmid="420001", title="Prior adherence study")]
    portfolio = build_research_portfolio("Dialysis", CONTEXT, validated, [source], evidence)
    candidate = portfolio["candidates"][0]
    assert portfolio["schemaVersion"] == "1.0.0"
    assert portfolio["researchDirection"] == "Dialysis"
    assert portfolio["researchContext"] == CONTEXT
    assert candidate["sourceEvidenceIds"] == ["pubmed_420001"]
    assert candidate["sourceOpportunityId"] == "BOM1"
    assert candidate["studyDesign"] == topic["study_design"]
    assert candidate["estimand"] == topic["estimand"]
    assert candidate["dataRequirements"] == topic["data_requirements"]
    assert candidate["falsification"] == topic["falsification"]
    assert candidate["noveltyBasis"] == topic["novelty_basis"]
    assert candidate["gaps"] == []
    minimal = M6_ResearchAgendaModule._validate_topics([], [source])
    assert all("score" not in key for key in minimal[0])
    candidate = build_research_portfolio("Dialysis", {}, minimal, [source], evidence)["candidates"][0]
    assert candidate["estimand"] is None
    assert "estimand" in candidate["gaps"]
    assert "hypothesis" in candidate["gaps"]
    assert candidate["noveltyBasis"] is None
    assert "noveltyBasis" in candidate["gaps"]


def test_runner_passes_context_and_returns_portfolio(tmp_path):
    from evimed_runner import _analyze_with_service

    report = SimpleNamespace(content="Evidence-limited research agenda. " * 10)
    completed = SimpleNamespace(status=TaskStatus.COMPLETED, report=report, module_outputs={},
                                evidence_records=[], evidence_stats={}, error_message=None)
    service = SimpleNamespace(create_task=AsyncMock(return_value=SimpleNamespace(task_id="task-1")),
                              process_task=AsyncMock(return_value=completed))
    receipt = asyncio.run(_analyze_with_service({"researchDirection": "Dialysis", **CONTEXT}, tmp_path, service))
    service.create_task.assert_awaited_once_with("Dialysis", CONTEXT)
    assert "research-portfolio.json" in receipt["artifacts"]
    portfolio = json.loads((tmp_path / "research-portfolio.json").read_text())
    assert portfolio["researchContext"] == CONTEXT
    assert CONTEXT["availableData"] in (tmp_path / "research-topic-report.md").read_text()
