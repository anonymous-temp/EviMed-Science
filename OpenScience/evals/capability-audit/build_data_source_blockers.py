#!/usr/bin/env python3
"""Export every non-connected catalog source with an explicit owner and next action."""

from __future__ import annotations

import csv
import importlib.util
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CATALOG = REPO / "runtime" / "mcp" / "evimed-research" / "source_catalog.py"
OUTPUT = HERE / "results" / "data-source-integration-blockers-v2.csv"


def load_catalog():
    spec = importlib.util.spec_from_file_location("evimed_data_source_blocker_catalog", CATALOG)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def operator_action(item: dict) -> str:
    state = item["connectionState"]
    credential = str(item.get("credential") or "").strip()
    if state == "ready_credentials":
        return "Provide %s in a mode-600 server secret file; then authorize a live acceptance probe." % credential
    if state == "adapter_credentials_required":
        return "Register/approve the official account and provide %s after the remaining adapter is implemented." % credential
    if state == "ready_private_adapter":
        return "Provide the private service endpoint, authentication contract, sample response, and test tenant." 
    if state == "blocked_license":
        return "Confirm commercial/reuse rights or supply the executed license/contract and permitted fields."
    if state == "blocked_approval":
        return "Confirm the intended controlled-data cohort and provide approval plus a compliant test workspace."
    if state == "blocked_no_api":
        return "Provide an approved export, mirror, or partner endpoint if one becomes available."
    return "No operator action is required until this source is selected for implementation."


def evimed_action(item: dict) -> str:
    state = item["connectionState"]
    if state == "ready_credentials":
        return "Run two live production-gateway queries, retain provenance, verify result parsing, and only then promote to connected_public."
    if state == "adapter_credentials_required":
        return "Implement and contract-test the source-specific protocol without exposing credentials to OpenCode."
    if state == "ready_private_adapter":
        return "Implement the tenant-scoped private adapter and end-to-end artifact test after the endpoint contract is supplied."
    if state in {"blocked_license", "blocked_approval"}:
        return "Do not ingest or redistribute until permission scope is documented; then build a least-privilege connector and acceptance fixture."
    if state == "blocked_no_api":
        return "Monitor the official source; do not ship brittle scraping or CAPTCHA bypasses."
    return "Keep outside the executable registry."


def main() -> None:
    catalog = load_catalog()
    rows = [item for item in catalog.sources() if item["connectionState"] not in {"connected_public", "skill_guidance"}]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "id", "name", "domain", "priority", "connectionState", "accessClass", "connector",
        "officialUrl", "credential", "license", "blocker", "operatorAction", "evimedAction",
    ]
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for item in rows:
            writer.writerow({
                **{field: item.get(field) or "" for field in fields},
                "operatorAction": operator_action(item),
                "evimedAction": evimed_action(item),
            })
    print({"output": OUTPUT.relative_to(REPO).as_posix(), "rows": len(rows)})


if __name__ == "__main__":
    main()
