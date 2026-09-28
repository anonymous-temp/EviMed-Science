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
from new_meta.core.project import Project


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
