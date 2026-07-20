"""Fixed-argument EviMed adapter for the drug-safety specialist.

OpenScience specialist_jobs contract (mirrors the other Python agents):

    python evimed_runner.py --request request.json --output-dir <dir>

request.json:
    {"drug": "atorvastatin",                     # required
     "reactions": ["myalgia", "myopathy"],       # optional
     "outputLanguage": "zh" | "en"}              # optional, default zh

On success writes safety-report.md / safety-report.docx / safety-report.pdf
(LibreOffice permitting) / signals.csv into the output dir and a
result.json of the form:
    {"status": "succeeded", "drug": ..., "reactions": [...],
     "report": "safety-report.md", "signals": "signals.csv",
     "artifacts": [...]}
On failure writes {"status": "failed", "error": ...} and exits 1.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import traceback
from pathlib import Path

from safety_agent.analysis.runner import run_to_files
from safety_agent.core.logging import configure_logging, get_logger

logger = get_logger(__name__)


def _write_result(output_dir: Path, value: dict) -> None:
    (output_dir / "result.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def run(request_path: Path, output_dir: Path) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request.json must be a JSON object")
        drug = str(request.get("drug") or "").strip()
        if not drug:
            raise ValueError("drug is required")
        raw_reactions = request.get("reactions") or []
        if not isinstance(raw_reactions, list):
            raise ValueError("reactions must be an array of strings")
        reactions = [str(item).strip() for item in raw_reactions if str(item).strip()]
        language = str(request.get("outputLanguage") or "zh")
        if language not in ("zh", "en"):
            raise ValueError("outputLanguage must be 'zh' or 'en'")

        configure_logging("INFO")
        artifacts = asyncio.run(
            run_to_files(
                drug,
                reactions,
                language=language,
                outdir=output_dir,
                stem="safety-report",
            )
        )
        names = [
            path.name
            for path in (artifacts.get("markdown"), artifacts.get("docx"), artifacts.get("pdf"), artifacts.get("csv"))
            if path is not None
        ]
        _write_result(
            output_dir,
            {
                "status": "succeeded",
                "drug": drug,
                "reactions": reactions,
                "report": "safety-report.md",
                "signals": "signals.csv",
                "artifacts": names,
            },
        )
        return 0
    except Exception as error:
        traceback.print_exc()
        _write_result(output_dir, {"status": "failed", "error": str(error)})
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="EviMed drug-safety runner")
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    raise SystemExit(main())
