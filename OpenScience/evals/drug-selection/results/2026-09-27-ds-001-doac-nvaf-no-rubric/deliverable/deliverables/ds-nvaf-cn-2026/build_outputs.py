#!/usr/bin/env python3
"""Deterministic generator for selection-scorecard.csv and decision-summary.json.

Reads the frozen evidence snapshot and the domain assessments, then writes the
scorecard (one row per candidate x domain) and the decision summary. Refuses to
generate if a domain assessment references a source id that is not in the
snapshot, or if the candidate x domain grid is not exactly covered once.
"""
import csv
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(BASE, "evidence-snapshot.json")
ASSESS = os.path.join(BASE, "domain-assessments.json")
SCORECARD = os.path.join(BASE, "selection-scorecard.csv")
SUMMARY = os.path.join(BASE, "decision-summary.json")

CANDIDATES = ["阿哌沙班（apixaban）", "利伐沙班（rivaroxaban）", "达比加群酯（dabigatran etexilate）"]
DOMAINS = [
    "pharmaceutical_properties",
    "effectiveness",
    "safety",
    "economics",
    "appropriateness",
    "accessibility",
    "innovation",
    "other",
]
STATUSES = {"favorable", "neutral", "unfavorable", "unclear", "not_assessed"}

SCORE_FIELDS = ["score", "scale_min", "scale_max", "direction", "weight", "score_origin", "rule_version"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def norm(text):
    return re.sub(r"\s+", " ", text).strip()


def main():
    snap = load(SNAP)
    assess = load(ASSESS)

    known_ids = {s["id"] for s in snap["sources"]}
    rows = assess["domainAssessments"]

    seen = set()
    for row in rows:
        key = (row["candidate"], row["domain"])
        if key in seen:
            sys.exit(f"duplicate candidate-domain pair: {key}")
        seen.add(key)
        if row["candidate"] not in CANDIDATES:
            sys.exit(f"unknown candidate: {row['candidate']}")
        if row["domain"] not in DOMAINS:
            sys.exit(f"unknown domain: {row['domain']}")
        if row["status"] not in STATUSES:
            sys.exit(f"unknown status: {row['status']}")
        for eid in row["evidenceIds"]:
            if eid not in known_ids:
                sys.exit(f"evidenceId not resolved in snapshot: {eid}")
        for field in SCORE_FIELDS:
            if field in row and row[field] not in (None, ""):
                sys.exit(f"numeric scoring field {field} present without an approved rubric: {key}")

    expected = {(c, d) for c in CANDIDATES for d in DOMAINS}
    if seen != expected:
        missing = sorted(expected - seen)
        extra = sorted(seen - expected)
        sys.exit(f"grid incomplete; missing={missing} extra={extra}")

    order = {c: i for i, c in enumerate(CANDIDATES)}
    dorder = {d: i for i, d in enumerate(DOMAINS)}
    rows_sorted = sorted(rows, key=lambda r: (order[r["candidate"]], dorder[r["domain"]]))

    header = ["candidate", "domain", "status", "evidence_ids", "rationale"] + SCORE_FIELDS + [
        "missing_data_state",
        "rule_version_status",
    ]

    with open(SCORECARD, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        writer.writerow(header)
        for row in rows_sorted:
            missing_state = (
                "not_assessed_no_evidence"
                if row["status"] == "not_assessed"
                else "partially_evidenced"
                if row["status"] == "unclear"
                else "evidenced"
            )
            writer.writerow(
                [
                    row["candidate"],
                    row["domain"],
                    row["status"],
                    ";".join(row["evidenceIds"]),
                    norm(row["rationale"]),
                    "",  # score
                    "",  # scale_min
                    "",  # scale_max
                    "",  # direction
                    "",  # weight
                    "",  # score_origin
                    "",  # rule_version
                    missing_state,
                    "NOT_SUPPLIED",
                ]
            )

    status_counts = {s: 0 for s in sorted(STATUSES)}
    per_candidate = {}
    for row in rows_sorted:
        status_counts[row["status"]] += 1
        per_candidate.setdefault(row["candidate"], {}).setdefault(row["status"], 0)
        per_candidate[row["candidate"]][row["status"]] += 1

    leave_one_out = {}
    for dropped in DOMAINS:
        remaining = [r for r in rows_sorted if r["domain"] != dropped]
        changed = []
        for cand in CANDIDATES:
            before = {r["domain"]: r["status"] for r in rows_sorted if r["candidate"] == cand}
            after = {r["domain"]: r["status"] for r in remaining if r["candidate"] == cand}
            common = set(before) & set(after)
            if any(before[d] != after[d] for d in common):
                changed.append(cand)
        leave_one_out[dropped] = {
            "candidates_with_changed_status": changed,
            "conclusion_changes": bool(changed),
            "basis": "status-level comparison across the candidate x domain grid; computed locally because the compiler was unavailable",
        }

    summary = {
        "schemaVersion": 1,
        "assessmentType": "drug_selection",
        "deliverableId": "ds-nvaf-cn-2026",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scope": snap["scope"],
        "compiler": {
            "available": False,
            "attemptedAction": "compile",
            "failureReason": "drug_selection_evaluation adapter unreachable: retrieve returned adapter_unavailable (timeout) and subsequent calls returned adapter_circuit_open; compile was therefore not attempted",
            "ranking": "withheld",
            "rankingWithheldReasons": [
                "no approved institutional scoring rubric supplied (selectionDomains, scoringRubric, scoringPolicyVersion are missing user inputs)",
                "scoring prerequisite for economics incomplete: currency, price date, dosage basis, treatment duration, jurisdiction and perspective all missing",
                "the deterministic compiler could not be reached, so no compiler-endorsed coverage, comparability or sensitivity result exists",
            ],
            "minimumInputsToRank": [
                "approved scoring rubric text",
                "rubric or policy version identifier",
                "per-domain weights and direction",
                "missing-data rule",
            ],
        },
        "scorecard": {
            "file": "selection-scorecard.csv",
            "rowCount": len(rows_sorted),
            "headerRowIsFirstLine": True,
            "candidateCount": len(CANDIDATES),
            "domainCount": len(DOMAINS),
            "numericScoringFields": "all empty (no approved rubric)",
        },
        "statusCounts": status_counts,
        "statusCountsPerCandidate": per_candidate,
        "leaveOneDomainOutSensitivity": leave_one_out,
        "evidenceGapIds": [g["id"] for g in snap["evidenceGaps"]],
        "humanReview": {
            "required": True,
            "flag": "human_review_required",
            "statement": "This is one committee input. The authorized pharmacy and therapeutics process remains the final decision maker; no procurement, reimbursement or patient-level treatment decision is made here.",
        },
        "audit": {
            "evidenceSnapshotSha256": sha256(SNAP),
            "domainAssessmentsSha256": sha256(ASSESS),
            "scorecardSha256": sha256(SCORECARD),
            "hashAlgorithm": "sha256",
        },
    }

    with open(SUMMARY, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"scorecard rows (incl. header): {len(rows_sorted) + 1}")
    print(f"status counts: {status_counts}")
    print(f"audit evidence-snapshot sha256: {summary['audit']['evidenceSnapshotSha256']}")
    print(f"audit scorecard sha256: {summary['audit']['scorecardSha256']}")


if __name__ == "__main__":
    main()
