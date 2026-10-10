#!/usr/bin/env python3
"""Execute EviMed tools and certify specialist jobs from real artifacts."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import public_mr_fixture as public_mr
from audit_inventory import validate_disabled
from audit_identity import tool_source_identity
from hosted_receipts import (ReceiptError, RECEIPT_DIRECTORY, artifact_paths, canonical, file_receipt, read_owned, validate_receipt, write_new)


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
    # The official-page tool's probe until 2026-09-20, when it became
    # `web_read`: NICE answers a plain client with the guideline's own text.
    "web_read": {
        "url": "https://www.nice.org.uk/guidance/ng136",
    },
    "open_access_full_text": {"identifier": "PMC8010506"},
    # Added 2026-09-18 with the tool. It reads the capture the fixture above has
    # just preserved, by the id that tool reports, so it runs after it (this
    # dict's order is the probe order); the title line is in every rendering.
    "locate_quote": {
        "sourceId": "PMC8010506",
        "quote": "Review of deep learning: concepts, CNN architectures, challenges, applications, future directions",
    },
    # Added 2026-08-26. It had been in the registry, model-facing, and covered
    # by no fixture: the guard above reported that as "does not exactly cover"
    # and `ci:web` reported the whole audit as stale evidence, so a tool nobody
    # had ever probed read like evidence that was merely old.
    "web_search": {"query": "systematic review reporting guideline PRISMA 2020", "limit": 2},
    # Added 2026-09-20 with the tool. It asks the control plane about the
    # probe account's own knowledge base, which is empty here: the small-library
    # answer ("read these files", with none to read) is a real answer from the
    # real gateway and the only one that needs no corpus planted first.
    "kb_search": {"query": "阿司匹林 一级预防 剂量", "limit": 3},
    # Added 2026-09-22 with the tool, so the registry never again gains a
    # tool this audit refuses to start over. The widest question the feed
    # answers without a planted corpus: every item of the last thirty days, a
    # few of them. An empty feed is a warning, which still certifies the route;
    # a deployment that does not run 「前沿动态」 declares the tool not offered
    # (it is in `server.OPTIONAL_TOOLS`).
    "frontier_search": {"mode": "all", "limit": 3},
    # Added 2026-09-25 with 「循证 GEO」's tools. Neither changes anything: the
    # probe's project is not a GEO project, so both answer the warning
    # `geo_no_project` (the route and the token certified), and in a GEO
    # project the write is a platform step a run may not mark, refused item by
    # item. The social search is one small real crawl. A deployment that does
    # not run the module declares all three not offered (`OPTIONAL_TOOLS`).
    # The search asks one platform per call since 2026-09-25 (`platform`, not
    # `platforms`); the old shape was refused as invalid input before any crawl.
    "geo_read": {"what": "project"},
    "geo_write": {"what": "step", "data": {"step": "diagnosis", "status": "none"}},
    "social_posts_search": {"query": "降糖药", "platform": "xhs", "limit": 3},
    # Added 2026-09-29 with 「虚拟临床研究」's five tools. None changes anything: the
    # probe's project carries no study, so the three module tools answer the
    # warning `vcr_no_study` (the route and the token certified), the registry
    # record is one public read, and the evidence pool only asks after a job
    # that does not exist. A deployment that does not run the module declares
    # all five not offered (`OPTIONAL_TOOLS`).
    "vcr_read": {"what": "study"},
    "vcr_write": {"what": "step", "data": {"step": "definition", "status": "none"}},
    "vcr_simulate": {"action": "status", "jobId": "job_release_audit_probe"},
    "trial_registry_record": {"registryId": "NCT04280705"},
    # Added 2026-10-04: the digitizer's own refusal of a figure that is not there. The probe's
    # project carries no study, so the answer is the warning `vcr_no_study`: the route and the
    # token are certified and nothing is digitized or recorded.
    "curve_digitize": {"imageArtifactId": "release-audit-probe.png",
                       "calibration": {"x": {"min": 0, "max": 60, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}},
                       "arms": [{"riskTable": [{"time": 0, "atRisk": 100}, {"time": 60, "atRisk": 10}]}]},
    "evidence_pool": {"action": "status", "jobId": "job_release_audit_probe"},
    # This route probe reads an existing owned job. Engine qualification is
    # separately proved by completed numerical receipts, and an absent job must
    # not masquerade as a successful calculation. A calculation starts only from
    # a pending native tool call in a live conversation (the gateway checks the
    # kernel's transcript for it), so a probe outside one cannot start any: the
    # job is a calculation the probe project already owns, named by
    # `EVIMED_RESULT_REPLAY_AUDIT_JOB_ID` (replay_<64 hex>, from the result's own
    # status). Without one the probe says so (`run_task_probes`) instead of asking
    # the gateway about an id nobody holds.
    "research_calculate": {"action": "status", "jobId": os.environ.get(
        "EVIMED_RESULT_REPLAY_AUDIT_JOB_ID", "replay_" + "0" * 64)},
    # Added 2026-10-04 with the tool (N03). A read changes nothing: with the module off it answers the warning
    # `semantics_disabled`, with no recorded dataset it answers an empty list, and either certifies the route
    # and the token.
    "dataset_semantics": {"action": "read"},
    # Non-mutating refusal probes. The past date cannot create a scheduled task,
    # and the fixture id cannot name a generated agenda. Successful task creation
    # and edits are exercised in evals/task-conversation against real DSH instead.
    "schedule_task": {"instruction": "Release audit: do not create a task.",
                      "schedule": {"kind": "once", "date": "2000-01-01", "time": "00:00", "timeZone": "UTC"}},
    "update_task": {"taskId": "agenda-release-audit-probe", "paused": True},
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
    # Added 2026-09-28: the tool had been declared and model-facing since it
    # shipped with no fixture, so the probe refused to start at all. A PMID of
    # a paper with a long reference list, read through Europe PMC's citation
    # network -- the same record the tool's own unit test is written around.
    "reference_list": {"identifier": "30153985", "limit": 5},
    # Added 2026-10-04 with the three N04 operations, so the registry never again
    # gains a tool this audit refuses to start over. Each asks the question that
    # exercises the whole path the tool exists for: three identifier types resolved
    # to one another (one request per type, plus PubMed's confirmation); a trial
    # with posted results read, preserved and aligned (`compareTo: none`, because a
    # first read has nothing held to compare with); and a US label read at its
    # current version and compared with an older one, which is the zip download
    # the buffered gateway fetch cannot do. The Tagrisso set id is a major
    # label that has had 37 versions; version 36 is not going away.
    "identifier_resolve": {"identifiers": ["30221596", "PMC6143516", "10.1056/NEJMoa1800722"]},
    "clinical_trial_snapshot": {"nctId": "NCT02197234", "compareTo": "none"},
    "dailymed_label": {"setid": "5e81b4a7-b971-45e1-9c31-29cea8c87ce7", "compareVersion": 36},
    # Added 2026-10-04 with the NCBI Gene Expression Omnibus workflow (N17). The series is a classic three-against-three
    # microarray (GSE5583, 217 KB; its GPL81 record is 22 MB), so the probe exercises the whole path: both named downloads
    # through the gateway, the identity checks and the content-addressed capture. The computation probe runs on the capture
    # the series probe just made (its `captureDir` is a content hash, so it cannot be written here: `run_task_probes` puts the
    # real one in), compares the two genotypes, and writes its files under a directory of its own.
    "gene_expression_series": {"accession": "GSE5583"},
    "gene_expression_differential": {
        "captureDir": ".evimed-sources/gene-expression/GSE5583-GPL81/replaced-by-the-series-probe",
        "outputDir": "deliverables/release-audit-gene-expression",
        "groups": [{"label": "wild type", "samples": ["GSM130365", "GSM130366", "GSM130367"]},
                   {"label": "HDAC1 knock out", "samples": ["GSM130368", "GSM130369", "GSM130370"]}],
        "topN": 5,
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


def latest_hosted_receipt(tool, roots, max_age_days):
    candidates = []
    for workspace in roots:
        for path in workspace.glob(RECEIPT_DIRECTORY + "/*.json"):
            try:
                relative = path.relative_to(workspace).as_posix()
                value = json.loads(read_owned(workspace, relative, 1024 * 1024))
                proof = validate_receipt(value, workspace, tool, max_age_days)
                ready = proof["jobStatus"] == "succeeded" and proof.get("releaseStatus") in {None, "ready"}
                candidates.append({"tool": tool, "probeType": "completed_managed_job",
                    "receiptKind": "worker-adapter-v2" if proof["schemaVersion"] == 2 else "isolated-adapter-v1",
                    "operation": "start_then_poll_to_terminal", "status": "success" if ready else "warning", "operational": True,
                    "summary": "A managed adapter completed with matching source and retained input/artifact observations.",
                    "jobId": proof["jobId"], "jobStatus": proof["jobStatus"], "releaseStatus": proof.get("releaseStatus"),
                    "publicationReady": ready, "executedAt": proof["completedAt"],
                    "workspace": workspace.relative_to(REPO).as_posix(), "executionEvidence": proof["executionEvidence"],
                    "hostedReceipt": file_receipt(workspace, relative), "inputReceipts": proof["inputs"],
                    "fixtureReceipts": public_mr.fixture_file_receipts(public_mr.load_manifest()) if tool == "mendelian_randomization" else [],
                    "artifacts": proof["artifacts"], "artifactCount": len(proof["artifacts"]), "scope": proof["scope"]})
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                continue
    return max(candidates, key=lambda row: row["executedAt"]) if candidates else None


def latest_specialist_receipt(tool, roots, max_age_days):
    hosted = latest_hosted_receipt(tool, roots, max_age_days)
    # Current public-MR certification must exercise uploaded inputs through the
    # isolated adapter; a legacy remote-text .jobs file cannot certify that path.
    if hosted is not None or tool == "mendelian_randomization":
        return hosted
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
                if max_age_days is not None and age_days > max_age_days:
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
    if evidence_root.exists():
        raise ReceiptError("audit_snapshot_exists_use_new_output_directory")
    evidence_root.parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(prefix=evidence_root.name + ".staging-", dir=evidence_root.parent))
    job_state_root = staging_root / "job-state"
    job_state_root.mkdir(parents=True, exist_ok=True)
    for item in results:
        workspace = REPO / str(item.get("workspace", ""))
        receipts = list(item.get("artifacts") or []) + list(item.get("inputReceipts") or []) + list(item.get("fixtureReceipts") or [])
        if item.get("hostedReceipt"):
            receipts.append(item["hostedReceipt"])
        response = item.get("responseReceipt")
        if isinstance(response, dict) and response.get("path"):
            receipts.append(response)
        for receipt in receipts:
            relative = str(receipt["path"])
            if file_receipt(workspace, relative) != {key: receipt[key] for key in ("path", "bytes", "sha256")}:
                raise ReceiptError("audit_snapshot_artifact_changed")
            target = staging_root / relative
            blob = read_owned(workspace, relative)
            if target.exists():
                if read_owned(staging_root, relative) != blob:
                    raise ReceiptError("audit_snapshot_path_collision")
            else:
                write_new(staging_root, relative, blob)
        job_id = item.get("jobId")
        if not job_id or item.get("receiptKind") in {"isolated-adapter-v1", "worker-adapter-v2"}:
            continue
        directory = SPECIALISTS[item["tool"]][0]
        state = json.loads(read_owned(workspace, directory + "/.jobs/" + job_id + ".json"))
        declared = artifact_paths(state.get("artifacts"))
        if declared != artifact_paths(item.get("artifacts")):
            raise ReceiptError("audit_snapshot_legacy_artifact_binding_changed")
        public_state = {key: state.get(key) for key in ("jobId", "status", "releaseStatus", "executionEvidence", "updatedAt")}
        public_state["artifacts"] = declared
        for key in ("root", "metaRoot"):
            if state.get(key):
                public_state[key] = Path(str(state[key]).replace("\\", "/")).name
        write_new(staging_root, "job-state/" + job_id + ".json", canonical(public_state) + b"\n")
    # Everything copied, so the swap is safe.
    staging_root.rename(evidence_root)


def owned_job_id(arguments):
    """The calculation job id a research_calculate probe was given, or None when it holds none.

    The all-zero id is the placeholder the fixture carries when the operator named
    no job; it is not a job anyone owns, and asking the gateway about it can only
    answer "unknown", which says nothing about the tool.
    """
    job_id = str(arguments.get("jobId", ""))
    return job_id if re.fullmatch(r"replay_[a-f0-9]{64}", job_id) and set(job_id[len("replay_"):]) != {"0"} else None


def captured_series_directory(response_root):
    """The capture directory the gene_expression_series probe wrote, or None when it preserved nothing."""
    try:
        data = json.loads((response_root / "gene_expression_series.json").read_text(encoding="utf-8")).get("data")
    except (OSError, ValueError):
        return None
    directory = data.get("captureDir") if isinstance(data, dict) else None
    return directory if isinstance(directory, str) and directory else None


def owned_task_probes(server, response_root):
    """Exercise one future task in an explicitly selected audit project and pause it immediately.

    Refusal fixtures prove input validation, not successful scheduling. The
    opt-in lifecycle retains both replies, including a failed first pause even
    if the cleanup retry succeeds. Never ask about an invented task id.
    """
    future = datetime.now(timezone.utc) + timedelta(days=7)
    arguments = {"title": "Release audit task",
                 "instruction": "Release audit fixture: summarize evidence availability.",
                 "schedule": {"kind": "once", "date": future.strftime("%Y-%m-%d"),
                              "time": "00:00", "timeZone": "UTC"}}
    started = time.monotonic()
    scheduled = server.call_tool("schedule_task", arguments)
    scheduled_ms = round((time.monotonic() - started) * 1000)
    data = scheduled.get("data") if isinstance(scheduled.get("data"), dict) else {}
    task_id = data.get("taskId")
    update = {"status": "error", "summary": "The scheduling probe did not return an owned task to pause.",
              "error": {"code": "audit_task_not_created"}}
    attempts = []
    started = time.monotonic()
    if scheduled.get("status") == "success" and isinstance(task_id, str) and re.fullmatch(r"agenda-[A-Za-z0-9-]{1,160}", task_id):
        def pause():
            try:
                return server.call_tool("update_task", {"taskId": task_id, "paused": True})
            except Exception as error:
                return {"status": "error", "summary": "The task pause raised %s." % type(error).__name__,
                        "error": {"code": "audit_task_pause_failed"}}
        update = pause()
        attempts.append(update)
        updated = update.get("data") if isinstance(update.get("data"), dict) else {}
        if update.get("status") != "success" or updated.get("taskId") != task_id or updated.get("state") != "paused":
            # Preserve the original failure; retry only to avoid leaving the
            # audit's own future task enabled, never to certify a failed probe.
            attempts.append(pause())
            update = {**update, "status": "error", "summary": "The owned task did not confirm its paused state.",
                      "error": {"code": "audit_task_pause_unconfirmed"}}
    update_ms = round((time.monotonic() - started) * 1000)
    (response_root / "task-lifecycle.json").write_text(json.dumps({
        "arguments": arguments, "schedule": scheduled, "pauseAttempts": attempts,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"schedule_task": (scheduled, scheduled_ms), "update_task": (update, update_ms)}


def run_task_probes(server, workspace, *, exercise_owned_tasks=False):
    results = []
    response_root = workspace / ".evimed-audit" / "tool-responses"
    response_root.mkdir(parents=True, exist_ok=True)
    disabled = server.disabled_tools()
    task_results = {}
    if exercise_owned_tasks:
        if not {"schedule_task", "update_task"} <= (set(TASK_FIXTURES) - disabled):
            raise ValueError("owned task probes require both scheduling tools to be offered")
        task_results = owned_task_probes(server, response_root)
    for tool, arguments in TASK_FIXTURES.items():
        if tool in disabled:
            continue
        if tool == "research_calculate" and owned_job_id(arguments) is None:
            results.append({
                "tool": tool, "probeType": "no_owned_calculation_job", "operation": "none", "status": "unverified",
                "operational": False, "artifacts": [], "artifactCount": 0,
                "summary": "research_calculate is probed on a calculation the probe project already owns, because a calculation "
                           "starts only from a native conversation turn. No job id was given: set "
                           "EVIMED_RESULT_REPLAY_AUDIT_JOB_ID to the id (replay_<64 hex>) of a completed calculation "
                           "in the probe project and run again.",
            })
            continue
        if tool == "gene_expression_differential":
            capture = captured_series_directory(response_root)
            if capture is None:
                results.append({
                    "tool": tool, "probeType": "no_series_capture", "operation": "none", "status": "unverified",
                    "operational": False, "artifacts": [], "artifactCount": 0,
                    "summary": "gene_expression_differential is probed on the capture gene_expression_series just made; "
                               "that probe did not preserve a series, so there is nothing to compute from.",
                })
                continue
            arguments = {**arguments, "captureDir": capture}
        started = time.monotonic()
        if tool in task_results:
            result, elapsed = task_results[tool]
        else:
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
    parser.add_argument("--max-receipt-age-days", type=float, default=None,
                        help="an operator's own bound on how old a harvested job may be; by default none: a receipt counts "
                             "for as long as the source it records is the source in this tree")
    parser.add_argument("--output-dir", type=Path, default=RESULTS)
    parser.add_argument("--exercise-owned-tasks", action="store_true",
                        help="in the selected audit project, create a task seven days ahead and immediately pause it; "
                             "without this flag scheduling probes only exercise refusal and do not certify successful writes")
    parser.add_argument(
        "--record-incomplete", action="store_true",
        help="write the document and its evidence to the new --output-dir even when some tools are uncertified",
    )
    args = parser.parse_args()
    if (args.output_dir / "tool-probe-v3.json").exists() or (args.output_dir / "evidence").exists():
        raise SystemExit("audit output already exists; use a new --output-dir to preserve prior evidence")
    workspace = args.probe_workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(workspace)
    server = load_server()
    registry = {item["name"] for item in server.TOOL_DEFINITIONS}
    disabled = validate_disabled(registry, set(server.OPTIONAL_TOOLS), server.disabled_tools())
    declared = [item["name"] for item in server.list_tools()]
    if len(declared) != len(set(declared)) or set(declared) != registry - disabled:
        raise SystemExit("offered tool list differs from registry minus explicit optional notOffered")
    # A tool the deployment switched off is not a tool that departed. Both leave
    # the registry, and telling them apart is the difference between "the
    # fixtures are stale" and "this deployment does not do patents" -- one is a
    # bug in the audit, the other is a decision the audit should record and
    # carry on.
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
    results = run_task_probes(server, workspace, exercise_owned_tasks=args.exercise_owned_tasks)
    for tool in SPECIALISTS:
        if tool in disabled:
            continue
        receipt = latest_specialist_receipt(tool, roots, args.max_receipt_age_days)
        results.append(receipt or {
            "tool": tool,
            "probeType": "no_completed_job_receipt",
            "operation": "none",
            "status": "unverified",
            "operational": False,
            "summary": "No terminal managed job with verified artifacts and a recorded source equal to this tree's was found.",
            "artifacts": [],
            "artifactCount": 0,
        })
    by_tool = {item["tool"]: item for item in results}
    ordered = [by_tool[name] for name in declared]
    certified = sum(bool(item["operational"]) for item in ordered)
    complete = certified == len(declared)
    uncertified = [item["tool"] for item in ordered if not item.get("operational")]
    document = {
        "schemaVersion": 3,
        "probedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "registered": len(declared),
        # Recorded in the document, not only printed. "25 of 25 certified" and
        # "25 of 26, one switched off" are different claims, and a denominator
        # that quietly shrank is the way the second becomes the first.
        "notOffered": sorted(disabled),
        "sourceRegistry": sorted(registry),
        # What this recording was taken on. The verifier computes the same two
        # digests from the tree it is asked about, and the recording is valid for
        # exactly as long as they are equal: age never expires it. Written here
        # and by nothing else, so an old recording without it reads as one whose
        # identity was not recorded, which is true.
        "sourceIdentity": tool_source_identity(),
        "toolAvailability": [{"tool": name, "state": "notOffered" if name in disabled else "offered", "basis": "explicit-deployment-disable" if name in disabled else "runtime-list-tools"} for name in sorted(registry)],
        "executionCertified": certified,
        "unverified": len(declared) - certified,
        "operational": certified,
        "errors": sum(item["status"] == "error" for item in ordered),
        "complete": complete,
        "criteria": {
            "ordinaryTool": "A real task call must return success or warning and all declared artifacts must exist and be non-empty.",
            "specialistTool": "A capabilities response never qualifies; a terminal managed job whose recorded source is this tree's, and hashed non-empty artifacts, are required. Operational execution and publication readiness are reported separately.",
        },
        "results": ordered,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    # A partial run publishes a document and an evidence tree that look whole
    # while covering less than the last one. Report it and leave the recorded
    # evidence alone rather than replacing certification with its absence.
    #
    # `--record-incomplete` is the one exception, for when the last complete
    # recording has itself expired: there is then no certification left to
    # protect, and the release gate refuses the expired document and a partial
    # one alike. What differs is what they say. The expired one describes a
    # deployment and a registry that no longer exist; a fresh partial one
    # records what the live deployment answered today and names every tool it
    # could not certify, and `complete: false` says so on its first screen.
    # The output directory must still be new, so the script overwrites nothing;
    # promoting the result over the previous recording is a separate step.
    if complete or args.record_incomplete:
        snapshot_evidence(ordered, args.output_dir / "evidence")
        payload = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        for filename in ("tool-probe-v2.json", "tool-probe-v3.json"):
            (args.output_dir / filename).write_text(payload, encoding="utf-8")
        if not complete:
            print("recorded incomplete: %d of %d tools uncertified (%s); the release gate refuses this document "
                  "until every one is certified" % (len(uncertified), len(declared), ", ".join(uncertified)),
                  file=sys.stderr)
    else:
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
