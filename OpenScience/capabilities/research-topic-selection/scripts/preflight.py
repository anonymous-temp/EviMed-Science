#!/usr/bin/env python3
"""Deterministic preflight for research-topic-selection deliverables.

The specialist job this skill drives searches PubMed and nothing else, so the
one thing a reader of the agenda cannot check is how much of the field was read
before it was written. That is what this checks: works, channels, full texts,
citations a reader can open, and a novelty statement for every candidate
question that reached the agenda.

The floors themselves live in `evidence_floor.py`, which is kept byte-identical
with the copy under `dataset-research-scoping/scripts/`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evidence_floor import (  # noqa: E402  - resolved from this script's own directory
    EVIDENCE_MAP,
    check_evidence_breadth,
    check_novelty_statements,
    read_text,
)

REPORT = "research-topic-report.md"
RUN_RECEIPT = "research-topic-run.json"
REQUIRED_OUTPUTS = (REPORT, EVIDENCE_MAP, RUN_RECEIPT)
PROSE_OUTPUTS = (REPORT, EVIDENCE_MAP)
# A candidate question, as the report is asked to head them. Counting headings
# rather than novelty lines keeps the two independent: the count of questions
# comes from the agenda, the count of statements from what was written about it.
CANDIDATE_HEADING = re.compile(r"^#{2,4}\s*(?:Q\d|课题|候选(?:选题|问题)|Candidate|Question)\b", re.I | re.M)
# Absence from a small search is not novelty, and the skill says so; a report
# that claims a gap without saying what it searched has skipped the argument.
SEARCH_SCOPE = re.compile(r"(?:检索(?:范围|策略|式)|search (?:scope|strategy)|查询式)", re.I)


def main() -> int:
    parser = argparse.ArgumentParser(description="Preflight research topic selection deliverables.")
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()
    root = Path(args.workspace).resolve()

    issues: list[str] = []
    for name in REQUIRED_OUTPUTS:
        if not (root / name).is_file():
            issues.append(f"{name} is missing.")

    metrics = check_evidence_breadth(root, PROSE_OUTPUTS, issues)
    report = read_text(root, REPORT)
    candidates = len(CANDIDATE_HEADING.findall(report))
    metrics["candidateQuestions"] = candidates
    metrics.update(check_novelty_statements(root, REPORT, candidates, issues))

    warnings: list[str] = []
    if report.strip() and not SEARCH_SCOPE.search(report):
        warnings.append(
            f"{REPORT}: states an evidence landscape without recording the search scope it rests on. "
            "Absence from a small search is not proof of novelty."
        )

    payload = {"ok": not issues, "workspace": str(root), "metrics": metrics, "issues": issues, "warnings": warnings}
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
