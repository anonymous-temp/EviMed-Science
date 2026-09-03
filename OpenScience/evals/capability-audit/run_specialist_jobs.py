#!/usr/bin/env python3
"""Start every managed specialist and poll it to a terminal state.

`run_tool_audit.py` does not run the specialists -- it harvests the receipts
they leave behind, and its criterion is deliberately strict: a capabilities
response never counts, only a completed managed job with hashed non-empty
artifacts and source evidence that still matches the installed package. So the
jobs have to be run, and they have to be run within the audit's freshness
window, which is what this script is for.

Run it through `run_tool_gateway_audit.mjs --script run_specialist_jobs.py`, so
the specialists reach the model the same way a runtime's do.

Resumable by construction: a job whose state file is already terminal and fresh
is left alone. These are real analyses -- a meta-analysis manuscript takes tens
of minutes -- and re-running the finished ones to reach the unfinished ones
would make an interrupted sweep unaffordable to resume.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MCP_ROOT = REPO / "runtime" / "mcp" / "evimed-research"
POLL_SECONDS = 30

# One real brief per specialist. They are the questions these engines exist to
# answer, not smoke inputs: a job that completes on a toy question certifies a
# pipeline nobody runs, and the artifacts it leaves are what the audit hashes.
BRIEFS = {
    "meta_analysis": {
        "topic": "SGLT2 inhibitors versus placebo for chronic kidney disease progression",
        "outputLanguage": "zh",
    },
    "mendelian_randomization": {
        "exposure": "body mass index",
        "outcome": "type 2 diabetes",
        "outputLanguage": "zh",
    },
    "bibliometric_analysis": {
        "topic": "GLP-1 receptor agonists in cardiovascular outcomes",
        "maxRecords": 200,
        "outputLanguage": "zh",
    },
    "research_topic_selection": {
        "researchDirection": "gut microbiome modulation in inflammatory bowel disease",
        "outputLanguage": "zh",
    },
    "peer_review": {
        # Filled in from --manuscript: the tool resolves it inside the workspace
        # and refuses anything outside it.
        "articleType": "systematic-review",
        "outputLanguage": "zh",
    },
    "drug_safety_analysis": {
        "drug": "metformin",
        "reactions": ["lactic acidosis"],
        "outputLanguage": "zh",
    },
}
JOB_DIRECTORIES = {
    "meta_analysis": ("meta-analysis-runs", "meta-"),
    "mendelian_randomization": ("mendelian-randomization-runs", "mr-"),
    "bibliometric_analysis": ("bibliometric-analysis-runs", "bibliometric-"),
    "research_topic_selection": ("research-topic-runs", "topic-"),
    "peer_review": ("peer-review-runs", "review-"),
    "drug_safety_analysis": ("drug-safety-runs", "safety-"),
}


def load_server():
    sys.path.insert(0, str(MCP_ROOT))
    spec = importlib.util.spec_from_file_location("evimed_specialist_driver_server", MCP_ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_terminal_job(workspace: Path, tool: str, max_age_days: float):
    """A terminal job already inside the audit's freshness window, if there is one."""
    directory, prefix = JOB_DIRECTORIES[tool]
    newest = None
    for state_path in workspace.glob("%s/.jobs/%s*.json" % (directory, prefix)):
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state.get("status") not in {"succeeded", "blocked"}:
                continue
            updated = datetime.fromisoformat(str(state["updatedAt"]).replace("Z", "+00:00"))
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
        if (datetime.now(timezone.utc) - updated).total_seconds() / 86400 > max_age_days:
            continue
        if newest is None or updated > newest[0]:
            newest = (updated, state)
    return newest[1] if newest else None


def run_one(server, tool: str, arguments: dict, timeout_seconds: float):
    started = server.call_tool(tool, {"action": "start", **arguments})
    if started.get("status") == "error":
        return {"tool": tool, "outcome": "start_failed", "detail": started.get("summary")}
    job_id = (started.get("data") or {}).get("jobId")
    if not job_id:
        return {"tool": tool, "outcome": "start_failed", "detail": "the start response carried no job id"}
    print("%s started: %s" % (tool, job_id), flush=True)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        status = server.call_tool(tool, {"action": "status", "jobId": job_id})
        data = status.get("data") or {}
        job_status = data.get("jobStatus")
        if job_status in {"queued", "running"}:
            continue
        print("%s %s: %s" % (tool, job_id, job_status), flush=True)
        return {"tool": tool, "outcome": job_status, "jobId": job_id, "detail": status.get("summary")}
    return {"tool": tool, "outcome": "timed_out", "jobId": job_id}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe-workspace", type=Path, required=True)
    parser.add_argument("--manuscript", default="", help="workspace-relative manuscript for peer_review")
    parser.add_argument("--tool", action="append", default=[], help="run only these specialists")
    parser.add_argument("--max-receipt-age-days", type=float, default=14)
    parser.add_argument("--job-timeout-seconds", type=float, default=10800)
    parser.add_argument("--force", action="store_true", help="run even when a fresh terminal job exists")
    args = parser.parse_args()

    workspace = args.probe_workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(workspace)
    server = load_server()

    tools = args.tool or list(BRIEFS)
    results = []
    for tool in tools:
        if tool not in BRIEFS:
            raise SystemExit("unknown specialist: %s" % tool)
        existing = None if args.force else fresh_terminal_job(workspace, tool, args.max_receipt_age_days)
        if existing is not None:
            print("%s already has a fresh terminal job: %s" % (tool, existing.get("jobId")), flush=True)
            results.append({"tool": tool, "outcome": "already_fresh", "jobId": existing.get("jobId")})
            continue
        arguments = dict(BRIEFS[tool])
        if tool == "peer_review":
            if not args.manuscript:
                results.append({"tool": tool, "outcome": "skipped", "detail": "--manuscript was not supplied"})
                continue
            arguments["manuscript"] = args.manuscript
        results.append(run_one(server, tool, arguments, args.job_timeout_seconds))

    print(json.dumps(results, ensure_ascii=False, indent=2))
    terminal = {"succeeded", "blocked", "already_fresh"}
    raise SystemExit(0 if all(item["outcome"] in terminal for item in results) else 1)


if __name__ == "__main__":
    main()
