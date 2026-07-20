#!/usr/bin/env python3
"""Combine unchanged baseline passes with targeted post-fix reruns."""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path


HERE = Path(__file__).resolve().parent
CORPUS = HERE / "corpus-v3" / "manifest.json"
BASELINE = HERE / "grades" / "baseline"
ITERATION = HERE / "grades" / "fidelity-gate-v1"
OUTPUT = HERE / "grades" / "final-combined"


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def main() -> None:
    corpus = read(CORPUS)
    rows = []
    by_category: dict[str, Counter] = defaultdict(Counter)
    for case in corpus["cases"]:
        case_id = case["caseId"]
        iteration_path = ITERATION / f"{case_id}.json"
        grade_path = iteration_path if iteration_path.exists() else BASELINE / f"{case_id}.json"
        grade = read(grade_path)
        selected_label = "fidelity-gate-v1" if iteration_path.exists() else "baseline"
        row = {
            "caseId": case_id,
            "category": case["category"],
            "title": case["title"],
            "pmcid": case["pmcid"],
            "doi": case.get("doi", ""),
            "selectedLabel": selected_label,
            "terminalSuccess": grade["deterministic"]["terminalSuccess"],
            "sectionCoverageRate": grade["deterministic"]["sectionCoverageRate"],
            "numericPrecision": grade["deterministic"]["supportedNumericClaimPrecision"],
            "verbatimEightGramRate": grade["deterministic"]["verbatimEightGramRate"],
            "modelVerdict": grade.get("model", {}).get("verdict", "not-run"),
            "overallVerdict": grade.get("overallVerdict", "fail"),
            "majorUnsupportedClaims": grade.get("model", {}).get("majorUnsupportedClaims", []),
        }
        rows.append(row)
        bucket = by_category[row["category"]]
        bucket["cases"] += 1
        bucket["passed"] += int(row["overallVerdict"] == "pass")

    if len(rows) != 50 or any(row["modelVerdict"] == "not-run" for row in rows):
        raise RuntimeError("Final combined evaluation is incomplete.")

    summary = {
        "schemaVersion": 1,
        "method": "Use the post-fix rerun for every rerun case; otherwise retain its baseline grade.",
        "expectedCases": len(corpus["cases"]),
        "gradedCases": len(rows),
        "baselineCasesRetained": sum(row["selectedLabel"] == "baseline" for row in rows),
        "postFixCasesRerun": sum(row["selectedLabel"] == "fidelity-gate-v1" for row in rows),
        "terminalSuccessRate": mean([float(row["terminalSuccess"]) for row in rows]),
        "requiredSectionCoverageRate": mean([row["sectionCoverageRate"] for row in rows]),
        "supportedNumericClaimPrecisionMean": mean([row["numericPrecision"] for row in rows]),
        "verbatimEightGramRateMean": mean([row["verbatimEightGramRate"] for row in rows]),
        "modelPassRate": mean([float(row["modelVerdict"] == "pass") for row in rows]),
        "overallPassRate": mean([float(row["overallVerdict"] == "pass") for row in rows]),
        "majorUnsupportedClaimCount": sum(len(row["majorUnsupportedClaims"]) for row in rows),
        "byCategory": {key: dict(value) for key, value in sorted(by_category.items())},
        "cases": rows,
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({key: value for key, value in summary.items() if key != "cases"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
