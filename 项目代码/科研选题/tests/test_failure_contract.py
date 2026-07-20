import asyncio
import json
from types import SimpleNamespace

import pytest

from models.schemas import LiteratureRecord, ModuleOutput, TaskStatus
from services.llm_service import LLMService
from services.task_service import TaskService
from services.pubmed_service import PubMedSearchService
from core.new_report_generator import ReportGenerator


def test_live_query_understanding_fails_closed_when_the_model_is_unavailable(monkeypatch):
    service = LLMService()
    service.client = object()

    async def unavailable(*args, **kwargs):
        raise RuntimeError("upstream unavailable")

    monkeypatch.setattr(service, "complete", unavailable)

    with pytest.raises(RuntimeError, match="停止生成"):
        asyncio.run(service.analyze_query_structure(SimpleNamespace(cleaned="test topic")))


def test_report_finalization_rejects_default_failure_payloads():
    service = TaskService()
    task = SimpleNamespace(
        task_id="test-task",
        module_outputs={
            "M1_PROBLEM_LANDSCAPE": ModuleOutput(
                module_id="M1_PROBLEM_LANDSCAPE",
                status="success",
                data={"deep_analysis": "分析生成失败，使用默认输出。"},
            )
        },
        phase=None,
        current_phase="",
        status=TaskStatus.PROCESSING,
        error_message=None,
        updated_at=None,
    )

    with pytest.raises(RuntimeError, match="核心分析模块未产生有效结果"):
        asyncio.run(service._finalize_analysis(task))

    assert task.status == TaskStatus.FAILED


def test_pico_relevance_gate_removes_broad_query_contamination():
    records = [
        LiteratureRecord(
            id="relevant",
            pmid="1",
            title="Model-informed precision dosing of beta-lactam antibiotics in critically ill adults",
            abstract="Therapeutic drug monitoring of anti-bacterial agents in critical illness.",
        ),
        LiteratureRecord(
            id="tacrolimus",
            pmid="2",
            title="Tacrolimus therapeutic drug monitoring in adult kidney transplantation",
            abstract="Population pharmacokinetics after transplantation.",
        ),
        LiteratureRecord(
            id="nutrition",
            pmid="3",
            title="Enteral nutrition in critically ill adults",
            abstract="Phosphate monitoring in intensive care.",
        ),
    ]
    query_structure = {
        "pico_entities": {
            "population": ["Critical Illness", "Adult"],
            "intervention": ["Drug Monitoring", "Anti-Bacterial Agents"],
        },
        "synonyms": {
            "Critical Illness": ["critically ill", "intensive care"],
            "Drug Monitoring": ["therapeutic drug monitoring", "precision dosing"],
            "Anti-Bacterial Agents": ["antibiotics", "beta-lactam"],
        },
    }

    filtered = TaskService._filter_relevant_records(records, query_structure)

    assert [record.pmid for record in filtered] == ["1"]


def test_adult_scope_excludes_pediatric_and_mixed_pediatric_records():
    records = [
        LiteratureRecord(
            id="adult",
            pmid="1",
            title="Precision dosing in critically ill adult patients",
            abstract="An adult intensive care cohort.",
        ),
        LiteratureRecord(
            id="pediatric",
            pmid="2",
            title="Precision dosing in critically ill children",
            abstract="A pediatric intensive care cohort.",
        ),
        LiteratureRecord(
            id="mixed",
            pmid="3",
            title="Precision dosing in children and young adults",
            abstract="A mixed pediatric and adult cohort.",
        ),
        LiteratureRecord(
            id="hospital",
            pmid="4",
            title="Hospital-wide antimicrobial monitoring implementation",
            abstract="Utilization was high in adult intensive care; Pediatrics: 0%.",
        ),
    ]

    filtered = TaskService._filter_relevant_records(
        records,
        {"pico_entities": {}, "synonyms": {}},
        raw_query="precision dosing in critically ill adults",
    )

    assert [record.pmid for record in filtered] == ["1", "4"]


def test_chinese_adult_scope_excludes_chinese_pediatric_population():
    records = [
        LiteratureRecord(id="adult", pmid="1", title="Precision dosing", title_zh="成人重症患者精准给药"),
        LiteratureRecord(id="child", pmid="2", title="Precision dosing", title_zh="儿童重症患者精准给药"),
    ]

    filtered = TaskService._filter_relevant_records(
        records,
        {"pico_entities": {}, "synonyms": {}},
        raw_query="成人重症患者的抗菌药精准给药",
    )

    assert [record.pmid for record in filtered] == ["1"]


@pytest.mark.parametrize(
    ("title", "abstract", "expected"),
    [
        ("Clinical trial protocol for beta-lactam monitoring", "Patients will be randomized.", "Protocol"),
        ("International survey of antibiotic dosing", "Intensivists completed a questionnaire.", "Cross-sectional"),
        ("A systematic review of population pharmacokinetic studies", "We systematically reviewed studies.", "Systematic Review"),
        ("Target attainment analysis for meropenem dosing", "Monte Carlo simulations were conducted.", "Pharmacometric Study"),
        ("Effectiveness and safety of beta-lactams", "Patients were followed prospectively; in vitro susceptibility was also measured.", "Cohort"),
    ],
)
def test_pubmed_design_classifier_uses_explicit_design_cues(title, abstract, expected):
    assert PubMedSearchService()._identify_study_design(
        [], mesh_terms=["Humans"], abstract=abstract, title=title
    ) == expected


def test_report_outline_retries_truncated_json_and_filters_unknown_modules(monkeypatch):
    responses = iter([
        '{"M1_PROBLEM_LANDSCAPE": {"chapter_title": "未完成"',
        json.dumps({
            "M1_PROBLEM_LANDSCAPE": {
                "chapter_title": "问题图谱",
                "subsections": [
                    {"title": "异质性", "key_argument": "PK变异", "evidence_needed": "队列"},
                    {"title": "给药", "key_argument": "TDM", "evidence_needed": "RCT"},
                ],
            },
            "UNRELATED_MODULE": {"chapter_title": "不应出现", "subsections": []},
        }, ensure_ascii=False),
    ])
    calls = []

    async def complete(*args, **kwargs):
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr("core.new_report_generator.llm_service.complete", complete)
    materials = {
        "all_key_insights": ["重症成人抗菌药精准给药"],
        "module_data": {"M1_PROBLEM_LANDSCAPE": {}},
        "evidence_stats_summary": {"total_papers": 12, "clinical_ratio": 0.75},
    }

    result = asyncio.run(ReportGenerator()._generate_outline("测试主题", materials))

    assert list(result) == ["M1_PROBLEM_LANDSCAPE"]
    assert len(result["M1_PROBLEM_LANDSCAPE"]["subsections"]) == 2
    assert len(calls) == 2
    assert calls[1]["max_tokens"] == 6000


def test_report_summary_drops_only_a_trailing_truncated_fragment():
    text = (
        "第一句完整报告精准给药的证据现状。"
        "第二句完整说明随机证据仍有不足。"
        "这些矛盾启示我们，疗效预测模型"
        "\n\n"
        "下一段是完整的结论。"
    )

    repaired, count = ReportGenerator._drop_incomplete_trailing_fragments(text)

    assert count == 1
    assert "疗效预测模型" not in repaired
    assert "第二句完整说明随机证据仍有不足。" in repaired
    assert repaired.endswith("下一段是完整的结论。")


def test_task_service_close_releases_owned_pubmed_session(monkeypatch):
    service = TaskService()
    calls = []

    async def close():
        calls.append("closed")

    monkeypatch.setattr(service.pubmed_service, "close", close)
    asyncio.run(service.close())

    assert calls == ["closed"]
