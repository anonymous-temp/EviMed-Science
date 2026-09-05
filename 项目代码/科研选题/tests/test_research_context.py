"""Resource constraints and actionable, evidence-linked portfolio contracts."""

import asyncio
from collections import OrderedDict
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
    from evimed_runner import _analyze_with_service, revalidate_existing

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
    assert json.loads((tmp_path / "research-topic-run.json").read_text())["researchContext"] == CONTEXT
    assert CONTEXT["availableData"] in (tmp_path / "research-topic-report.md").read_text()
    revalidate_existing(tmp_path, "Dialysis")
    assert CONTEXT["availableData"] in (tmp_path / "research-topic-report.md").read_text()


def test_fallback_opportunities_do_not_manufacture_scores():
    record = LiteratureRecord(id="pubmed_420001", pmid="420001", title="Dialysis adherence",
                              abstract="Observational data on adherence.")
    opportunities = M5_BreakthroughOpportunityModule._fallback_opportunities([record], "Dialysis")
    assert opportunities
    assert all(not any(key.endswith("_score") for key in item) for item in opportunities)


def test_topic_scatter_does_not_plot_missing_scores_as_half(monkeypatch):
    import modules.new_analysis_modules as analysis_modules

    calls = []
    monkeypatch.setattr(analysis_modules, "MATPLOTLIB_AVAILABLE", True)
    monkeypatch.setattr(
        analysis_modules,
        "plt",
        SimpleNamespace(subplots=lambda *args, **kwargs: calls.append((args, kwargs))),
        raising=False,
    )
    result = M6_ResearchAgendaModule()._create_topic_scatter_chart([
        {"title": "Candidate A"},
        {"title": "Candidate B"},
    ])
    assert result is None
    assert calls == []


@pytest.mark.parametrize("agenda_key", ["topics", "research_topics"])
def test_m6_validates_topics_before_any_quantitative_chart(monkeypatch, agenda_key):
    module = M6_ResearchAgendaModule()
    source = {
        "opportunity_id": "BOM1",
        "title": "Bounded validation opportunity",
        "evidence_pmids": ["420001"],
        "support_level": "indirect",
    }
    raw = {
        "source_opportunity_id": "BOM1",
        "title": "Candidate",
        "feasibility_score": 0.5,
        "novelty_score": 0.5,
        "priority_score": 0.5,
    }
    monkeypatch.setattr(
        module,
        "_generate_research_agenda",
        AsyncMock(return_value={agenda_key: [raw]}),
    )
    chart = AsyncMock(return_value=None)
    monkeypatch.setattr(module, "_create_chart_safe", chart)
    standardized = StandardizedInput(
        core_entities={},
        query_terms={"en": ["Dialysis"]},
        research_context="",
    )
    dependencies = {
        "M5_BREAKTHROUGH_OPPORTUNITY": ModuleOutput(
            module_id="M5_BREAKTHROUGH_OPPORTUNITY",
            status="success",
            data={"opportunities": [source]},
        )
    }
    output = asyncio.run(module.execute(
        standardized,
        [],
        EvidenceStats(evidence_count=0),
        dependencies,
    ))
    plotted = chart.await_args.args[1]
    assert plotted == output.data["research_topics"]
    assert all(not any(key.endswith("_score") for key in item) for item in plotted)


def test_context_defaults_boundaries_and_escaped_report_values():
    from core.research_context import context_prompt, render_research_context, validate_research_context

    assert validate_research_context(None) == {}
    assert context_prompt("") == ""
    assert render_research_context({}) == ""
    assert validate_research_context({"resourceConstraints": []}) == {"resourceConstraints": []}
    boundary = {"availableData": "a" * 4000, "population": "b" * 1000,
                "studySetting": "c" * 1000, "resourceConstraints": ["d" * 200] * 20}
    assert validate_research_context(boundary) == boundary
    rendered = render_research_context({"availableData": "Records\n## Embedded heading"})
    assert "\\n## Embedded heading" in rendered
    assert "\n## Embedded heading" not in rendered


def test_portfolio_rejects_unreconciled_lineage_and_preserves_json_descriptions():
    from core.research_portfolio import _description, build_research_portfolio

    assert _description(" ") is None
    assert _description([]) is None
    assert _description(50) is None
    assert _description({"basis": float("nan")}) is None
    assert _description({"basis": object()}) is None
    assert _description(["Attendance", "Transport"]) == ["Attendance", "Transport"]
    topic = {"source_opportunity_id": "BOM1", "source_evidence_pmids": ["420001"], "support_level": "indirect"}
    source = {"opportunity_id": "BOM1", "evidence_pmids": ["420001"], "support_level": "indirect"}
    evidence = [LiteratureRecord(id="internal_retained", pmid="420001", doi="10.1000/example", title="Prior study")]
    with pytest.raises(ValueError, match="unknown source"):
        build_research_portfolio("Dialysis", {}, [topic], [], evidence)
    with pytest.raises(ValueError, match="unknown evidence"):
        build_research_portfolio("Dialysis", {}, [topic], [source], [])
    with pytest.raises(ValueError, match="inherit"):
        build_research_portfolio("Dialysis", {}, [{**topic, "source_evidence_pmids": []}], [source], evidence)
    result = build_research_portfolio("Dialysis", {}, [topic], [source], evidence)
    assert result["candidates"][0]["sourceEvidenceIds"] == ["internal_retained"]


def test_report_prompts_cannot_reintroduce_removed_topic_scores():
    from config.prompts import M5_BREAKTHROUGH_OPPORTUNITY_PROMPT, M6_RESEARCH_AGENDA_PROMPT
    from core.new_report_generator import ReportGenerator

    generator = ReportGenerator()
    material = {
        "priority_ranking": [{"opportunity_id": "BOM1", "priority_score": 0.93}],
        "opportunities": [{
            "opportunity_id": "BOM1",
            "title": "Bounded opportunity",
            "priority_score": 0.93,
            "feasibility_score": 0.72,
            "novelty_score": 0.81,
            "clinical_impact_score": 0.88,
            "support_level": "indirect",
            "evidence_pmids": ["420001"],
        }],
        "research_topics": [{
            "topic_id": "R1",
            "title": "Bounded topic",
            "priority_score": 0.91,
            "feasibility_score": 0.69,
            "novelty_score": 0.80,
            "support_level": "indirect",
            "source_evidence_pmids": ["420001"],
        }],
    }
    summary = generator._summarize_module_data(material)
    prompt = generator._build_chapter_prompt(
        chapter_num=7,
        module_id="M6_RESEARCH_AGENDA",
        module_name="Research agenda",
        module_data=material,
        key_insights=[],
        supporting_evidence=[],
        charts=[],
        chapter_outline={},
        query_context="Dialysis",
        citation_pool=OrderedDict(),
        m5_opportunities=material["opportunities"],
    )
    methodology = generator._render_methodology(EvidenceStats(evidence_count=0), "Dialysis")
    for output in (summary, prompt, methodology, M5_BREAKTHROUGH_OPPORTUNITY_PROMPT, M6_RESEARCH_AGENDA_PROMPT):
        assert "priority_score" not in output
        assert "feasibility_score" not in output
        assert "novelty_score" not in output
    assert "优先级评分" not in prompt
    assert "优先级综合评分（第6–7章）" not in methodology
    assert "支持层级=indirect" in summary
    assert "PMID=420001" in summary


@pytest.mark.parametrize("score_text", [
    "**优先级评分**：综合0.92",
    "priority_score: 0.92",
])
def test_release_rejects_a_numeric_priority_score_reintroduced_in_report_prose(score_text):
    from evimed_runner import _validate_release

    completed = SimpleNamespace(evidence_records=[], module_outputs={})
    with pytest.raises(RuntimeError, match="uncalibrated priority score"):
        _validate_release(completed, "# Research agenda\n\n" + score_text)


def test_duplicate_opportunity_and_candidate_ids_are_rejected():
    from core.research_portfolio import build_research_portfolio

    records = [
        LiteratureRecord(id="pubmed_420001", pmid="420001", title="First evidence", abstract="Observed association."),
        LiteratureRecord(id="pubmed_430001", pmid="430001", title="Second evidence", abstract="Independent result."),
    ]
    raw = [
        {"opportunity_id": "BOM1", "title": "First", "evidence_pmids": ["420001"]},
        {"opportunity_id": "BOM1", "title": "Second", "evidence_pmids": ["430001"]},
    ]
    with pytest.raises(ValueError, match="duplicate opportunity"):
        M5_BreakthroughOpportunityModule._validate_opportunities(raw, records)
    with pytest.raises(ValueError, match="duplicate opportunity"):
        build_research_portfolio("Dialysis", {}, [], raw, records)

    sources = [
        {"opportunity_id": "BOM1", "title": "First", "evidence_pmids": ["420001"], "support_level": "indirect"},
        {"opportunity_id": "BOM2", "title": "Second", "evidence_pmids": ["430001"], "support_level": "indirect"},
    ]
    topics = M6_ResearchAgendaModule._validate_topics([
        {"topic_id": "R1", "source_opportunity_id": "BOM1"},
        {"topic_id": "R1", "source_opportunity_id": "BOM2"},
    ], sources)
    with pytest.raises(ValueError, match="duplicate candidate"):
        build_research_portfolio("Dialysis", {}, topics, sources, records)


def test_malformed_design_values_remain_explicit_portfolio_gaps():
    from core.research_portfolio import build_research_portfolio

    source = {
        "opportunity_id": "BOM1",
        "title": "Bounded opportunity",
        "evidence_pmids": ["420001"],
        "support_level": "indirect",
    }
    raw = {
        "topic_id": "R1",
        "source_opportunity_id": "BOM1",
        "hypothesis": ["not", "a", "scientific statement"],
        "study_design": [],
        "estimand": {},
    }
    validated = M6_ResearchAgendaModule._validate_topics([raw], [source])
    evidence = [LiteratureRecord(id="pubmed_420001", pmid="420001", title="Evidence")]
    candidate = build_research_portfolio("Dialysis", {}, validated, [source], evidence)["candidates"][0]
    assert candidate["hypothesis"] is None
    assert candidate["studyDesign"] is None
    assert candidate["estimand"] is None
    assert {"hypothesis", "studyDesign", "estimand"}.issubset(candidate["gaps"])
