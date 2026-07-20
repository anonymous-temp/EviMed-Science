#!/usr/bin/env python3
"""Export unresolved incoming Skills and installed packages without task evidence."""

from __future__ import annotations

import csv
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
INPUT = HERE / "results" / "skill-audit-v4.json"
OUTPUT = HERE / "results" / "skill-integration-blockers-v2.csv"


def main() -> None:
    document = json.loads(INPUT.read_text(encoding="utf-8"))
    summary = document["summary"]
    installed = set(summary["freshWebInstalledPackageIds"])
    certified = set(summary["webExecutionCertifiedPackageIds"])
    rows = []
    for package in sorted(installed - certified):
        rows.append({
            "kind": "installed_package",
            "name": package,
            "currentState": "installed_clean_not_task_certified",
            "reason": "The package is installed and available to OpenCode, but no retained end-to-end task artifact currently certifies it.",
            "operatorAction": "None for installation; authorize a bounded model-backed acceptance task if release certification is required.",
            "evimedAction": "Execute the Skill through the production OpenCode harness, retain its declared artifacts and provenance, and add result-quality checks.",
        })
    for item in document["items"]:
        if item["releaseStatus"] == "capability_mapped":
            continue
        disposition = item["disposition"]
        if disposition == "credentialed_or_licensed_optional":
            operator = "Provide the service account, API terms/license, test tenant, and explicit request to enable this optional integration."
            action = "Re-audit the upstream package, replace secret handling with a server-managed adapter, and execute an end-to-end task."
        elif disposition == "physical_hardware_not_default":
            operator = "Provide the exact device/cluster, safety boundary, credentials, and a non-production test environment."
            action = "Build a device-specific adapter and acceptance suite; do not enable physical actuation globally."
        elif disposition == "excluded_clinical_decision_support":
            operator = "Confirm a future scope expansion before any autonomous clinical decision-support behavior is introduced."
            action = "Keep outside the autonomous research action space; reassess only under a separate clinical safety program."
        else:
            operator = "No action required unless this duplicate capability has a concrete use case not covered by the mapped runtime."
            action = "Keep excluded to avoid duplicate or conflicting instructions; reopen only with a unique executable acceptance case."
        rows.append({
            "kind": "reviewed_source_skill",
            "name": item["sourceName"],
            "currentState": item["releaseStatus"],
            "reason": item["decision"],
            "operatorAction": operator,
            "evimedAction": action,
        })

    fields = ["kind", "name", "currentState", "reason", "operatorAction", "evimedAction"]
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    print({"output": OUTPUT.relative_to(REPO).as_posix(), "rows": len(rows)})


if __name__ == "__main__":
    main()
