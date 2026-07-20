#!/usr/bin/env python3
"""Run one installed EviMed specialist adapter against its real managed runtime."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DATA_ROOT = REPO_ROOT / ".openscience-web-data" / "users" / "evimed" / "projects"
MCP_ROOT = REPO_ROOT / "runtime" / "mcp" / "evimed-research"
RESULTS_ROOT = HERE / "results"

REQUESTS = {
    "evimed_meta_analysis": {
        "topic": "SGLT2 inhibitors versus placebo for chronic kidney disease progression in adults",
        "outputLanguage": "zh",
        "maxPapers": 20,
        "analysisType": "pairwise",
    },
    "evimed_mendelian_randomization": {
        "exposure": "LDL cholesterol",
        "outcome": "coronary heart disease",
        "outputLanguage": "zh",
        "analysisDirection": "forward",
    },
    "evimed_bibliometric_analysis": {
        "topic": "osimertinib cardiotoxicity",
        "dateFrom": "2021",
        "dateTo": "2025",
        "maxRecords": 20,
        "outputLanguage": "zh",
    },
    "evimed_research_topic_selection": {
        "researchDirection": "precision dosing of antibiotics in critically ill adults",
        "outputLanguage": "zh",
    },
    "evimed_peer_review": {
        "manuscript": "specialist-smoke-input.md",
        "articleType": "original-research",
        "outputLanguage": "zh",
    },
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_runtime(project: str) -> tuple[Path, dict]:
    project_root = DATA_ROOT / project
    workspace = project_root / "workspace"
    config_path = project_root / "runtime" / "xdg-config" / "opencode" / "opencode.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    entry = config.get("mcp", {}).get("evimed-research", {})
    environment = entry.get("environment", {})
    if not workspace.is_dir() or not isinstance(environment, dict):
        raise RuntimeError("Managed EviMed runtime configuration is unavailable.")
    for key, value in environment.items():
        if isinstance(key, str) and isinstance(value, str):
            os.environ[key] = value
    os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(workspace.resolve())
    return workspace, config


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tool", required=True, choices=sorted(REQUESTS))
    parser.add_argument("--project", default="default")
    parser.add_argument("--manuscript-source", type=Path)
    parser.add_argument("--timeout-minutes", type=int, default=45)
    args = parser.parse_args()

    workspace, _ = load_runtime(args.project)
    if args.tool == "evimed_peer_review":
        if not args.manuscript_source or not args.manuscript_source.is_file():
            raise RuntimeError("Peer review requires --manuscript-source.")
        shutil.copyfile(args.manuscript_source, workspace / "specialist-smoke-input.md")

    sys.path.insert(0, str(MCP_ROOT))
    import server  # pylint: disable=import-outside-toplevel

    request = {"action": "start", **REQUESTS[args.tool]}
    started_at = time.monotonic()
    started = server.call_tool(args.tool, request)
    job_id = started.get("data", {}).get("jobId")
    if not job_id:
        raise RuntimeError("Specialist did not return a job id: %s" % started.get("summary", "unknown"))

    deadline = started_at + args.timeout_minutes * 60
    terminal = None
    while time.monotonic() < deadline:
        terminal = server.call_tool(args.tool, {"action": "status", "jobId": job_id})
        job_status = terminal.get("data", {}).get("jobStatus")
        if job_status in {"succeeded", "failed", "canceled"}:
            break
        time.sleep(3)
    else:
        raise TimeoutError("Specialist job exceeded the configured timeout.")

    result = {
        "schemaVersion": 1,
        "tool": args.tool,
        "project": args.project,
        "jobId": job_id,
        "jobStatus": terminal.get("data", {}).get("jobStatus"),
        "summary": terminal.get("summary", ""),
        "releaseStatus": terminal.get("data", {}).get("releaseStatus"),
        "releaseDecision": terminal.get("data", {}).get("releaseDecision"),
        "error": terminal.get("error"),
        "artifacts": terminal.get("artifacts", []),
        "elapsedSeconds": round(time.monotonic() - started_at, 3),
        "completedAt": now(),
    }
    RESULTS_ROOT.mkdir(parents=True, exist_ok=True)
    output = RESULTS_ROOT / (args.tool + ".json")
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["jobStatus"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
