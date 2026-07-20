"""Command-line runner for one full analysis (P4 acceptance helper).

Usage:
    python -m safety_agent.analysis.runner \
        --drug atorvastatin --reactions myalgia,myopathy,rhabdomyolysis \
        --language zh --outdir samples/atorvastatin

Writes report.md + signals.csv + report.docx (+ report.pdf when a local
LibreOffice is available). LLM steps are skipped (with visible degradation
notes) when DEEPSEEK_API_KEY is not configured.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from safety_agent.analysis.pipeline import AnalysisPipeline
from safety_agent.analysis.models import AnalysisResult
from safety_agent.core.config import get_settings
from safety_agent.core.logging import configure_logging, get_logger
from safety_agent.evidence.evimed import EviMedEvidenceClient
from safety_agent.llm.client import DeepSeekClient
from safety_agent.openfda.client import OpenFDAClient
from safety_agent.report.docx_export import export_docx, export_pdf
from safety_agent.report.markdown import render_markdown, signal_table_csv

logger = get_logger(__name__)


def _stage_printer(stage: str, status: str, detail: dict) -> None:
    extra = " ".join(f"{k}={v}" for k, v in detail.items())
    print(f"[stage] {stage:<10} {status:<9} {extra}")


async def run_to_files(
    drug: str,
    reactions: list[str],
    *,
    language: str = "zh",
    outdir: Path,
    on_stage=None,
    timeout_seconds: float = 600.0,
    stem: str = "report",
) -> dict[str, Path | None]:
    """Run the pipeline and write all report artifacts into ``outdir``."""
    settings = get_settings()
    openfda = OpenFDAClient.from_settings(settings)
    llm = None
    if settings.deepseek_api_key.get_secret_value():
        llm = DeepSeekClient.from_settings(settings)
    else:
        logger.warning("DEEPSEEK_API_KEY empty; LLM steps will degrade")
    evidence = EviMedEvidenceClient.from_settings(settings)
    pipeline = AnalysisPipeline(
        openfda=openfda,
        llm=llm,
        evidence=evidence,
        on_stage=on_stage or _stage_printer,
        timeout_seconds=timeout_seconds,
        openfda_base_url=settings.openfda_base_url,
    )
    try:
        result = await pipeline.run(drug, reactions, language=language)
    finally:
        await openfda.aclose()
        if llm is not None:
            await llm.aclose()
        await evidence.aclose()
    return write_artifacts(result, outdir, stem=stem)


def write_artifacts(
    result: AnalysisResult, outdir: Path, *, stem: str = "report"
) -> dict[str, Path | None]:
    """Write markdown/csv/docx/pdf for one finished AnalysisResult."""
    outdir.mkdir(parents=True, exist_ok=True)
    md_path = outdir / f"{stem}.md"
    md_path.write_text(render_markdown(result), encoding="utf-8")
    csv_path = outdir / "signals.csv"
    csv_path.write_text(signal_table_csv(result), encoding="utf-8")
    docx_path = export_docx(result, outdir / f"{stem}.docx")
    pdf_path = export_pdf(docx_path, outdir)
    return {"markdown": md_path, "csv": csv_path, "docx": docx_path, "pdf": pdf_path}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one FAERS safety analysis")
    parser.add_argument("--drug", required=True)
    parser.add_argument("--reactions", default="", help="comma-separated ADR terms")
    parser.add_argument("--language", default="zh", choices=["zh", "en"])
    parser.add_argument("--outdir", type=Path, default=Path("samples/out"))
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.log_level)
    reactions = [r.strip() for r in args.reactions.split(",") if r.strip()]
    artifacts = asyncio.run(
        run_to_files(args.drug, reactions, language=args.language, outdir=args.outdir)
    )
    for kind, path in artifacts.items():
        print(f"[artifact] {kind}: {path}")


if __name__ == "__main__":
    main()
