"""Fixed-argument EviMed adapter for the peer-review specialist."""

from __future__ import annotations

import argparse
import asyncio
import json
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FAILURE_MARKERS = (
    "由于技术原因",
    "建议人工复核",
    "待评估",
    "待生成",
)


def _write_result(output_dir: Path, value: dict) -> None:
    (output_dir / "result.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _module(status: str, reason: str = "", *, fatal: bool = False) -> dict:
    entry: dict = {"status": status}
    if reason:
        entry["reason"] = reason
    if fatal:
        entry["fatal"] = True
    return entry


def _module_ledger(result) -> dict:
    """Per-step ledger for the specialist-job receipt.

    Parsing and rubric evaluation change what the review means and fail the run;
    quote verification and the statistical pass may degrade, but only into this
    ledger.
    """
    meta = getattr(result, "meta_review", None)
    modules: dict[str, dict] = {"documentParse": _module("ok")}

    rubrics = list(getattr(result, "rubrics_used", None) or [])
    modules["rubricEvaluation"] = (
        _module("ok") if rubrics
        else _module("failed", "no reporting checklist was applied", fatal=True)
    )

    verification = dict(getattr(meta, "quote_verification", None) or {}) if meta else {}
    if not verification:
        modules["quoteVerification"] = _module(
            "skipped", "no findings carried quotes to verify"
        )
    elif verification.get("quotes_dropped") or verification.get("issues_demoted"):
        modules["quoteVerification"] = _module(
            "degraded",
            f"{verification.get('quotes_dropped', 0)} of "
            f"{verification.get('quotes_checked', 0)} quotes could not be located in "
            f"the manuscript; {verification.get('issues_demoted', 0)} findings demoted",
        )
    else:
        modules["quoteVerification"] = _module("ok")

    rejected = list(getattr(meta, "rejected_rubrics", None) or []) if meta else []
    if rejected:
        modules["rubricSelection"] = _module(
            "degraded",
            "; ".join(
                f"{item.get('rubric', '?')}: {item.get('reason', 'rejected')}"
                for item in rejected
                if isinstance(item, dict)
            ) or "one or more checklists were rejected",
        )

    # No statistic in the manuscript is recomputed; the reviewer only reads them.
    modules["statisticalRecomputation"] = _module(
        "skipped", "this engine does not recompute reported statistics"
    )
    return modules


def _degraded(modules: dict) -> bool:
    return any(entry["status"] in {"degraded", "failed"} for entry in modules.values())


def _issue_count(result) -> int:
    meta = getattr(result, "meta_review", None)
    if meta is None:
        return 0
    return len(meta.fatal_issues) + len(meta.major_issues) + len(meta.minor_issues)


def _coverage_table(result) -> str:
    """Per-item coverage, so a review with no findings is still a deliverable.

    Without it, "no critical issues" is indistinguishable from "the checklist was
    never applied", which is why the report used to need findings to look real.
    """
    rows = ["| Checklist | Item | Verdict |", "|---|---|---|"]
    counted = 0
    for rubric_name, blocks in (getattr(result, "rubric_results", None) or {}).items():
        for block in blocks or []:
            for item in getattr(block, "results", []) or []:
                verdict = getattr(item.verdict, "value", item.verdict)
                item_id = getattr(item, "item_id", "") or getattr(item, "rubric_item_id", "")
                rows.append(f"| {rubric_name} | {item_id} | {verdict} |")
                counted += 1
    if not counted:
        return ""
    return "## Checklist coverage\n\n" + "\n".join(rows)


def _report_markdown(result) -> str:
    narrative = result.narrative_report
    key_strengths = narrative.key_strengths_narrative.strip()
    minor_suggestions = narrative.minor_suggestions_narrative.strip()
    critical_issues = narrative.critical_issues_narrative.strip()
    if not critical_issues:
        critical_issues = (
            "未发现关键问题。"
            if _issue_count(result) == 0
            else "核查后的问题未能生成叙述文本。"
        )
    sections = [
        f"# {narrative.title or result.document_title}",
        "## Overall evaluation\n\n" + narrative.overall_evaluation,
        "## Key strengths\n\n" + (
            key_strengths
            or "未识别到可由手稿原文充分支持的明确优势。"
        ),
        "## Critical issues\n\n" + critical_issues,
        "## Minor suggestions\n\n" + (
            minor_suggestions
            or "未识别到独立于上述关键问题之外、且有充分证据支持的次要建议。"
        ),
        "## Recommendation\n\n" + narrative.recommendation_narrative,
    ]
    coverage = _coverage_table(result)
    if coverage:
        sections.append(coverage)
    return "\n\n".join(sections)


def _placeholder_reason(result) -> str:
    """Why this result is a failed pipeline pretending to be a report, or "".

    Report length is not evidence of anything: a manuscript with no critical
    findings has a short critical-issues section by definition, and rejecting
    that was what forced findings to be manufactured.
    """
    narrative = result.narrative_report
    narrative_text = "\n".join([
        narrative.overall_evaluation,
        narrative.key_strengths_narrative,
        narrative.critical_issues_narrative,
        narrative.minor_suggestions_narrative,
        narrative.recommendation_narrative,
    ])
    if result.document_title == "审稿失败":
        return "pipeline reported a failed review"
    if result.meta_review.confidence <= 0:
        return "meta review carries no confidence"
    for marker in FAILURE_MARKERS:
        if marker in result.meta_review.overall_assessment or marker in narrative_text:
            return f"report contains the failure placeholder {marker!r}"
    if len(narrative.overall_evaluation.strip()) < 30:
        return "overall evaluation is empty"
    if not narrative.recommendation_narrative.strip():
        return "no recommendation was written"
    return ""


async def _review(request: dict, output_dir: Path) -> dict:
    manuscript = Path(str(request.get("manuscript") or ""))
    if not manuscript.is_absolute() or not manuscript.is_file():
        raise ValueError("manuscript must be an existing managed file")
    article_type = str(request.get("articleType") or "other")

    from src.main_v2 import ReviewOrchestratorV2

    orchestrator = ReviewOrchestratorV2()
    result = await orchestrator.review_manuscript(
        str(manuscript),
        is_review_article=article_type == "systematic-review",
    )
    reason = _placeholder_reason(result)
    if reason:
        raise RuntimeError(
            f"peer-review pipeline returned an invalid failure placeholder: {reason}"
        )
    report_path = output_dir / "peer-review-report.md"
    report_path.write_text(_report_markdown(result), encoding="utf-8")
    payload = result.model_dump(mode="json")
    (output_dir / "peer-review-run.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    meta = result.meta_review
    modules = _module_ledger(result)
    return {
        "status": "succeeded",
        "modules": modules,
        "degraded": _degraded(modules),
        "title": result.document_title,
        "recommendation": str(meta.recommendation),
        "rubrics": list(result.rubrics_used),
        "report": report_path.name,
        "issues": {
            "fatal": len(meta.fatal_issues),
            "major": len(meta.major_issues),
            "minor": len(meta.minor_issues),
        },
        "quoteVerification": getattr(meta, "quote_verification", {}) or {},
    }


def run(request_path: Path, output_dir: Path) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        result = asyncio.run(_review(request, output_dir))
        _write_result(output_dir, result)
        return 0
    except Exception as error:
        traceback.print_exc()
        _write_result(output_dir, {"status": "failed", "error": str(error)})
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    raise SystemExit(main())
