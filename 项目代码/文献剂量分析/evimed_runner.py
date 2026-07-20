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


def _write_result(output_dir: Path, value: dict) -> None:
    (output_dir / "result.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


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
        if not report.is_file() or report.stat().st_size < 100:
            raise RuntimeError("bibliometric pipeline did not create a usable report")
        _write_result(output_dir, {
            "status": "succeeded",
            "topic": topic,
            "records": len(pipeline.articles),
            "report": report.name,
        })
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
