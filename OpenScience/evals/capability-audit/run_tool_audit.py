#!/usr/bin/env python3
"""Execute EviMed tools and certify specialist jobs from real artifacts."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MCP_ROOT = REPO / "runtime" / "mcp" / "evimed-research"
RESULTS = HERE / "results"
SPECIALIST_SOURCES = REPO.parent / "项目代码"
SPECIALISTS = {
    "meta_analysis": ("meta-analysis-runs", "meta-"),
    "mendelian_randomization": ("mendelian-randomization-runs", "mr-"),
    "bibliometric_analysis": ("bibliometric-analysis-runs", "bibliometric-"),
    "research_topic_selection": ("research-topic-runs", "topic-"),
    "peer_review": ("peer-review-runs", "review-"),
    "drug_safety_analysis": ("drug-safety-runs", "safety-"),
}
TASK_FIXTURES = {
    "health": {},
    "data_source_catalog": {"status": "connected_public", "limit": 123},
    "biomedical_source_search": {
        "source": "pubmed", "query": "aspirin cardiovascular prevention randomized trial", "limit": 2,
    },
    "official_page_fetch": {
        "url": "https://www.nhs.uk/symptoms/chest-pain/",
    },
    "open_access_full_text": {"identifier": "PMC8010506"},
    # Added 2026-08-26. It had been in the registry, model-facing, and covered
    # by no fixture: the guard above reported that as "does not exactly cover"
    # and `ci:web` reported the whole audit as stale evidence, so a tool nobody
    # had ever probed read like evidence that was merely old.
    "web_search": {"query": "systematic review reporting guideline PRISMA 2020", "limit": 2},
    # `op: providers` asks the probe which front-ends this deployment can reach
    # and is the only operation with no side effect: `ask` would drive real
    # browser sessions against five consumer products. The tool was declared,
    # model-facing and never probed — the same hole the guard below named for
    # `web_search`, which cost twelve days of "stale evidence" that was not
    # stale at all.
    "geo_visibility_probe": {"op": "providers"},
    # The seven first-party science connectors, mounted 2026-09-02. They had
    # been written, tested and declared by nothing; mounting them made them
    # model-facing, and a model-facing tool nobody has ever probed is exactly
    # what the coverage guard above exists to refuse. Each fixture asks the
    # smallest real question its connector answers.
    "search_papers": {"query": "aspirin cardiovascular prevention", "limit": 2},
    "search_biomedical_records": {"query": "metformin type 2 diabetes", "database": "pubmed", "limit": 2},
    "search_materials": {"formula": "Fe2O3", "limit": 1},
    "get_fred_series": {"series_id": "GDP", "limit": 3},
    "get_space_weather_alerts": {"limit": 2},
    "get_weather": {"latitude": 39.9042, "longitude": 116.4074, "forecast_days": 1},
    "get_usgs_water_data": {"site": "01646500", "period": "P1D"},
    "term_normalize": {"term": "心肌梗死", "domain": "disease"},
    "drug_term_normalize": {"term": "acetaminophen"},
    "evidence_deduplicate": {"items": [
        {"id": "a", "title": "Observed trial", "doi": "10.1000/observed"},
        {"id": "b", "title": "Observed trial duplicate", "doi": "https://doi.org/10.1000/observed"},
    ]},
    "literature_search": {
        "query": "aspirin cardiovascular prevention randomized trial", "limit": 2,
        "databases": ["pubmed", "crossref"],
    },
    "guideline_search": {"query": "hypertension clinical practice guideline", "limit": 2},
    "clinical_trial_search": {"query": "type 2 diabetes metformin", "limit": 2},
    "patent_search": {"query": "pembrolizumab biomarker", "limit": 2},
    "pharmacy_reference_search": {"query": "阿司匹林", "limit": 2},
    "drug_label_search": {"drug": "metformin", "jurisdiction": "US", "limit": 1},
    "adr_case_query": {"drug": "aspirin", "adverseEvent": "haemorrhage", "limit": 2},
    "adr_signal_analysis": {
        "drug": "aspirin", "adverseEvent": "nausea", "metrics": ["ror", "prr", "ic"],
    },
    "offlabel_evidence_packet": {
        "action": "compile",
        "drug": "metformin",
        "proposedUse": "polycystic ovary syndrome",
        "population": "adults",
        "jurisdiction": "United States",
        "sourceInventory": [{
            "id": "audit-label-1",
            "title": "Audited label fixture",
            "url": "https://dailymed.nlm.nih.gov/dailymed/",
            "source": "release-audit-fixture",
            "retrievedAt": "2026-07-20T00:00:00Z",
            "evidenceAccess": "full_text",
        }],
        "labelComparisons": [{
            "dimension": "indication",
            "status": "mismatch",
            "jurisdiction": "United States",
            "evidenceIds": ["audit-label-1"],
            "rationale": "The bounded release fixture exercises the traceable mismatch path.",
        }, {
            "dimension": "population",
            "status": "match",
            "jurisdiction": "United States",
            "evidenceIds": ["audit-label-1"],
            "rationale": "The bounded release fixture exercises the population comparison path.",
        }],
    },
    "comprehensive_drug_evaluation": {
        "action": "compile",
        "drug": "metformin",
        "indication": "type 2 diabetes",
        "comparator": "sulfonylurea",
        "sourceInventory": [{
            "id": "audit-study-1",
            "title": "Audited evidence fixture",
            "url": "https://pubmed.ncbi.nlm.nih.gov/1/",
            "source": "release-audit-fixture",
            "retrievedAt": "2026-07-20T00:00:00Z",
            "evidenceAccess": "full_text",
        }],
        "domainAssessments": [{
            "domain": domain,
            "status": "mixed",
            "evidenceIds": ["audit-study-1"],
            "rationale": "The bounded release fixture exercises a traceable core-domain assessment.",
        } for domain in ("effectiveness", "safety", "applicability")],
    },
    "drug_selection_evaluation": {
        "action": "compile",
        "candidateDrugs": ["metformin", "glipizide"],
        "indication": "type 2 diabetes",
        "selectionDomains": ["effectiveness", "safety"],
        "sourceInventory": [{
            "id": "audit-comparison-1",
            "title": "Audited comparative fixture",
            "url": "https://pubmed.ncbi.nlm.nih.gov/1/",
            "source": "release-audit-fixture",
            "retrievedAt": "2026-07-20T00:00:00Z",
        }],
        "domainAssessments": [{
            "candidate": candidate,
            "domain": domain,
            "status": "favorable",
            "evidenceIds": ["audit-comparison-1"],
            "rationale": "The bounded release fixture exercises reproducible institutional scoring.",
            "score": score,
            "scaleMin": 0,
            "scaleMax": 10,
            "direction": "higher_is_better",
            "weight": 1,
            "scoreOrigin": "institutional_rubric",
            "ruleVersion": "release-audit-v1",
        } for candidate, values in {
            "metformin": {"effectiveness": 8, "safety": 7},
            "glipizide": {"effectiveness": 6, "safety": 5},
        }.items() for domain, score in values.items()],
    },
}


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_tool_audit_server", MCP_ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_execution_evidence():
    spec = importlib.util.spec_from_file_location(
        "evimed_tool_audit_execution_evidence",
        MCP_ROOT / "execution_evidence.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_receipts(workspace: Path, artifacts) -> list[dict]:
    receipts = []
    root = workspace.resolve()
    for artifact in artifacts or []:
        relative = artifact.get("path") if isinstance(artifact, dict) else artifact
        if not isinstance(relative, str) or not relative or os.path.isabs(relative):
            raise ValueError("artifact path is not workspace-relative")
        candidate = (root / relative).resolve()
        candidate.relative_to(root)
        if not candidate.is_file() or candidate.is_symlink() or candidate.stat().st_size <= 0:
            raise ValueError("artifact is missing or empty: %s" % relative)
        receipts.append({
            "kind": artifact.get("kind", candidate.suffix.lstrip(".") or "file") if isinstance(artifact, dict) else candidate.suffix.lstrip(".") or "file",
            "path": relative,
            "bytes": candidate.stat().st_size,
            "sha256": sha256(candidate),
        })
    return receipts


def workspace_roots(explicit, probe_workspace=None) -> list[Path]:
    """Where to look for completed specialist jobs.

    The probe workspace is always one of them. `run_specialist_jobs.py` starts
    the managed jobs there, and leaving it out meant a sweep that had just run
    all six of them reported `specialistReceipts: 0` -- which reads exactly
    like six specialists that failed, and is instead one missing flag.
    """
    roots = [probe_workspace.resolve()] if probe_workspace else []
    if explicit:
        return sorted(set(roots + [Path(value).resolve() for value in explicit]))
    for workspace_candidate in sorted((REPO / ".openscience-web-data" / "users").glob("*/projects/*/workspace")):
        if workspace_candidate.is_symlink() or not workspace_candidate.is_dir():
            continue
        workspace = workspace_candidate.resolve()
        roots.append(workspace)
        project_path = workspace.parent / "project.json"
        try:
            if project_path.is_symlink() or project_path.stat().st_size > 64 * 1024:
                continue
            project = json.loads(project_path.read_text(encoding="utf-8"))
            active_name = project.get("activeWorkspace")
            if not isinstance(active_name, str) or not active_name.strip():
                continue
            active_candidate = workspace / active_name
            if active_candidate.is_symlink():
                continue
            active = active_candidate.resolve()
            active.relative_to(workspace)
            if active.is_dir():
                roots.append(active)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return sorted(set(roots))


def latest_specialist_receipt(tool, roots, max_age_days):
    directory, prefix = SPECIALISTS[tool]
    candidates = []
    for workspace in roots:
        for state_path in workspace.glob("%s/.jobs/%s*.json" % (directory, prefix)):
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                if state.get("status") not in {"succeeded", "blocked"}:
                    continue
                root_value = state.get("metaRoot") if tool == "meta_analysis" else state.get("root")
                # Job state records the absolute path of the host that ran it,
                # so rebase onto the layout every host shares before hashing.
                name = Path(str(root_value or "").replace("\\", "/")).name
                root = (SPECIALIST_SOURCES / name).resolve(strict=True)
                adapter = MCP_ROOT / ("meta_agent.py" if tool == "meta_analysis" else "specialist_jobs.py")
                expected_evidence = load_execution_evidence().execution_evidence(root, adapter)
                if state.get("executionEvidence") != expected_evidence:
                    continue
                executed_at = datetime.fromisoformat(str(state["updatedAt"]).replace("Z", "+00:00"))
                receipts = artifact_receipts(workspace, state.get("artifacts"))
                if not receipts:
                    continue
                age_days = (datetime.now(timezone.utc) - executed_at).total_seconds() / 86400
                if age_days > max_age_days:
                    continue
                candidates.append((executed_at, state, receipts, workspace))
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                continue
    if not candidates:
        return None
    executed_at, state, receipts, workspace = max(candidates, key=lambda item: item[0])
    job_status = state.get("status")
    release_status = state.get("releaseStatus")
    publication_ready = job_status == "succeeded" and release_status in {None, "ready"}
    return {
        "tool": tool,
        "probeType": "completed_managed_job",
        "operation": "start_then_poll_to_terminal",
        "status": "success" if publication_ready else "warning",
        "operational": True,
        "summary": (
            "A managed specialist task completed and produced verified non-empty artifacts."
            if publication_ready
            else "A managed specialist task completed, produced verified non-empty diagnostic artifacts, and was blocked by its release gate."
        ),
        "jobId": state.get("jobId"),
        "jobStatus": job_status,
        "releaseStatus": release_status,
        "publicationReady": publication_ready,
        "executedAt": executed_at.isoformat().replace("+00:00", "Z"),
        "workspace": workspace.relative_to(REPO).as_posix(),
        "executionEvidence": state.get("executionEvidence"),
        "artifacts": receipts,
        "artifactCount": len(receipts),
    }


def snapshot_evidence(results, evidence_root: Path) -> None:
    """Mirror every receipted file into the repository beside the probe document.

    Receipts point into a live server workspace under .openscience-web-data,
    which .gitignore keeps out of the repository, so verification would only be
    possible on the host that ran the audit. Copy the receipted files and job
    state here, workspace-relative, and the release gate becomes reproducible
    from a clean clone.
    """
    # Build beside the live directory and swap at the end. Clearing first means
    # a run that certifies less than the last one — a specialist whose job did
    # not start, an upstream that was down — deletes evidence it cannot replace,
    # and the loss is silent because the document it writes looks complete.
    staging_root = evidence_root.with_name(evidence_root.name + ".staging")
    if staging_root.exists():
        shutil.rmtree(staging_root)
    job_state_root = staging_root / "job-state"
    job_state_root.mkdir(parents=True, exist_ok=True)
    for item in results:
        workspace = REPO / str(item.get("workspace", ""))
        receipts = list(item.get("artifacts") or [])
        response = item.get("responseReceipt")
        if isinstance(response, dict) and response.get("path"):
            receipts.append(response)
        for receipt in receipts:
            source = (workspace / str(receipt["path"])).resolve()
            source.relative_to(workspace.resolve())
            target = staging_root / str(receipt["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        job_id = item.get("jobId")
        if not job_id:
            continue
        directory = SPECIALISTS[item["tool"]][0]
        shutil.copyfile(
            workspace / directory / ".jobs" / ("%s.json" % job_id),
            job_state_root / ("%s.json" % job_id),
        )
    # Everything copied, so the swap is safe.
    if evidence_root.exists():
        shutil.rmtree(evidence_root)
    staging_root.rename(evidence_root)


def run_task_probes(server, workspace):
    results = []
    response_root = workspace / ".evimed-audit" / "tool-responses"
    response_root.mkdir(parents=True, exist_ok=True)
    for tool, arguments in TASK_FIXTURES.items():
        started = time.monotonic()
        result = server.call_tool(tool, arguments)
        elapsed = round((time.monotonic() - started) * 1000)
        response_path = response_root / (tool + ".json")
        response_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        response_receipt = artifact_receipts(
            workspace,
            [response_path.relative_to(workspace).as_posix()],
        )[0]
        artifacts = []
        artifact_error = None
        try:
            artifacts = artifact_receipts(workspace, result.get("artifacts"))
        except ValueError as error:
            artifact_error = str(error)
        operational = result.get("status") in {"success", "warning"} and artifact_error is None
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        audit = data.get("audit") if isinstance(data.get("audit"), dict) else {}
        results.append({
            "tool": tool,
            "probeType": "executed_tool_call",
            "operation": "task",
            "status": result.get("status", "error"),
            "operational": operational,
            "summary": result.get("summary", ""),
            "errorCode": (result.get("error") or {}).get("code") if isinstance(result.get("error"), dict) else None,
            "elapsedMs": elapsed,
            "sourceCount": len(result.get("sources") or []),
            "workspace": workspace.relative_to(REPO).as_posix(),
            "responseReceipt": response_receipt,
            "artifacts": artifacts,
            "artifactError": artifact_error,
            "assessmentType": data.get("assessmentType"),
            "automaticDecision": audit.get("automaticDecision"),
            "humanReviewRequired": audit.get("humanReviewRequired"),
        })
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe-workspace", type=Path, required=True)
    parser.add_argument("--receipt-workspace", action="append", default=[])
    parser.add_argument("--max-receipt-age-days", type=float, default=14)
    parser.add_argument("--output-dir", type=Path, default=RESULTS)
    args = parser.parse_args()
    workspace = args.probe_workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(workspace)
    server = load_server()
    declared = [item["name"] for item in server.list_tools()]
    # A tool the deployment switched off is not a tool that departed. Both leave
    # the registry, and telling them apart is the difference between "the
    # fixtures are stale" and "this deployment does not do patents" -- one is a
    # bug in the audit, the other is a decision the audit should record and
    # carry on.
    disabled = server.disabled_tools()
    fixtured = (set(TASK_FIXTURES) | set(SPECIALISTS)) - disabled
    unaudited = sorted(set(declared) - fixtured)
    departed = sorted(fixtured - set(declared))
    if unaudited or departed:
        # Name them. "does not exactly cover" sent a reader looking for a
        # mismatch without saying which side, and `ci:web` reported the whole
        # thing as `tool audit evidence is stale` -- so a registry that had
        # gained a tool the audit had never probed read exactly like evidence
        # that was merely old. It stayed that way for twelve days.
        parts = []
        if unaudited:
            parts.append("declared but never probed: " + ", ".join(unaudited))
        if departed:
            parts.append("fixtured but no longer declared: " + ", ".join(departed))
        raise SystemExit("tool audit fixtures do not cover the MCP registry -- " + "; ".join(parts))
    if disabled:
        print("deliberately not offered by this deployment: " + ", ".join(sorted(disabled)))
    roots = workspace_roots(args.receipt_workspace, probe_workspace=workspace)
    results = run_task_probes(server, workspace)
    for tool in SPECIALISTS:
        receipt = latest_specialist_receipt(tool, roots, args.max_receipt_age_days)
        results.append(receipt or {
            "tool": tool,
            "probeType": "no_completed_job_receipt",
            "operation": "none",
            "status": "unverified",
            "operational": False,
            "summary": "No fresh terminal managed job with verified artifacts was found.",
            "artifacts": [],
            "artifactCount": 0,
        })
    by_tool = {item["tool"]: item for item in results}
    ordered = [by_tool[name] for name in declared]
    certified = sum(bool(item["operational"]) for item in ordered)
    document = {
        "schemaVersion": 3,
        "probedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "registered": len(declared),
        # Recorded in the document, not only printed. "25 of 25 certified" and
        # "25 of 26, one switched off" are different claims, and a denominator
        # that quietly shrank is the way the second becomes the first.
        "notOffered": sorted(disabled),
        "executionCertified": certified,
        "unverified": len(declared) - certified,
        "operational": certified,
        "errors": sum(item["status"] == "error" for item in ordered),
        "criteria": {
            "ordinaryTool": "A real task call must return success or warning and all declared artifacts must exist and be non-empty.",
            "specialistTool": "A capabilities response never qualifies; a fresh terminal managed job and hashed non-empty artifacts are required. Operational execution and publication readiness are reported separately.",
        },
        "results": ordered,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    complete = certified == len(declared)
    # A partial run publishes a document and an evidence tree that look whole
    # while covering less than the last one. Report it and leave the recorded
    # evidence alone rather than replacing certification with its absence.
    if complete:
        snapshot_evidence(ordered, args.output_dir / "evidence")
        payload = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        for filename in ("tool-probe-v2.json", "tool-probe-v3.json"):
            (args.output_dir / filename).write_text(payload, encoding="utf-8")
    else:
        uncertified = [item["tool"] for item in ordered if not item.get("operational")]
        print("not written: %d of %d tools uncertified (%s)" % (
            len(uncertified), len(declared), ", ".join(uncertified[:8])), file=sys.stderr)
    print(json.dumps({
        "registered": len(declared),
        "executionCertified": certified,
        "specialistReceipts": sum(item["probeType"] == "completed_managed_job" for item in ordered),
    }, ensure_ascii=False))
    raise SystemExit(0 if certified == len(declared) else 1)


if __name__ == "__main__":
    main()
