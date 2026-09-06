#!/usr/bin/env python3
"""Topic-specific coverage diagnostics with citation and workspace checks.

Coverage counts describe the retrieved set; they do not establish novelty.
Dataset scoping retains its distinct evidence policy in evidence_floor.py.
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
    EVIDENCE_CHANNELS,
    FULL_TEXT_DIR,
    URL_MENTION,
    citations_in,
    check_novelty_statements,
    read_text,
)

REPORT = "research-topic-report.md"
RUN_RECEIPT = "research-topic-run.json"
PORTFOLIO = "research-portfolio.json"
EVIDENCE_RECORDS = "evidence-records.json"
REQUIRED_OUTPUTS = (REPORT, EVIDENCE_MAP, RUN_RECEIPT, PORTFOLIO, EVIDENCE_RECORDS)
PROSE_OUTPUTS = (REPORT, EVIDENCE_MAP)
# A candidate question, as the report is asked to head them. Counting headings
# rather than novelty lines keeps the two independent: the count of questions
# comes from the agenda, the count of statements from what was written about it.
CANDIDATE_HEADING = re.compile(r"^#{2,4}\s*(?:Q\d|课题|候选(?:选题|问题)|Candidate|Question)\b", re.I | re.M)
# Absence from a small search is not novelty, and the skill says so; a report
# that claims a gap without saying what it searched has skipped the argument.
SEARCH_SCOPE = re.compile(r"(?:检索(?:范围|策略|式)|search (?:scope|strategy)|查询式)", re.I)


def check_topic_evidence(root, issues, warnings):
    """Count coverage while keeping unresolved citations actionable."""
    mapped = read_text(root, EVIDENCE_MAP)
    cited = set().union(*(citations_in(read_text(root, name)) for name in PROSE_OUTPUTS))
    mapped_works = citations_in(mapped)
    openable, unopenable = set(), set()
    for line in mapped.splitlines():
        works = citations_in(line)
        if URL_MENTION.search(line):
            openable.update(works)
        else:
            unopenable.update(works)
    missing = sorted(cited - mapped_works)
    if missing:
        issues.append(f"Works cited in the report are absent from {EVIDENCE_MAP}: {', '.join(missing[:5])}.")
    if unopenable:
        issues.append(f"{EVIDENCE_MAP} has identifiers with no URL: {', '.join(sorted(unopenable)[:5])}.")
    channels = sorted(name for name, pattern in EVIDENCE_CHANNELS if pattern.search(mapped))
    sources = root / FULL_TEXT_DIR
    full_texts = 0
    if sources.is_dir() and not sources.is_symlink():
        for child in sources.iterdir():
            document = child / "fulltext.md"
            if child.is_dir() and not child.is_symlink() and document.is_file() and not document.is_symlink() and document.stat().st_size:
                full_texts += 1
    warnings.append(
        f"Coverage diagnostic: {len(cited)} works, {len(channels)} channels, {full_texts} preserved full texts. "
        "Judge adequacy against the question, closest prior work, search scope and source availability; "
        "counts do not establish novelty. Record evidence gaps and narrow claims when coverage is sparse."
    )
    return {"worksCited": len(cited), "worksMapped": len(mapped_works), "worksOpenable": len(openable),
            "channels": channels, "fullTextsRetrieved": full_texts}


def main() -> int:
    parser = argparse.ArgumentParser(description="Preflight research topic selection deliverables.")
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()
    root = Path(args.workspace).resolve()

    issues: list[str] = []
    for name in REQUIRED_OUTPUTS:
        if not (root / name).is_file() or (root / name).is_symlink():
            issues.append(f"{name} must be a regular file inside the workspace.")
    if issues:
        print(json.dumps({"ok": False, "workspace": str(root), "metrics": {}, "issues": issues, "warnings": []}))
        return 1

    warnings: list[str] = []
    metrics = check_topic_evidence(root, issues, warnings)
    report = read_text(root, REPORT)
    candidates = len(CANDIDATE_HEADING.findall(report))
    metrics["candidateQuestions"] = candidates
    metrics.update(check_novelty_statements(root, REPORT, candidates, warnings))

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
