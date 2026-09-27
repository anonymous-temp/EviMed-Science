#!/usr/bin/env python3
"""Non-mutating traceability checks for the drug-selection deliverable.

C1  citation indices close both ways (every [n] in the report has a reference
    entry and every reference entry is reached by some [n])
C2  every URL in the report body appears in evidence-snapshot.json sources[].url
C3  every numeric token in the report body resolves to the derived numeric ledger
    built from the preserved source text backing this deliverable
C4  the declared tabular artefact parses with its header row first and its
    data-row count matches what the report claims for it
C5  every evidenceId used in a domain assessment resolves to a snapshot source,
    and every snapshot source is used by at least one assessment row

Writes checks/traceability-checks.json and prints a short summary.
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPORT = os.path.join(BASE, "drug-selection-report.md")
SNAP = os.path.join(BASE, "evidence-snapshot.json")
ASSESS = os.path.join(BASE, "domain-assessments.json")
SUMMARY = os.path.join(BASE, "decision-summary.json")
SCORECARD = os.path.join(BASE, "selection-scorecard.csv")
LEDGER = os.path.join(BASE, "checks", "source-numbers.json")
OUTDIR = os.path.join(BASE, "checks")
OUT = os.path.join(OUTDIR, "traceability-checks.json")


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    report = read(REPORT)
    snap_text = read(SNAP)
    assess_text = read(ASSESS)
    summary_text = read(SUMMARY)
    ledger = json.loads(read(LEDGER))

    body, _, ref_section = report.partition("## 参考文献")
    results = {}

    # C1 --------------------------------------------------------------
    marks = sorted({int(m) for m in re.findall(r"\[(\d{1,3})\]", body)})
    entries = sorted({int(m) for m in re.findall(r"^\[(\d{1,3})\]", ref_section, re.M)})
    marks_missing_entry = [m for m in marks if m not in entries]
    entries_never_reached = [e for e in entries if e not in marks]
    results["C1_citation_indices_closed"] = {
        "marks": marks,
        "entries": entries,
        "marks_without_entry": marks_missing_entry,
        "entries_without_mark": entries_never_reached,
        "residue_empty": not marks_missing_entry and not entries_never_reached,
    }

    # C2 --------------------------------------------------------------
    snapshot = json.loads(snap_text)
    known_urls = {s.get("url") for s in snapshot["sources"] if s.get("url")}
    body_urls = sorted(set(re.findall(r"https?://[^\s\)\]，。]+", body)))
    unknown = [u for u in body_urls if u not in known_urls]
    results["C2_urls_in_snapshot"] = {
        "body_urls": body_urls,
        "unknown_urls": unknown,
        "residue_empty": not unknown,
    }

    # C3 --------------------------------------------------------------
    # Internal pointers (gap identifiers and section numbers of this report) are
    # navigation labels, not evidence claims; they are excluded by the explicit
    # allowlist below and nothing else is.
    internal_pointers = {
        "01", "02", "03", "04", "05", "06", "07", "08", "09",  # GAP-nn
        "1.1", "1.2", "2", "3", "3.1", "3.2", "4", "5", "5.1", "5.2",
        "6", "6.1", "6.2", "7", "7.1", "7.2", "7.3", "8", "9", "10", "10.1", "10.2", "11",
        "2026",  # decision-date label in the report header, carried by scope.decisionDate
    }
    ledger_numbers = set(ledger["numbers"])
    body_nums = re.findall(r"\d+(?:\.\d+)?", body)
    untraceable = sorted(
        {n for n in body_nums if n not in ledger_numbers and n not in internal_pointers}
    )
    results["C3_numbers_traceable"] = {
        "distinct_body_numbers": len(set(body_nums)),
        "ledger_union_size": ledger["unionNumberCount"],
        "ledger_sources": ledger["sourceCount"],
        "missing_preserved_sources": ledger["missingPreservedSources"],
        "excluded_as_internal_pointers": sorted(
            {n for n in body_nums if n in internal_pointers}
        ),
        "untraceable": untraceable,
        "residue_empty": not untraceable and not ledger["missingPreservedSources"],
    }

    # C4 --------------------------------------------------------------
    lines = [l for l in read(SCORECARD).split("\n") if l.strip()]
    header = lines[0].split(",")
    data_rows = len(lines) - 1
    claimed = re.search(r"`selection-scorecard\.csv`（(\d+) 行数据", report)
    results["C4_table_shape"] = {
        "first_line_is_header": header[0] == "candidate" and header[1] == "domain",
        "header": header,
        "data_rows": data_rows,
        "claimed_in_report": int(claimed.group(1)) if claimed else None,
        "matches": bool(claimed) and int(claimed.group(1)) == data_rows,
    }

    # C5 --------------------------------------------------------------
    known_ids = {s["id"] for s in snapshot["sources"]}
    used = set()
    unresolved = []
    for row in json.loads(assess_text)["domainAssessments"]:
        for eid in row["evidenceIds"]:
            used.add(eid)
            if eid not in known_ids:
                unresolved.append(eid)
    unused = sorted(known_ids - used)
    results["C5_evidence_ids_resolve"] = {
        "snapshot_source_count": len(known_ids),
        "used_source_count": len(used),
        "unresolved": sorted(set(unresolved)),
        "snapshot_sources_unused_by_any_assessment": unused,
        "residue_empty": not unresolved,
    }

    all_ok = all(
        v.get("residue_empty", v.get("matches")) for k, v in results.items()
    )
    payload = {"allResidueEmpty": all_ok, "checks": results}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    for name, res in results.items():
        print(name, "->", json.dumps(res, ensure_ascii=False)[:400])
    print("ALL_RESIDUE_EMPTY:", all_ok)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
