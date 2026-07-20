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


def _report_markdown(result) -> str:
    narrative = result.narrative_report
    key_strengths = narrative.key_strengths_narrative.strip()
    minor_suggestions = narrative.minor_suggestions_narrative.strip()
    return "\n\n".join([
        f"# {narrative.title or result.document_title}",
        "## Overall evaluation\n\n" + narrative.overall_evaluation,
        "## Key strengths\n\n" + (
            key_strengths
            or "未识别到可由手稿原文充分支持的明确优势。"
        ),
        "## Critical issues\n\n" + narrative.critical_issues_narrative,
        "## Minor suggestions\n\n" + (
            minor_suggestions
            or "未识别到独立于上述关键问题之外、且有充分证据支持的次要建议。"
        ),
        "## Recommendation\n\n" + narrative.recommendation_narrative,
    ])


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
    narrative = result.narrative_report
    narrative_text = "\n".join([
        narrative.overall_evaluation,
        narrative.key_strengths_narrative,
        narrative.critical_issues_narrative,
        narrative.minor_suggestions_narrative,
        narrative.recommendation_narrative,
    ])
    if (
        result.document_title == "审稿失败"
        or result.meta_review.confidence <= 0
        or any(marker in result.meta_review.overall_assessment for marker in FAILURE_MARKERS)
        or any(marker in narrative_text for marker in FAILURE_MARKERS)
        or len(narrative.overall_evaluation.strip()) < 30
        or len(narrative.critical_issues_narrative.strip()) < 100
    ):
        raise RuntimeError("peer-review pipeline returned an invalid failure placeholder")
    report_path = output_dir / "peer-review-report.md"
    report_path.write_text(_report_markdown(result), encoding="utf-8")
    payload = result.model_dump(mode="json")
    (output_dir / "peer-review-run.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "status": "succeeded",
        "title": result.document_title,
        "recommendation": str(result.meta_review.recommendation),
        "rubrics": list(result.rubrics_used),
        "report": report_path.name,
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
