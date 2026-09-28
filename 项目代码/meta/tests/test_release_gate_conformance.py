"""Release-gate conformance: each case is taken from the ma-001 run (TXA in TKA)
whose manuscript the submission release gate blocked on six manuscript gates.

A gate that read the text wrongly is fixed in the gate and proved here with the
text it misread; a writer that produced text the gate rightly refused is fixed
in the writer and proved here with what it now produces.
"""
from __future__ import annotations

from pathlib import Path

from new_meta.core.artifact_package import _build_claim_support_audit_review
from new_meta.core.artifact_package_manifest import _has_calculation_detail
from new_meta.core.extraction_review import build_extraction_source_cards
from new_meta.core.manuscript_facts import validate_and_repair_manuscript
from new_meta.core.project import Project
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


# ── manuscript_content: calculation detail ────────────────────────────────


def test_calculation_detail_recognizes_a_signed_difference_effect() -> None:
    # Verbatim from the ma-001 abstract: a negative MD is an effect estimate.
    text = (
        "合并效应量为MD -303.23 mL（95% CI -504.52至-101.93），95%预测区间为-2730.38 mL至2123.93 mL。"
        "研究间统计异质性较高（I²=83.4%，tau²=25941.69，Q=12.03）。"
    )

    assert _has_calculation_detail(text) is True
    assert _has_calculation_detail(text.replace("MD -303.23", "MD −303.23")) is True


def test_calculation_detail_still_requires_an_effect_value() -> None:
    text = "合并效应采用随机效应模型（95% CI 见表2），异质性以I²描述。"

    assert _has_calculation_detail(text) is False


# ── claim_support: certainty ratings ─────────────────────────────────────


def _claim_support_project(tmp_path: Path, body: str, certainty: str = "Very low") -> Project:
    project = Project("claim support certainty", output_dir=tmp_path)
    project.save_text("draft.md", body, subdir="manuscript")
    project.save_json(
        "manuscript_facts.json",
        {
            "report_type": "meta",
            "output_language": "zh",
            "primary_effect": {"effect_measure": "MD", "n_studies": 3, "pooled_effect": -303.23},
            "grade": {"outcomes": [{"outcome_name": "总失血量", "certainty": certainty}]},
        },
        subdir="manuscript",
    )
    return project


def test_downgrade_rule_in_methods_is_not_read_as_a_low_certainty_claim(tmp_path: Path) -> None:
    # The fact-locked Methods sentence states when certainty is NOT downgraded;
    # "降低确定性" (to lower certainty) contains "低确定性" but names no rating.
    body = "\n".join([
        "# 标题",
        "## 方法",
        "间接性判断结合人群、干预、对照、结局和研究设计与研究问题的一致程度；"
        "若只是报告字段不完整但入选研究已经明确匹配，则不因字段缺失单独降低确定性。",
        "## 结果",
        "证据确定性：该比较的GRADE证据确定性为极低。",
    ])

    audit = _build_claim_support_audit_review(_claim_support_project(tmp_path, body))

    assert audit["summary"]["checked_claims"] == 1
    assert audit["summary"]["unsupported_claims"] == 0
    assert all("降低确定性" not in claim["sentence"] for claim in audit["claims"])


def test_a_wrong_low_certainty_rating_is_still_unsupported(tmp_path: Path) -> None:
    body = "\n".join(["# 标题", "## 结论", "与对照相比，本比较的GRADE证据确定性为低，结论仍需进一步的随机对照试验验证。"])

    audit = _build_claim_support_audit_review(_claim_support_project(tmp_path, body))

    assert audit["summary"]["unsupported_claims"] == 1


# ── fact repair must not delete source-location cells ────────────────────


def test_undefined_reference_repair_keeps_rows_that_name_source_report_tables() -> None:
    manuscript = "\n".join([
        "# 标题",
        "## 结果",
        "纳入研究见表1。原研究资料另见表5。",
        "## 表格",
        "### 表1. 纳入研究",
        "| 研究 | 报告位置 |",
        "|---|---|",
        "| Montovanelli 2021 | Table 5 (Drained Blood, ml), rows Group 1 and Group 2; pairwise p-value from Table 6 |",
        "",
        "## 补充材料",
        "### 附录2. 来源核验",
        "| 研究 | 来源位置 |",
        "|---|---|",
        "| Montovanelli 2021 | Table 5 (Drained Blood, ml) |",
    ])

    repaired, validation = validate_and_repair_manuscript(manuscript, {})

    assert repaired.count("| Montovanelli 2021 | Table 5 (Drained Blood, ml)") == 2
    # A prose reference to a table this manuscript does not define is still removed.
    assert "原研究资料另见表5" not in repaired
    assert not [issue for issue in validation["issues"] if issue.get("severity") == "error"
                and issue.get("kind") == "missing_table_reference"]


# ── primary_source_context: ledger result rows ───────────────────────────


def test_ledger_result_row_carries_the_verified_quote_match_of_its_extraction(tmp_path: Path) -> None:
    # A verified quote joins two passages; only its contiguous match is in the text.
    joined_quote = (
        "The mean TBL in the TXA group was 645 ± 209 mL, lower than 1103 ± 305 mL in the placebo group. "
        "| Table 3: Total blood loss (mL) | 645 (209) | 1103 (305)"
    )
    quote_match = "The mean TBL in the TXA group was 645 ± 209 mL, lower than 1103 ± 305 mL in"
    project = Project("ledger source context", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", pmid="33511201", title="Topical TXA trial"),
                outcomes=[
                    OutcomeData(
                        outcome_name="Total blood loss (mL)",
                        outcome_type="continuous",
                        source_quote=joined_quote,
                        source_quote_match=quote_match,
                        source_quote_verified=True,
                        extraction_confidence="high",
                    )
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json(
        "parsed_papers.json",
        {
            "33511201": {
                "full_text": (
                    "Results. " + quote_match + " the placebo group (p < 0.001). Table 3 follows."
                ),
                "page_map": [],
            }
        },
        subdir="papers",
    )
    selected_row = {
        "row_id": "result:33511201:0",
        "study_id": "study:33511201",
        "study_label": "Shih-Hsiang 2021",
        "outcome_name": "outcome:total-blood-loss-perioperative:8a71fa9895",
        "source_quote": joined_quote,
        "source_quote_verified": True,
        "extraction_confidence": "verified",
    }

    [card] = build_extraction_source_cards(project, rows=[selected_row])

    assert card["row_id"] == "result:33511201:0"
    assert card["source"]["quote_match"] == quote_match
    assert card["source_context"]["available"] is True
    assert card["source_context"]["match_text"] == quote_match


def test_ledger_result_row_does_not_borrow_a_match_for_a_different_quote(tmp_path: Path) -> None:
    project = Project("ledger source context mismatch", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", pmid="777"),
                outcomes=[
                    OutcomeData(
                        outcome_name="Blood loss",
                        outcome_type="continuous",
                        source_quote="Blood loss was 500 mL versus 800 mL.",
                        source_quote_match="Blood loss was 500 mL versus 800 mL.",
                        source_quote_verified=True,
                    )
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json("parsed_papers.json", {"777": {"full_text": "Blood loss was 500 mL versus 800 mL."}}, subdir="papers")

    [card] = build_extraction_source_cards(project, rows=[{
        "row_id": "result:777:0",
        "study_id": "study:777",
        "source_quote": "Transfusion occurred in 3 of 40 versus 9 of 41 patients.",
        "source_quote_verified": True,
    }])

    assert card["source"]["quote_match"] is None
    assert card["source_context"]["available"] is False
