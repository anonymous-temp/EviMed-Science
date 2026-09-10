"""Quoted evidence must exist in the manuscript (R033), and a clean manuscript
must be able to get a clean review (R032)."""

import asyncio
import json
from pathlib import Path

import pytest

import evimed_runner
from src.schemas.meta_review import (
    ConsolidatedIssue,
    MetaReviewResult,
    MultiRubricReviewResult,
    NarrativeReport,
)
from src.services import quote_verification as qv

MANUSCRIPT = """
Methods. Participants were allocated with a computer-generated random sequence in
permuted blocks of four, stratified by centre. Allocation was concealed in
sequentially numbered, opaque, sealed envelopes. Outcome assessors were masked to
assignment. The primary outcome was 90-day mortality at the pre-
specified follow-up visit.
"""


def _issue(title, severity, quotes):
    return ConsolidatedIssue(
        title=title, severity=severity, description=f"{title} 的描述。",
        evidence_quotes=list(quotes), standard_reference="CONSORT 2025 item 17a",
    )


# --------------------------------------------------------------------- R033

def test_a_quote_the_manuscript_contains_is_located_exactly():
    outcome = qv.locate_quote(
        "Outcome assessors were masked to assignment.", qv.normalise(MANUSCRIPT)
    )
    assert outcome["located"] is True
    assert outcome["match"] == "exact"


def test_parser_whitespace_and_hyphenation_do_not_break_a_real_quote():
    outcome = qv.locate_quote(
        "The primary  outcome was 90-day mortality at the prespecified follow-up visit.",
        qv.normalise(MANUSCRIPT),
    )
    assert outcome["located"] is True


def test_a_quote_the_manuscript_never_contained_is_not_located():
    outcome = qv.locate_quote(
        "Patients were assigned by the attending physician at their discretion.",
        qv.normalise(MANUSCRIPT),
    )
    assert outcome["located"] is False
    assert outcome["reason"] == "not_found_in_manuscript"


def test_a_quote_too_short_to_mean_anything_is_refused():
    outcome = qv.locate_quote("Methods", qv.normalise(MANUSCRIPT))
    assert outcome["located"] is False
    assert outcome["reason"] == "quote_too_short"


def test_an_elided_quote_is_verified_fragment_by_fragment():
    outcome = qv.locate_quote(
        "Allocation was concealed in ... opaque, sealed envelopes.",
        qv.normalise(MANUSCRIPT),
    )
    assert outcome["located"] is True


def test_a_fabricated_quote_cannot_carry_a_fatal_finding():
    fabricated = _issue("随机序列生成未描述", "fatal",
                        ["Patients were assigned by the attending physician at their discretion."])
    grounded = _issue("未报告样本量计算", "major",
                      ["Allocation was concealed in sequentially numbered, opaque, sealed envelopes."])
    meta = MetaReviewResult(fatal_issues=[fabricated], major_issues=[grounded])

    summary = qv.verify_meta_review(meta, MANUSCRIPT)

    assert summary["quotes_checked"] == 2
    assert summary["quotes_located"] == 1
    assert summary["issues_demoted"] == 1
    # The finding survives, but as an unverified minor with no quote attached.
    assert meta.fatal_issues == []
    assert [i.title for i in meta.major_issues] == ["未报告样本量计算"]
    assert [i.title for i in meta.minor_issues] == ["随机序列生成未描述"]
    demoted = meta.minor_issues[0]
    assert demoted.severity == "minor"
    assert demoted.evidence_quotes == []
    assert "[未核实]" in demoted.description
    assert demoted.quote_verification["dropped"][0]["reason"] == "not_found_in_manuscript"


def test_a_grounded_finding_keeps_its_severity_and_its_quote():
    grounded = _issue("盲法描述不完整", "fatal",
                      ["Outcome assessors were masked to assignment."])
    meta = MetaReviewResult(fatal_issues=[grounded])
    qv.verify_meta_review(meta, MANUSCRIPT)
    assert [i.title for i in meta.fatal_issues] == ["盲法描述不完整"]
    assert grounded.evidence_quotes == ["Outcome assessors were masked to assignment."]
    assert grounded.quote_verification["verified"] is True


def test_an_issue_that_claims_no_quote_is_recorded_but_not_demoted():
    silent = _issue("研究注册未提及", "major", [])
    meta = MetaReviewResult(major_issues=[silent])
    summary = qv.verify_meta_review(meta, MANUSCRIPT)
    assert summary["issues_without_quotes"] == 1
    assert summary["issues_demoted"] == 0
    assert silent.quote_verification["reason"] == "no_quote_supplied"


# --------------------------------------------------------------------- R032

def _clean_result(issues_narrative="未发现关键问题。"):
    return MultiRubricReviewResult(
        document_title="A well-reported randomised trial",
        rubric_results={},
        meta_review=MetaReviewResult(
            overall_assessment="报告完整，CONSORT 2025 逐条覆盖，未发现关键方法学缺陷。",
            recommendation="minor_revision", confidence=0.86,
        ),
        narrative_report=NarrativeReport(
            title="A well-reported randomised trial",
            overall_evaluation="本文是一项报告完整的随机对照试验，注册、方案与统计分析计划齐备，方法学描述可复现。",
            critical_issues_narrative=issues_narrative,
            recommendation_narrative="建议小修后接受。",
            recommendation="minor_revision",
        ),
        rubrics_used=["consort_2025"], processing_time=1.0,
    )


def test_a_clean_review_is_not_rejected_for_being_short():
    assert evimed_runner._placeholder_reason(_clean_result()) == ""


def test_a_crashed_pipeline_is_still_rejected():
    broken = _clean_result()
    broken.narrative_report.overall_evaluation = "由于技术原因，建议人工复核。"
    assert "failure placeholder" in evimed_runner._placeholder_reason(broken)

    empty = _clean_result()
    empty.narrative_report.overall_evaluation = "短"
    assert evimed_runner._placeholder_reason(empty) == "overall evaluation is empty"

    failed = _clean_result()
    failed.document_title = "审稿失败"
    assert evimed_runner._placeholder_reason(failed) == "pipeline reported a failed review"


def test_a_clean_manuscript_produces_a_succeeded_result(tmp_path, monkeypatch):
    result = _clean_result()

    class _Orchestrator:
        def __init__(self, *args, **kwargs):
            pass

        async def review_manuscript(self, path, is_review_article=False):
            return result

    import src.main_v2 as main_v2
    monkeypatch.setattr(main_v2, "ReviewOrchestratorV2", _Orchestrator)

    manuscript = tmp_path / "m.txt"
    manuscript.write_text("manuscript", encoding="utf-8")
    payload = asyncio.run(evimed_runner._review(
        {"manuscript": str(manuscript.resolve()), "articleType": "rct"}, tmp_path
    ))
    assert payload["status"] == "succeeded"
    assert payload["issues"] == {"fatal": 0, "major": 0, "minor": 0}
    report = (tmp_path / "peer-review-report.md").read_text(encoding="utf-8")
    assert "未发现关键问题。" in report


def test_the_report_says_so_when_no_issues_survived(tmp_path):
    result = _clean_result(issues_narrative="")
    assert "未发现关键问题。" in evimed_runner._report_markdown(result)


def test_no_finding_quota_survives_in_the_prompts():
    """8-15 findings, 300 characters each, 5,000 in total, plus an expansion
    pass, together made a clean review impossible."""
    meta_reviewer = Path("src/agents/meta_reviewer.py").read_text(encoding="utf-8")
    narrative = Path("src/agents/narrative_generator.py").read_text(encoding="utf-8")
    assert "8-15 个具体的" not in meta_reviewer
    assert "少于 6 条" not in meta_reviewer
    assert "不少于300字" not in narrative
    assert "总字数不得低于5000字" not in narrative
    assert "_expand_issues" not in narrative


# ------------------------------------------------- module ledger (class D)

def test_a_review_with_every_quote_located_is_not_degraded():
    result = _clean_result()
    result.meta_review.quote_verification = {
        "quotes_checked": 4, "quotes_located": 4, "quotes_dropped": 0, "issues_demoted": 0,
    }
    modules = evimed_runner._module_ledger(result)
    assert modules["quoteVerification"]["status"] == "ok"
    assert modules["rubricEvaluation"]["status"] == "ok"
    assert modules["statisticalRecomputation"]["status"] == "skipped"
    assert evimed_runner._degraded(modules) is False


def test_dropped_quotes_are_a_named_degraded_module():
    result = _clean_result()
    result.meta_review.quote_verification = {
        "quotes_checked": 6, "quotes_located": 4, "quotes_dropped": 2, "issues_demoted": 1,
    }
    modules = evimed_runner._module_ledger(result)
    entry = modules["quoteVerification"]
    assert entry["status"] == "degraded"
    assert "2 of 6" in entry["reason"]
    assert "1 findings demoted" in entry["reason"]
    assert evimed_runner._degraded(modules) is True
    assert not any(item.get("fatal") for item in modules.values())


def test_a_review_with_no_checklist_applied_is_a_fatal_ledger_entry():
    result = _clean_result()
    result.rubrics_used = []
    modules = evimed_runner._module_ledger(result)
    assert modules["rubricEvaluation"]["fatal"] is True


def test_the_result_json_carries_the_ledger(tmp_path, monkeypatch):
    result = _clean_result()
    result.meta_review.quote_verification = {
        "quotes_checked": 2, "quotes_located": 1, "quotes_dropped": 1, "issues_demoted": 0,
    }

    class _Orchestrator:
        def __init__(self, *args, **kwargs):
            pass

        async def review_manuscript(self, path, is_review_article=False):
            return result

    import src.main_v2 as main_v2
    monkeypatch.setattr(main_v2, "ReviewOrchestratorV2", _Orchestrator)
    manuscript = tmp_path / "m.txt"
    manuscript.write_text("manuscript", encoding="utf-8")
    payload = asyncio.run(evimed_runner._review(
        {"manuscript": str(manuscript.resolve()), "articleType": "rct"}, tmp_path
    ))
    assert payload["status"] == "succeeded"
    assert payload["degraded"] is True
    assert payload["modules"]["quoteVerification"]["status"] == "degraded"
