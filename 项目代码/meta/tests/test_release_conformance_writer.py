"""The writer produces what the release gate checks, from the engine's own records.

Cases come from the ma-001 manuscript (TXA in primary TKA) that the gate
blocked on PRISMA flow, cross-references, readability and calculation detail.
"""
from __future__ import annotations

from pathlib import Path

from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.artifact_package import _build_prisma_audit_review
from new_meta.core.artifact_package_manifest import _has_calculation_detail
from new_meta.core.manuscript_facts import _prisma_facts
from new_meta.core.project import Project

MA001_PRISMA_FLOW = {
    "identification": {
        "records_identified": 400,
        "records_after_dedup": 398,
        "duplicates_removed": 2,
        "records_not_screened": 248,
        "automation_excluded": 248,
        "records_not_screened_reasons": {"relevance cap before screening": 248},
    },
    "screening": {"title_abstract_screened": 150, "title_abstract_excluded": 101},
    "eligibility": {"full_text_assessed": 14, "full_text_excluded": 11},
    "included": {"studies_included": 3},
}

MA001_SYNTHESIS = {
    "estimator": "DESIGN_AWARE_REML_HKSJ",
    "n_studies": 3,
    "primary_estimates": [{
        "measure": "MD",
        "estimate": -303.2265806852571,
        "ci_lower": -504.51984194942247,
        "ci_upper": -101.93331942109168,
        "prediction_lower": -2730.381643234127,
        "prediction_upper": 2123.928481863613,
    }],
    "heterogeneity": {"tau_squared": 25941.694303702847, "i_squared": 83.37866097349779, "q": 12.032724901471903},
    "engine_payload": {
        "measure": "MD",
        "n_contrasts": 3,
        "standard_error_analysis_scale": 102.70253068522736,
        "design_counts": {"multi_arm_rct": 3},
        "study_effects": [
            {"study_id": "study:28326403", "analysis_effect": -329.69999999999993, "variance": 7363.488146551725},
            {"study_id": "study:33511201", "analysis_effect": -458.0, "variance": 3942.5924369747895},
            {"study_id": "study:34566475", "analysis_effect": -112.5, "variance": 5984.607142857144},
        ],
        "sensitivity": {"HKSJ": {"estimate": -303.0174996601474, "ci_lower": -759.4317794697145, "ci_upper": 153.3967801494196}},
    },
}

MA001_ROWS = [
    {"study_id": "study:28326403", "study_label": "Alexandru 2016"},
    {"study_id": "study:33511201", "study_label": "Shih-Hsiang 2021"},
    {"study_id": "study:34566475", "study_label": "Montovanelli 2021"},
]


# ── prisma_flow ───────────────────────────────────────────────────────────


def test_prisma_facts_carry_the_records_removed_before_screening() -> None:
    prisma = _prisma_facts(MA001_PRISMA_FLOW)

    assert prisma["records_not_screened"] == 248
    assert prisma["records_not_screened_reasons"] == {"relevance cap before screening": 248}
    assert prisma["title_abstract_screened"] == 150


def test_screening_sentence_reports_the_screened_count_from_the_ledger(tmp_path: Path) -> None:
    prisma = _prisma_facts(MA001_PRISMA_FLOW)
    zh = WritingAgent(lang="zh")._screening_entry_phrase(prisma, "经跨来源去重和同源记录合并（移除2条）后剩余398条")
    en = WritingAgent(lang="en")._screening_entry_phrase(prisma, "after deduplication removed 2 records, 398 unique records remained")

    assert zh == (
        "经跨来源去重和同源记录合并（移除2条）后剩余398条；"
        "其中248条因相关性排序超出筛选上限未进入筛选，150条进入题名/摘要筛选"
    )
    assert "248 ranked beyond the relevance cap for screening and were not screened" in en
    assert "150 title/abstract records were screened" in en
    project = Project("prisma sentence", output_dir=tmp_path)
    project.save_json("prisma_flow.json", MA001_PRISMA_FLOW)
    project.save_text(
        "draft.md",
        (
            f"# 标题\n\n## 摘要\n\n**结果：** 检索识别400条记录，{zh}，全文评估14篇，最终纳入3项研究。\n\n"
            "## 图表\n\n### 图1. PRISMA流程图\n\n"
            + WritingAgent(lang="zh")._fallback_prisma_flow_legend(prisma=prisma, n_primary=3)
            + "\n"
        ),
        subdir="manuscript",
    )

    audit = _build_prisma_audit_review(project)

    assert audit["passed"] is True, audit["issues"]


def test_screening_sentence_is_unchanged_when_every_deduplicated_record_was_screened() -> None:
    prisma = {"records_after_dedup": 120, "title_abstract_screened": 120}

    assert WritingAgent(lang="zh")._screening_entry_phrase(prisma, "经去重后剩余120条") == "经去重后剩余120条进入题名/摘要筛选"


# ── manuscript_content: calculation detail from the engine record ─────────


def test_calculation_appendix_is_rendered_from_the_engine_record() -> None:
    notes = WritingAgent(lang="zh")._computation_record_notes({"synthesis_result": MA001_SYNTHESIS}, MA001_ROWS)
    text = "\n\n".join(notes)

    assert "合并效应估计为MD -303.23（标准误102.70；95% CI -504.52至-101.93）；95%预测区间为-2730.38至2123.93。" in text
    assert "Alexandru 2016 -329.70（方差7363.49）" in text
    assert "Montovanelli 2021 -112.50（方差5984.61）" in text
    assert "异质性统计量为Cochran Q=12.03，I²=83.4%，tau²=25941.694。" in text
    assert "HKSJ敏感性分析得到MD -303.02（95% CI -759.43至153.40）。" in text
    # I² = 83.4% is not "low": the appendix reports statistics, not an adjective.
    assert "异质性较低" not in text
    assert _has_calculation_detail(text) is True


def test_calculation_appendix_falls_back_without_an_engine_record() -> None:
    assert WritingAgent(lang="en")._computation_record_notes({}, MA001_ROWS) == []
