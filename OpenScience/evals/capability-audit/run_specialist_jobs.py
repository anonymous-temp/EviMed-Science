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

Completed jobs are reused only through the harvester's current source/artifact
validator. These are real analyses -- a meta-analysis manuscript takes tens
of minutes -- and re-running the finished ones to reach the unfinished ones
would make an interrupted sweep unaffordable to resume.

Operator sequence (private endpoints and refreshed credential files are supplied
out of band, never written into these commands or the retained evidence):
1. Provision a fresh audit project under a data root shared with an isolated
   candidate adapter, inside this checkout's evals/capability-audit/workspaces/.
   The adapter's token must name that account/project and project.json must
   select the same workspace. A remote production adapter cannot see an
   unrelated local directory just because --probe-workspace names it.
2. Run the other five tools through the gateway wrapper with explicit --tool
   flags, a real --manuscript, and installed candidate specialist environments.
   Existing eligible receipts are reused; source drift causes a new job.
3. Run --tool mendelian_randomization with --mr-adapter-url,
   --adapter-token-file, --adapter-user, --adapter-project, --adapter-data-root
   and --download-public-mr (or a verified --mr-fixture-cache). Base R exports
   the pinned public pair. The request does not require an OpenGWAS JWT, but
   the separate EviMed workload token still requires issuer-managed refresh.
4. Run run_tool_audit.py through the same gateway wrapper, naming all audit
   --receipt-workspace values and a NEW --output-dir. Verify that staged
   evidence with verify_release_audit.verify_tools before promoting it.

Hosted certification requires data.auditReceipt with current full execution
evidence, protected request/input hashes, scope and artifact hashes, signed with
the separately provisioned Ed25519 audit key. It must name the original start
jobId and bind the exact checked-in public fixture plus raw-source/license
provenance. The verifier pins the public key; the driver never holds a signing
private key. The current
adapter's jobId/jobStatus-only response cannot certify this and produces the
explicit hosted_receipt_missing:auditReceipt blocker. Never synthesize a legacy
.jobs file, use the low-level MR engine, or copy a token/private queue to make
that result look certified. This script does not create an adapter endpoint.
"""

from __future__ import annotations

import argparse
import base64
import stat
import uuid
import urllib.parse
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from hosted_receipts import ReceiptError, canonical, capture_receipt, read_owned, relative_path, write_new
from public_mr_fixture import prepare as prepare_public_mr


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
        "outcome": "coronary heart disease",
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


def load_audit():
    spec = importlib.util.spec_from_file_location("evimed_specialist_receipt_audit", HERE / "run_tool_audit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_terminal_job(workspace: Path, tool: str, max_age_days: float):
    """Reuse exactly what the harvester can certify, including source hashes."""
    return load_audit().latest_specialist_receipt(tool, [workspace], max_age_days)


def adapter_context(args, workspace):
    """Local scope checks are not signature verification; the adapter authenticates.

    This token is a short-lived EviMed workload credential, NOT an OpenGWAS JWT.
    The issuer must keep refreshing its 0600 file throughout a long analysis.
    The adapter and driver must see the same separately provisioned audit data
    root. A production endpoint cannot operate on an unrelated local folder.
    """
    workspace = workspace.resolve(strict=True)
    endpoint = args.mr_adapter_url or os.environ.get("EVIMED_MR_ANALYSIS_URL", "")
    parsed = urllib.parse.urlsplit(endpoint)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise ReceiptError("isolated_mr_adapter_url_required")
    token_file = args.adapter_token_file or os.environ.get("EVIMED_WORKLOAD_TOKEN_FILE", "")
    if not token_file:
        raise ReceiptError("adapter_workload_token_file_required")
    candidate = Path(token_file).absolute()
    if candidate.is_symlink():
        raise ReceiptError("adapter_token_must_be_outside_workspace")
    try:
        location = candidate.resolve(strict=True)
        if location.is_relative_to(workspace):
            raise ReceiptError("adapter_token_must_be_outside_workspace")
        info = location.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or not 0 < info.st_size <= 8192:
            raise ValueError()
        raw = read_owned(location.parent, location.name, 8192).decode().strip()
        header, payload, signature = raw.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if (not signature or claims.get("aud") != "evimed-adapter" or claims.get("v") != 1
                or claims.get("userId") != args.adapter_user or claims.get("projectId") != args.adapter_project
                or type(claims.get("exp")) is not int or claims["exp"] <= time.time()):
            raise ValueError()
    except (OSError, ValueError, KeyError, UnicodeDecodeError):
        raise ReceiptError("adapter_workload_scope_invalid") from None
    if not args.adapter_data_root:
        raise ReceiptError("adapter_shared_data_root_required")
    root = Path(args.adapter_data_root).resolve(strict=True)
    project = "users/%s/projects/%s" % (relative_path(args.adapter_user), relative_path(args.adapter_project))
    if "/" in args.adapter_user or "/" in args.adapter_project:
        raise ReceiptError("adapter_workload_scope_invalid")
    metadata = root / project / "project.json"
    active = ""
    if metadata.exists() or metadata.is_symlink():
        active = str(json.loads(read_owned(root, project + "/project.json", 128 * 1024)).get("activeWorkspace") or "")
        if active and ("/" in relative_path(active)):
            raise ReceiptError("adapter_active_workspace_invalid")
    expected = root / project / "workspace"
    if active:
        expected /= active
    if expected.absolute() != workspace.absolute():
        raise ReceiptError("adapter_workspace_not_owned")
    cursor = root
    for part in expected.relative_to(root).parts:
        cursor /= part
        if cursor.is_symlink() or not cursor.is_dir():
            raise ReceiptError("adapter_workspace_not_owned")
    os.environ.update({"EVIMED_MR_ANALYSIS_URL": endpoint, "EVIMED_WORKLOAD_TOKEN_FILE": str(location),
        "OPEN_SCIENCE_USER_ID": args.adapter_user, "OPEN_SCIENCE_PROJECT_ID": args.adapter_project})
    return {"userId": args.adapter_user, "projectId": args.adapter_project, "activeWorkspace": active}


def run_one(server, tool: str, arguments: dict, timeout_seconds: float, *, workspace=None, scope=None):
    started = server.call_tool(tool, {"action": "start", **arguments})
    if started.get("status") == "error":
        return {"tool": tool, "outcome": "start_failed", "detail": (started.get("error") or {}).get("code", "specialist_start_failed")}
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
        if scope is not None and job_status in {"succeeded", "blocked"}:
            try:
                retained = capture_receipt(workspace, tool, arguments, status, scope, expected_job_id=job_id)
                return {"tool": tool, "outcome": job_status, "jobId": job_id, "hostedReceipt": retained}
            except ReceiptError as error:
                return {"tool": tool, "outcome": "uncertified", "jobId": job_id, "detail": str(error)}
        return {"tool": tool, "outcome": job_status or "status_failed", "jobId": job_id,
            "detail": (status.get("error") or {}).get("code")}
    return {"tool": tool, "outcome": "timed_out", "jobId": job_id}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe-workspace", type=Path, required=True)
    parser.add_argument("--manuscript", default="", help="workspace-relative manuscript for peer_review")
    parser.add_argument("--tool", action="append", default=[], help="run only these specialists")
    parser.add_argument("--max-receipt-age-days", type=float, default=14)
    parser.add_argument("--job-timeout-seconds", type=float, default=10800)
    parser.add_argument("--mr-adapter-url", default="", help="isolated MR ToolResult endpoint; never a local fallback")
    parser.add_argument("--adapter-token-file", default="", help="rotating 0600 EviMed workload token file outside workspace")
    parser.add_argument("--adapter-user", default="")
    parser.add_argument("--adapter-project", default="")
    parser.add_argument("--adapter-data-root", type=Path)
    parser.add_argument("--mr-fixture-cache", type=Path, help="optional hash-checked official cache; not a release dependency")
    parser.add_argument("--download-public-mr", action="store_true", help="download exact pinned public files into this audit workspace")
    parser.add_argument("--rscript", default="Rscript")
    parser.add_argument("--force", action="store_true", help="run even when a fresh terminal job exists")
    args = parser.parse_args()

    workspace = args.probe_workspace.resolve()
    try:
        workspace.relative_to(REPO.resolve())
    except ValueError:
        raise ReceiptError("audit_workspace_must_be_inside_checkout") from None
    workspace.mkdir(parents=True, exist_ok=True)
    os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(workspace)
    tools = args.tool or list(BRIEFS)
    scope = None
    mr_arguments = None
    if "mendelian_randomization" in tools:
        scope = adapter_context(args, workspace)
        mr_arguments = prepare_public_mr(workspace, cache=args.mr_fixture_cache,
            download=args.download_public_mr, rscript=args.rscript)
    server = load_server()
    results = []
    for tool in tools:
        if tool not in BRIEFS:
            raise SystemExit("unknown specialist: %s" % tool)
        existing = None if args.force else fresh_terminal_job(workspace, tool, args.max_receipt_age_days)
        if existing is not None:
            print("%s already has a fresh terminal job: %s" % (tool, existing.get("jobId")), flush=True)
            results.append({"tool": tool, "outcome": "already_fresh", "jobId": existing.get("jobId")})
            continue
        arguments = dict(mr_arguments if tool == "mendelian_randomization" else BRIEFS[tool])
        if tool == "peer_review":
            if not args.manuscript:
                results.append({"tool": tool, "outcome": "skipped", "detail": "--manuscript was not supplied"})
                continue
            arguments["manuscript"] = args.manuscript
        results.append(run_one(server, tool, arguments, args.job_timeout_seconds,
            workspace=workspace, scope=scope if tool == "mendelian_randomization" else None))

    report_path = ".evimed-audit/driver-runs/%s-%s.json" % (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"), uuid.uuid4().hex[:12])
    write_new(workspace, report_path, canonical(results) + b"\n")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    terminal = {"succeeded", "blocked", "already_fresh"}
    raise SystemExit(0 if all(item["outcome"] in terminal for item in results) else 1)


if __name__ == "__main__":
    try:
        main()
    except ReceiptError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
