"""Shared admission for completed MR reports, independent of scientific estimates."""
from __future__ import annotations

import json
import re
from pathlib import Path

from mr_agent.models import MRAnalysisResult

_DIAGNOSTIC_NAME = re.compile(r"^(scatter_plot|forest_plot|funnel_plot|loo_plot)(?:-[0-9]{3})?[._](?:pdf|png)$")


def diagnostic_artifact_name(path: Path | str) -> str | None:
    """Recognize only the exact filenames or labels owned by MR diagnostics."""
    match = _DIAGNOSTIC_NAME.fullmatch(Path(path).name)
    return match[1] if match else None


class MRDeliveryError(RuntimeError):
    """A failed generation phase cannot be represented by a completed report."""

    def __init__(self, code: str, module: str):
        self.code = code
        self.module = module
        super().__init__(f"MR report is not ready: {code}.")


class EmptyInterpretationError(ValueError):
    """The completed generation call did not return interpretation text."""


def require_interpretations(results: list[MRAnalysisResult]) -> None:
    for result in results:
        if (result.interpretation_status == "failed" or result.interpretation_error_code
                or result.interpretation_failure is not None):
            raise MRDeliveryError("mr_interpretation_failed", "interpretation")
        if (result.interpretation_status != "succeeded"
                or not isinstance(result.interpretation, str) or not result.interpretation.strip()):
            raise MRDeliveryError("mr_interpretation_incomplete", "interpretation")


def interpretation_diagnostics(results: list[MRAnalysisResult]) -> dict:
    """A small typed failure projection, with no phenotype, prompt or response text."""
    failed = [{"result_index": index, "failure": result.interpretation_failure.model_dump(mode="json")}
              for index, result in enumerate(results) if result.interpretation_failure is not None]
    return {"schema_version": 1, "phase": "interpretation", "failures": failed[:8],
            "omitted_results": max(0, len(failed) - 8)}


def diagnostic_plot_checks(result: MRAnalysisResult) -> dict:
    """Inspect generated pages and image pixels; file existence is insufficient."""
    from PIL import Image, ImageStat
    from PyPDF2 import PdfReader

    required = {"scatter_plot": 2, "forest_plot": 2, "funnel_plot": 2, "loo_plot": 3}
    root = Path(result.raw_data_path) if result.raw_data_path else None
    try:
        ledger_path = root / "diagnostic-plots.json"
        if ledger_path.stat().st_size > 64 * 1024:
            raise ValueError("Plot ledger is oversized")
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        if not isinstance(ledger, dict) or set(ledger) != set(required):
            raise ValueError("Plot ledger is incomplete")
    except (OSError, TypeError, ValueError):
        return {name: {"status": "failed", "reason": "plot_evidence_missing"} for name in required}

    checks = {}
    for name, minimum in required.items():
        item = ledger[name]
        try:
            present_files = {path for path in root.iterdir() if diagnostic_artifact_name(path) == name}
        except OSError:
            checks[name] = {"status": "failed", "reason": "plot_artifact_invalid"}
            continue
        present_refs = {key: path for key, path in result.plots.items()
                        if diagnostic_artifact_name(key) == name or diagnostic_artifact_name(path) == name}
        if (isinstance(item, dict) and item.get("status") == "skipped"
                and item.get("reason_code") == "insufficient_instruments"
                and type(item.get("pages")) is int and item["pages"] == 0
                and result.n_instruments < minimum):
            checks[name] = ({"status": "failed", "reason": "skipped_plot_has_stale_artifacts"}
                if present_files or present_refs else {"status": "skipped", "reason": "insufficient_instruments"})
            continue
        try:
            pages = item["pages"]
            if (item["status"] != "ready" or type(pages) is not int or not 1 <= pages <= 64):
                raise ValueError("No completed plot render")
            pdf = root / f"{name}.pdf"
            expected_refs = {f"{name}_pdf": pdf, f"{name}_png": root / f"{name}.png"}
            expected_refs.update({f"{name}-{index:03d}_png": root / f"{name}-{index:03d}.png"
                                  for index in range(2, pages + 1)})
            if present_refs != expected_refs or present_files != set(expected_refs.values()):
                raise ValueError("Plot files and references differ from the current render")
            if result.plots.get(f"{name}_pdf") != pdf:
                raise ValueError("PDF is absent from the delivered plot list")
            if not pdf.is_file() or pdf.is_symlink() or pdf.stat().st_size > 50_000_000:
                raise ValueError("Invalid plot PDF")
            reader = PdfReader(pdf)
            if len(reader.pages) != pages or any(
                page.get_contents() is None or not page.get_contents().get_data().strip()
                for page in reader.pages
            ):
                raise ValueError("Empty PDF pages")
            for index in range(1, pages + 1):
                suffix = "" if index == 1 else f"-{index:03d}"
                png = root / f"{name}{suffix}.png"
                if result.plots.get(f"{name}{suffix}_png") != png:
                    raise ValueError("PNG is absent from the delivered plot list")
                if not png.is_file() or png.is_symlink() or png.stat().st_size > 50_000_000:
                    raise ValueError("Missing plot image")
                with Image.open(png) as image:
                    if image.format != "PNG" or image.width * image.height > 20_000_000:
                        raise ValueError("Invalid plot image")
                    image.load()
                    if max(ImageStat.Stat(image.convert("RGB")).stddev) == 0:
                        raise ValueError("Empty plot image")
            checks[name] = {"status": "ok", "pages": pages, "images": pages}
        except Exception:
            # Parser/device diagnostics must not expose arbitrary exception text.
            checks[name] = {"status": "failed", "reason": "plot_artifact_invalid"}
    return checks


def require_report_ready(results: list[MRAnalysisResult]) -> None:
    if not results:
        raise MRDeliveryError("mr_analysis_incomplete", "primaryEstimate")
    require_interpretations(results)
    for result in results:
        if any(item["status"] == "failed" for item in diagnostic_plot_checks(result).values()):
            raise MRDeliveryError("mr_plot_generation_failed", "diagnosticPlots")
