"""Fixed-argument EviMed adapter for the bibliometric specialist."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


# Steps whose failure changes what the analysis means. These fail the run; they
# never appear as a degraded module with the job still reported as succeeded.
NON_DEGRADABLE_STEPS = ("searchStrategy", "citationSource")


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


def _module_ledger(pipeline, report_written: bool) -> dict:
    """Per-step ledger for the specialist-job receipt.

    A step that was silently swallowed (a concept block dropped, a citation
    source unreachable) is named here with its reason, so the delivery gate can
    say which part of the analysis did not happen.
    """
    stats = getattr(pipeline, "stats", None) or {}
    strategy = getattr(pipeline, "search_strategy", None) or {}
    modules: dict[str, dict] = {}

    if strategy.get("fallback_reason"):
        modules["searchStrategy"] = _module(
            "degraded",
            f"formal MeSH strategy returned no records; retried the raw topic "
            f"({strategy['fallback_reason']})",
        )
    else:
        modules["searchStrategy"] = _module("ok")

    coverage = stats.get("citation_coverage")
    if coverage is None:
        modules["citationSource"] = _module("skipped", "citation module was not requested")
    else:
        unavailable = coverage.get("sources_unavailable") or {}
        detail = "; ".join(f"{name}: {reason}" for name, reason in sorted(unavailable.items()))
        observed, total = coverage.get("observed", 0), coverage.get("total", 0)
        if observed == 0:
            modules["citationSource"] = _module(
                "failed",
                f"no citation source answered for any of {total} articles"
                + (f" ({detail})" if detail else ""),
                fatal=True,
            )
        elif observed < total:
            modules["citationSource"] = _module(
                "degraded",
                f"citations observed for {observed}/{total} articles"
                + (f"; {detail}" if detail else ""),
            )
        else:
            modules["citationSource"] = _module("ok")

    modules["report"] = _module("ok") if report_written else _module(
        "failed", "the pipeline did not create a usable report", fatal=True
    )
    return modules


def _degraded(modules: dict) -> bool:
    return any(entry["status"] in {"degraded", "failed"} for entry in modules.values())


def _fatal_step(modules: dict) -> tuple[str, dict] | None:
    for name, entry in modules.items():
        if entry.get("fatal"):
            return name, entry
    return None


def run(request_path: Path, output_dir: Path) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        topic = str(request.get("topic") or "").strip()
        if not topic:
            raise ValueError("topic is required")
        date_from = str(request.get("dateFrom") or "").strip()
        date_to = str(request.get("dateTo") or "").strip()
        output_language = str(request.get("outputLanguage") or "zh").strip().lower()
        if output_language not in {"zh", "en"}:
            raise ValueError("outputLanguage must be zh or en")
        max_records = int(request.get("maxRecords") or 1000)
        if not 20 <= max_records <= 5000:
            raise ValueError("maxRecords must be between 20 and 5000")

        from bibliometric.config import load_config
        from bibliometric.pipeline import AnalysisPipeline

        config = load_config(output_dir=str(output_dir))
        pipeline = AnalysisPipeline(
            config=config,
            query=topic,
            date_from=date_from,
            date_to=date_to,
            max_records=max_records,
            modules="all",
            lang=output_language,
        )
        pipeline.run()
        report = output_dir / "report.md"
        report_written = report.is_file() and report.stat().st_size >= 100
        modules = _module_ledger(pipeline, report_written)
        fatal = _fatal_step(modules)
        if fatal is not None:
            name, entry = fatal
            failure = RuntimeError(f"bibliometric step {name} failed: {entry.get('reason', '')}")
            failure.code = (
                "citation_source_unavailable" if name == "citationSource"
                else "bibliometric_report_missing" if name == "report"
                else "bibliometric_step_failed"
            )
            failure.modules = modules
            raise failure
        result = {
            "status": "succeeded",
            "topic": topic,
            "records": len(pipeline.articles),
            "report": report.name,
            "modules": modules,
            "degraded": _degraded(modules),
        }
        coverage = (getattr(pipeline, "stats", None) or {}).get("citation_coverage")
        if coverage is not None:
            result["citationCoverage"] = coverage
        _write_result(output_dir, result)
        return 0
    except Exception as error:
        traceback.print_exc()
        failure = {"status": "failed", "error": str(error)}
        code = getattr(error, "code", "")
        if code:
            failure["errorCode"] = code
            labels = getattr(error, "labels", None)
            if labels:
                failure["errorDetail"] = {"unresolvedConcepts": list(labels)}
        modules = getattr(error, "modules", None)
        if modules is None and code == "concept_block_unresolved":
            modules = {
                "searchStrategy": _module("failed", str(error), fatal=True),
            }
        if modules is not None:
            failure["modules"] = modules
            failure["degraded"] = _degraded(modules)
        _write_result(output_dir, failure)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    raise SystemExit(main())
