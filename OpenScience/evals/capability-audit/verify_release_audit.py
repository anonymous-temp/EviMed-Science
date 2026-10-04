#!/usr/bin/env python3
"""Fail the release when capability counts exceed their machine evidence."""

from __future__ import annotations

import argparse
import hashlib
import sys
import importlib.util
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import audit_identity
from hosted_receipts import ReceiptError, read_owned, file_receipt, validate_receipt, artifact_paths
import public_mr_fixture as public_mr
import verify_acceptance_ledger as acceptance_ledger
from audit_inventory import skill_composition, skill_execution_coverage, skill_evidence_metadata


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / "results"
REPORTS = RESULTS
# Probe receipts point at files the audit run produced inside a live server
# workspace, which .gitignore keeps out of the repository. The generator mirrors
# them here, workspace-relative, so a clean clone can verify the same evidence.
EVIDENCE = RESULTS / "evidence"
JOB_STATE = EVIDENCE / "job-state"
SPECIALIST_SOURCES = REPO.parent / "项目代码"


def read(name):
    file = REPORTS / name
    if name != "skill-audit-v5.json" and not file.is_file():
        file = RESULTS / name
    return json.loads(file.read_text(encoding="utf-8"))


def require(condition, message):
    if not condition:
        raise SystemExit(message)


# An operator's own bound on the age of evidence, off by default. Evidence is valid for as long as the
# source it was taken on is the source in this tree (owner ruling, 2026-10-04), and a number of days
# says nothing about that: the old fourteen-day window turned this audit red on every machine two weeks
# after each probe although nothing had changed. `--max-evidence-age-days` is for the operator who wants
# a calendar bound as well.
OPERATOR_MAX_AGE_DAYS = None


def observed_time(value, label, max_age_days=None):
    """When a piece of evidence says it was taken. A time from the future is no evidence; age alone never is."""
    try:
        observed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise SystemExit("%s timestamp is invalid" % label)
    now = datetime.now(timezone.utc)
    require(observed <= now + timedelta(minutes=5), "%s timestamp is in the future" % label)
    limit = max_age_days if max_age_days is not None else OPERATOR_MAX_AGE_DAYS
    if limit is not None:
        require(observed >= now - timedelta(days=limit),
                "%s evidence was taken %d days ago, past the operator's bound of %s days" % (label, (now - observed).days, limit))
    return observed


def load_module(name, module_file):
    spec = importlib.util.spec_from_file_location(name, module_file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def specialist_source_root(recorded, tool):
    """Rebase a recorded specialist root onto this checkout.

    Job state stores the absolute path of the host that ran the job, so hashing
    that path verifies nothing on any other machine. `<workspace>/项目代码/<agent>`
    is the layout every host shares, so verify the source this checkout ships.
    """
    name = Path(str(recorded or "").replace("\\", "/")).name
    require(name, "%s job did not record a specialist source root" % tool)
    root = SPECIALIST_SOURCES / name
    require(root.is_dir(), "%s specialist source %s is unavailable" % (tool, name))
    return root


def tool_probe_currency(document, registry, not_offered):
    """Say whether the probe still describes this tree and, when it does not, what moved and what refreshes it.

    A probe is valid for as long as what it certifies is unchanged: the tool
    registry it covers (names, offered and not offered) and the identity of the
    source it was taken on (`audit_identity.tool_source_identity`, recorded by
    the runner in the document). Its age is not a reason: the old fourteen-day
    window turned this red on every machine two weeks after each recording.

    "tool audit evidence is stale" was once the whole message, and it was the
    first thing this function checked, so it was also the only thing anyone
    learned: the run died before loading the registry and therefore before it
    could notice that the probe covers 25 tools while the registry declares 34.
    Every reason is computed before any is raised, and each names what changed.
    Nothing is widened and no file is touched: a probe records what a live
    deployment answered, and there is no way to make it current except to ask a
    live deployment again. A gate the run can talk its way past is not a gate.
    """
    declared = registry - not_offered
    expected = len(declared)
    recorded = document.get("registered")
    probed = {str(item.get("tool")) for item in document.get("results", []) if item.get("tool")}
    reasons = []
    # The 2026-07-31 probe records every tool as `evimed_<base>`, a spelling the
    # server retired. Reported as its own fact: without it the name diff below
    # reads as "59 tools unprobed", which sends the reader looking for 59
    # missing probes instead of for one rename.
    renamed = {name for name in probed if name.startswith("evimed_") and name[len("evimed_"):] in registry}
    if renamed:
        reasons.append("records %d tool(s) under the retired `evimed_` prefix (e.g. %s)" % (len(renamed), sorted(renamed)[0]))
        probed = {name[len("evimed_"):] if name in renamed else name for name in probed}
    uncovered = sorted(declared - probed)
    surplus = sorted(probed - declared)
    try:
        observed_time(document.get("probedAt"), "tool audit")
    except SystemExit as error:
        reasons.append(str(error))
    if recorded != expected or uncovered or surplus:
        reasons.append(
            "covers %s tool(s); the registry declares %d (%d offered, %d not offered)%s%s"
            % (recorded, len(registry), expected, len(not_offered),
               (" - never probed: %s" % ", ".join(uncovered)) if uncovered else "",
               (" - probed but no longer declared: %s" % ", ".join(surplus)) if surplus else "")
        )
    identity = document.get("sourceIdentity")
    if identity is None:
        reasons.append(
            "does not record the identity of the source it was taken on (no sourceIdentity: it predates the field, "
            "which only the runner writes) - identity not recorded, re-probe"
        )
    else:
        moved = audit_identity.identity_changes(identity, audit_identity.tool_source_identity(REPO))
        if moved:
            reasons.append("was taken on other source than this tree's: %s changed since" % "; ".join(moved))
    if not reasons:
        return
    raise SystemExit(
        "tool audit evidence does not cover the current source: %s.\n"
        "  evidence: %s\n"
        "  refresh:  run evals/capability-audit/run_tool_audit.py --probe-workspace <ws> against a running deployment,\n"
        "            then commit the regenerated results/tool-probe-v3.json.\n"
        "  note:     the probe stays valid for as long as the tool registry and the source it was taken on are unchanged;\n"
        "            its age alone never expires it. Nothing here can be repaired by editing the file. The probe is a\n"
        "            record of what a live deployment answered; with no deployment reachable this check stays red when\n"
        "            the source has moved, and that is the correct reading of the evidence."
        % ("; ".join(reasons), (RESULTS / "tool-probe-v3.json").relative_to(REPO))
    )


def uncertified_tools(document):
    """Name every tool the probe could not certify, and what it said.

    "all 40 tools are not execution-certified" was the whole message, which
    sends the reader into the document to find out which ones and why. The
    probe already records both on each row; this only reads them out. It does
    not decide anything: the counts below are still what refuses.
    """
    rows = [item for item in document.get("results", []) if item.get("operational") is not True]
    return "; ".join(
        "%s (%s: %s)" % (item.get("tool"), item.get("probeType") or item.get("status"),
                         str(item.get("errorCode") or item.get("summary") or "no reason recorded")[:200])
        for item in rows
    )


#: What a receipt's moved source field means to a reader. The fields are those of `hosted_receipts.source_changes`.
RECEIPT_SOURCE_WORDS = {
    "executionEvidence.agentSourceSha256": "the specialist engine's source tree",
    "executionEvidence.agentSourceFiles": "the number of files in the specialist engine's source tree",
    "executionEvidence.adapterSha256": "the adapter's service.py",
    "executionEvidence.evidenceModuleSha256": "the adapter's audit_receipt.py",
    "adapterEvidence.sha256": "the adapter package and its deployment inputs",
    "adapterEvidence.files": "the number of files in the adapter package",
    "evidenceNote": "the producer's own note that its evidence was not taken cleanly",
}


def receipt_proof(value, tool):
    """A retained specialist receipt's proof, or an exit that says which identity moved and what refreshes it.

    The receipt carries the digests of the engine tree and the adapter it ran on,
    and `hosted_receipts.current_evidence` computes the same from this checkout by
    calling the adapter's own function, so it counts for as long as they are
    equal. `hosted_receipt_source_changed` alone sent the reader to diff two JSON
    documents to learn whether the engine, the adapter or the note had changed.
    """
    try:
        return validate_receipt(value, EVIDENCE, tool, OPERATOR_MAX_AGE_DAYS)
    except ReceiptError as error:
        code, _, detail = str(error).partition(":")
        if code != "hosted_receipt_source_changed":
            raise
        moved = [RECEIPT_SOURCE_WORDS.get(name, name) for name in detail.split(",") if name]
        raise SystemExit(
            "%s job receipt was recorded on other source than this tree's: %s changed since.\n"
            "  refresh: run the specialist again (evals/capability-audit/run_specialist_jobs.py --tool %s), then\n"
            "           run_tool_audit.py to record the new receipt; the receipt's age is not the reason." % (tool, "; ".join(moved) or "its source", tool)
        ) from None


def verify_tools():
    document = read("tool-probe-v3.json")
    require(document.get("schemaVersion") == 3, "tool audit schema is stale")
    # Derived from the live registry, never written down.
    #
    # Four checks said 25 while the registry had grown to 26 and the probe's own
    # fixtures covered all 26 — so a perfect, freshly certified run still failed,
    # with "tool registry count is not 25". A number in one file and a registry
    # in another drift the moment a tool is added, and the failure names the
    # count rather than the addition. The connector audit below already derives
    # its expected count for exactly this reason.
    server = load_module("evimed_release_tool_registry", REPO / "runtime" / "mcp" / "evimed-research" / "server.py")
    registry = {item["name"] for item in server.TOOL_DEFINITIONS}
    require(len(registry) > 0, "the MCP registry declares no tools")
    # A deployment may decline to offer a capability, and the probe records
    # which -- but `notOffered` is a denominator, so it is checked twice: every
    # name must be a tool that exists, and the set must be one the product
    # declares optional. Otherwise the way to a green audit is to switch off
    # whatever failed, and the document would still read "all certified".
    # `list_tools()` is not used here: it reads the same environment variable,
    # so on a machine that happens to set it the expected count would move with
    # the recording instead of pinning it.
    not_offered = document.get("notOffered", [])
    require(
        isinstance(not_offered, list) and all(isinstance(name, str) for name in not_offered),
        "tool audit notOffered is not a list of tool names",
    )
    require(len(not_offered) == len(set(not_offered)), "tool audit notOffered contains duplicate tool names")
    not_offered = set(not_offered)
    unknown = sorted(not_offered - registry)
    require(not unknown, "tool audit reports tools the registry does not declare as not offered: %s" % ", ".join(unknown))
    unapproved = sorted(not_offered - set(server.OPTIONAL_TOOLS))
    require(
        not unapproved,
        "tools this product does not declare optional were switched off: %s" % ", ".join(unapproved),
    )
    if "sourceRegistry" in document:
        require(document["sourceRegistry"] == sorted(registry), "recorded source tool names do not match the registry")
        expected_availability = [{"tool": name, "state": "notOffered" if name in not_offered else "offered", "basis": "explicit-deployment-disable" if name in not_offered else "runtime-list-tools"} for name in sorted(registry)]
        require(document.get("toolAvailability") == expected_availability, "tool availability is not registry minus explicit optional notOffered")
    expected = len(registry - not_offered)
    # Currency is judged here rather than at the top of the function, because
    # the useful message needs the registry this line has just finished reading.
    tool_probe_currency(document, registry, not_offered)
    require(document.get("registered") == expected, "tool registry count is not %d" % expected)
    require(
        document.get("executionCertified") == expected,
        "%s of %d tools are execution-certified; not certified: %s"
        % (document.get("executionCertified"), expected, uncertified_tools(document) or "none named in the results"),
    )
    require(document.get("operational") == expected, "tool operational count is not %d" % expected)
    require(document.get("unverified") == 0 and document.get("errors") == 0, "tool audit contains unverified or errored tools")
    results = document.get("results", [])
    require(len(results) == expected, "tool audit does not contain %d results" % expected)
    execution_evidence = load_module(
        "evimed_release_execution_evidence",
        REPO / "runtime" / "mcp" / "evimed-research" / "execution_evidence.py",
    )
    declared = registry - not_offered
    require({item.get("tool") for item in results} == declared, "tool evidence does not exactly match the live MCP registry")
    certified = [item for item in results if item.get("operational") is True]
    require(document.get("executionCertified") == len(certified), "tool execution-certified count is inflated")
    for item in results:
        require(item.get("operation") != "capabilities", "%s was certified by capabilities only" % item.get("tool"))
        if item.get("tool") in {
            "meta_analysis", "mendelian_randomization", "bibliometric_analysis",
            "research_topic_selection", "peer_review", "drug_safety_analysis",
        }:
            require(item.get("probeType") == "completed_managed_job", "%s lacks a completed job receipt" % item.get("tool"))
            require(item.get("operation") == "start_then_poll_to_terminal", "%s did not execute a managed task" % item.get("tool"))
            require(isinstance(item.get("jobId"), str) and item.get("jobId"), "%s lacks a job id" % item.get("tool"))
            observed_time(item.get("executedAt"), "%s job" % item.get("tool"))
            require(item.get("artifactCount", 0) > 0, "%s lacks artifacts" % item.get("tool"))
            require(item.get("artifactCount") == len(item.get("artifacts", [])), "%s artifact count does not reconcile" % item.get("tool"))
            require(all(receipt.get("bytes", 0) > 0 and len(receipt.get("sha256", "")) == 64 for receipt in item.get("artifacts", [])), "%s has invalid artifact receipts" % item.get("tool"))
            require(EVIDENCE.is_dir(), "%s receipt evidence snapshot is unavailable" % item.get("tool"))
            if item.get("tool") == "mendelian_randomization":
                require(item.get("receiptKind") in {"isolated-adapter-v1", "worker-adapter-v2"}, "MR needs its retained public-fixture job record")
            if item.get("receiptKind") in {"isolated-adapter-v1", "worker-adapter-v2"}:
                retained = item.get("hostedReceipt") or {}
                require(file_receipt(EVIDENCE, retained.get("path")) == retained, "hosted receipt bytes changed")
                value = json.loads(read_owned(EVIDENCE, retained["path"], 1024 * 1024))
                proof = receipt_proof(value, item["tool"])
                require(item.get("jobId") == proof["jobId"] and item.get("jobStatus") == proof["jobStatus"], "hosted job identity changed")
                require(item.get("executionEvidence") == proof["executionEvidence"], "hosted source evidence changed")
                require(item.get("scope") == proof["scope"], "hosted scope changed")
                require(item.get("executedAt") == proof["completedAt"], "hosted completion time changed")
                require(item.get("releaseStatus") == proof.get("releaseStatus"), "hosted release status changed")
                if item["tool"] == "mendelian_randomization":
                    require(item.get("fixtureReceipts") == public_mr.fixture_file_receipts(public_mr.load_manifest()), "public fixture receipt bindings changed")
                require(item.get("artifacts") == proof["artifacts"] and item.get("inputReceipts") == proof["inputs"], "hosted file bindings changed")
                ready = proof["jobStatus"] == "succeeded" and proof.get("releaseStatus") in {None, "ready"}
                require(item.get("publicationReady") is ready and item.get("status") == ("success" if ready else "warning"), "hosted release outcome changed")
                continue
            state_file = JOB_STATE / ("%s.json" % item.get("jobId"))
            require(state_file.is_file() and not state_file.is_symlink(), "%s job state is unavailable" % item.get("tool"))
            state = json.loads(state_file.read_text(encoding="utf-8"))
            require(state.get("status") in {"succeeded", "blocked"}, "%s job is not terminal" % item.get("tool"))
            require(isinstance(state.get("artifacts"), list), "legacy job artifact declaration is missing")
            require(artifact_paths(state["artifacts"]) == artifact_paths(item.get("artifacts")), "legacy job artifact declarations do not match audit receipts")
            require(item.get("jobStatus") == state.get("status"), "%s job outcome is misstated" % item.get("tool"))
            require(item.get("releaseStatus") == state.get("releaseStatus"), "%s release status is misstated" % item.get("tool"))
            expected_ready = state.get("status") == "succeeded" and state.get("releaseStatus") in {None, "ready"}
            require(item.get("publicationReady") is expected_ready, "%s publication readiness is misstated" % item.get("tool"))
            require(item.get("status") == ("success" if expected_ready else "warning"), "%s audit status hides its release outcome" % item.get("tool"))
            root_value = state.get("metaRoot") if item.get("tool") == "meta_analysis" else state.get("root")
            adapter = REPO / "runtime" / "mcp" / "evimed-research" / ("meta_agent.py" if item.get("tool") == "meta_analysis" else "specialist_jobs.py")
            expected_evidence = execution_evidence.execution_evidence(specialist_source_root(root_value, item.get("tool")), adapter)
            require(state.get("executionEvidence") == expected_evidence, "%s job does not match current specialist source" % item.get("tool"))
            require(item.get("executionEvidence") == expected_evidence, "%s audit omitted current specialist source evidence" % item.get("tool"))
            for receipt in item["artifacts"]:
                artifact = (EVIDENCE / str(receipt.get("path", ""))).resolve()
                require(artifact.is_relative_to(EVIDENCE) and artifact.is_file() and not artifact.is_symlink(), "%s receipt artifact is unavailable" % item.get("tool"))
                require(artifact.stat().st_size == receipt["bytes"] and file_sha256(artifact) == receipt["sha256"], "%s artifact receipt no longer matches disk" % item.get("tool"))
        else:
            require(item.get("probeType") == "executed_tool_call" and item.get("operation") == "task", "%s lacks a real task call" % item.get("tool"))
            require(item.get("status") in {"success", "warning"}, "%s task call did not complete" % item.get("tool"))
            require(isinstance(item.get("elapsedMs"), int) and item.get("elapsedMs") >= 0, "%s lacks execution timing" % item.get("tool"))
            require(item.get("artifactError") is None, "%s has invalid task artifacts" % item.get("tool"))
            response = item.get("responseReceipt", {})
            response_file = (EVIDENCE / str(response.get("path", ""))).resolve()
            require(response_file.is_relative_to(EVIDENCE) and response_file.is_file() and not response_file.is_symlink(), "%s lacks a retained task response" % item.get("tool"))
            require(response_file.stat().st_size == response.get("bytes") and file_sha256(response_file) == response.get("sha256"), "%s retained task response no longer matches disk" % item.get("tool"))
            assessment_types = {
                "offlabel_evidence_packet": "off_label",
                "comprehensive_drug_evaluation": "comprehensive_drug_evaluation",
                "drug_selection_evaluation": "drug_selection",
            }
            if item.get("tool") in assessment_types:
                require(
                    item.get("assessmentType") == assessment_types[item["tool"]],
                    "%s did not certify the deterministic assessment compiler" % item.get("tool"),
                )
                require(
                    item.get("automaticDecision") is False and item.get("humanReviewRequired") is True,
                    "%s lost its human decision boundary" % item.get("tool"),
                )


def verify_sources():
    module_file = REPO / "runtime" / "mcp" / "evimed-research" / "source_catalog.py"
    module = load_module("evimed_source_catalog_audit", module_file)
    public_sources = load_module(
        "evimed_source_registry_audit",
        REPO / "runtime" / "mcp" / "evimed-research" / "public_sources.py",
    )
    registered = set(public_sources.BIOMEDICAL_SOURCE_IDS)
    conditional = set(public_sources.CONDITIONAL_BIOMEDICAL_SOURCE_IDS)
    summary = module.integration_summary()
    states = summary.get("connectionStateCounts", {})
    # Every count below is recomputed from the catalog rows and from the live
    # connector registry. It used to be eleven literals -- 123 reviewed, 13
    # skill-guidance, 4/18/11/8/2/3 by connection state, 8 conditional -- in the
    # same file whose own comment, forty lines up, criticises "a number in one
    # file and a registry in another". Every one of them was a release blocked
    # by a message naming a count instead of the change that moved it, and the
    # only way past was to edit the expectation, which is the audit grading
    # itself.
    #
    # What is worth checking is not the totals: it is that the three
    # descriptions of the same catalog agree -- the rows, the summary the
    # product publishes from them, and the connector registry the runtime
    # actually mounts. A miscount in `integration_summary()` fails here; adding
    # a data source does not.
    rows = module.sources()
    require(rows, "the source catalog is empty")
    counted = Counter(str(item.get("connectionState")) for item in rows)
    require(len(registered) == len(public_sources.BIOMEDICAL_SOURCE_IDS), "public connector registry contains duplicate ids")
    require(not registered.intersection(conditional), "conditional connector registry is invalid")
    require(set(public_sources.QUERYABLE_BIOMEDICAL_SOURCE_IDS) == registered | conditional, "queryable connector registry drifted")
    require(set(module.active_connector_ids()) == registered, "catalogued public connectors do not exactly match the live registry")
    require(
        summary.get("reviewedTotal") == len(rows) and sum(states.values()) == len(rows),
        "reviewed data-source count does not reconcile with the catalog: summary %s, states %d, rows %d"
        % (summary.get("reviewedTotal"), sum(states.values()), len(rows)),
    )
    require(
        dict(states) == dict(counted),
        "connection-state counts do not reconcile with the catalog rows: summary %s, rows %s"
        % (sorted(states.items()), sorted(counted.items())),
    )
    require(summary.get("connectedPublic") == len(registered) and states.get("connected_public") == len(registered), "connected data-source count is inflated")
    require(summary.get("skillGuidanceOnly") == counted.get("skill_guidance", 0), "skill-guidance data-source count drifted")
    require(
        summary.get("notConnected") == len(rows) - len(registered) - counted.get("skill_guidance", 0),
        "not-connected data-source count drifted",
    )
    # The one state that must stay empty: `catalog_only` means a row nobody
    # classified, and a classification nobody made is not a review.
    require(counted.get("catalog_only", 0) == 0, "%d data source(s) are catalogued and unclassified" % counted.get("catalog_only", 0))
    require(len(conditional) == counted.get("ready_credentials", 0), "credential-ready catalog rows and implemented adapters disagree")
    conditional_items = [item for item in module.sources() if item.get("connectionState") == "ready_credentials"]
    require({item.get("id") for item in conditional_items} == conditional, "credential-ready catalog entries do not match implemented adapters")
    require(all(item.get("connector") == item.get("id") for item in conditional_items), "credential-ready connector ids drifted")
    require(all((item.get("validation") or {}).get("contractTests") == "pass" for item in conditional_items), "a credential-ready adapter lacks contract evidence")
    require(all((item.get("validation") or {}).get("liveProbe") == "blocked_missing_operator_credential" for item in conditional_items), "a credential-ready source was falsely marked live")
    require(summary.get("productionConnectorRoute") == "controlled_connector_routes", "public connectors do not use controlled production routes")
    require(summary.get("productionConnectorRoutes") == ["bundled_verified_dataset", "server_allowlisted_gateway"], "public connector routes drifted")
    require(summary.get("runtimeArbitraryEgress") is False, "public connectors incorrectly require arbitrary runtime egress")


def verify_connectors():
    public_sources = load_module("evimed_release_connector_registry", REPO / "runtime" / "mcp" / "evimed-research" / "public_sources.py")
    registry = tuple(public_sources.BIOMEDICAL_SOURCE_IDS)
    registered = set(registry)
    expected = len(registered)
    document = read("connector-probe-v3.json")
    summary = document.get("summary", {})
    observed_time(document.get("probedAt"), "connector audit")
    require(document.get("schemaVersion") == 3, "connector audit schema is stale")
    require(summary.get("registrySha256") == hashlib.sha256("\0".join(registry).encode("utf-8")).hexdigest(), "connector evidence does not match the ordered live registry")
    require(summary.get("registrySourceSha256") == file_sha256(REPO / "runtime" / "mcp" / "evimed-research" / "public_sources.py"), "connector evidence does not match the live registry source")
    require(summary.get("registered") == expected, "connector evidence does not match the live registry count")
    require(summary.get("queriesExecuted") == expected * 2, "connector audit did not execute two queries per connector")
    require(summary.get("qualityPass") == expected and summary.get("qualityFail") == 0, "not all registered connectors passed the quality contract")
    require(summary.get("productionRoute") == "controlled_connector_routes", "connector audit did not use controlled production routes")
    require(summary.get("productionRoutes") == ["bundled_verified_dataset", "server_allowlisted_gateway"], "connector audit production routes drifted")
    require(summary.get("productionGatewayUsed") is True and summary.get("directSourceRequests") is False, "connector audit used direct runtime requests")
    require(summary.get("runtimeArbitraryEgress") is False, "connector audit incorrectly requires arbitrary runtime egress")
    gateway = summary.get("gatewayEvidence", {})
    require(gateway.get("handler") == "apps/server/src/publicSourceGateway.mjs", "connector audit did not exercise the production gateway handler")
    bundled_sources = set(getattr(public_sources, "BUNDLED_DATASET_SOURCE_IDS", ()))
    require(summary.get("bundledDatasetSources") == sorted(bundled_sources), "bundled dataset connector evidence drifted")
    require(gateway.get("forwardedRequests", 0) >= (expected - len(bundled_sources)) * 2, "connector gateway forwarding evidence is incomplete")
    require(gateway.get("allRequestsAllowlistedHttpsRead") is True, "connector gateway forwarded a disallowed request")
    methods = gateway.get("methods", {})
    require(set(methods).issubset({"GET", "POST"}) and sum(methods.values()) == gateway.get("forwardedRequests"), "connector gateway method evidence does not reconcile")
    results = document.get("results", [])
    require(len(results) == expected, "connector audit does not contain one result per registered connector")
    require({item.get("source") for item in results} == registered, "connector evidence does not match the live registry")
    bundled_receipts = summary.get("bundledDatasets", [])
    require({item.get("source") for item in bundled_receipts} == bundled_sources, "bundled dataset receipts are incomplete")
    for receipt in bundled_receipts:
        dataset = (REPO / str(receipt.get("path", ""))).resolve()
        license_file = (REPO / str(receipt.get("licensePath", ""))).resolve()
        require(dataset.is_relative_to(REPO) and dataset.is_file() and not dataset.is_symlink(), "bundled dataset is unavailable")
        require(dataset.stat().st_size == receipt.get("bytes") and file_sha256(dataset) == receipt.get("sha256"), "bundled dataset receipt does not match disk")
        require(license_file.is_relative_to(REPO) and license_file.is_file() and not license_file.is_symlink(), "bundled dataset license receipt is unavailable")
    for item in results:
        require(item.get("status") == "quality_pass", "%s is not quality-certified" % item.get("source"))
        require(len(item.get("cases", [])) == 2, "%s lacks dual-query evidence" % item.get("source"))
        require(item.get("qualityChecks") and all(item["qualityChecks"].values()), "%s failed a connector quality check" % item.get("source"))
        for case in item["cases"]:
            expected_route = "bundled_verified_dataset" if item.get("source") in bundled_sources else "server_allowlisted_gateway"
            require(case.get("executionRoute") == expected_route, "%s case bypassed its controlled production route" % item.get("source"))
            require(case.get("pass") is True and case.get("checks") and all(case["checks"].values()), "%s case failed its response contract" % item.get("source"))


def verify_skills():
    # v4 describes the retired tree. Never reinterpret its historical counts.
    require((REPORTS / "skill-audit-v5.json").is_file(), "skill audit uses a retired runtime tree; record skill-audit-v5.json in a NEW output directory with build_skill_audit.py; missing current execution remains unknown")
    document = read("skill-audit-v5.json")
    summary = document.get("summary", {})
    require(summary.get("schemaVersion") == 5, "skill audit schema is stale")
    composition = skill_composition(REPO)
    require(summary.get("sourcePlannedComposition") == composition, "skill source plan differs in name/path/digest/dispatch scope; regenerate inventory, not execution receipts")
    require(summary.get("imageObservation") == "unknown", "a source-only skill inventory cannot assert a live image observation")
    coverage = skill_execution_coverage(REPO, RESULTS, composition)
    require(summary.get("historicalExecutionEvidence") == skill_evidence_metadata(RESULTS), "historical skill totals/time/environment/evidence identity drifted")
    require(summary.get("executionCoverage") == coverage, "skill execution coverage does not match current source and retained receipts")
    certified = [row["packageId"] for row in coverage if row["state"] == "bounded-historical-task-matched"]
    unknown = [row["packageId"] for row in coverage if row["state"] == "unknown"]
    require(summary.get("sourcePlannedSkillPackages") == len(coverage), "skill source count does not match its concrete inventory")
    require(summary.get("boundedHistoricalTaskPackageIds") == certified and summary.get("boundedHistoricalTaskPackageCount") == len(certified), "skill execution certification is inflated")
    require(summary.get("unknownExecutionPackageIds") == unknown, "unknown skill execution was omitted")
    require(summary.get("incomingSkillsReviewed") == 149, "skill review count is not 149")
    require(summary.get("sourcePackagesPublished") == 0, "mapped source capabilities were misreported as published packages")
    items = document.get("items", [])
    require(len(items) == 149, "skill audit does not contain 149 reviewed inputs")
    planned = {row["id"] for row in composition["packages"]}
    from build_skill_audit import capability_mapping, BUNDLED, RETIRED_MAPPINGS
    historical_mapping = {**capability_mapping(), **BUNDLED, **RETIRED_MAPPINGS}
    for item in items:
        mapped = item.get("runtimePackages", [])
        require(mapped == historical_mapping.get(item.get("sourceName"), []), "historical semantic targets differ from the reviewed mapping")
        expected_states = [{"target": name, "state": "source-planned" if name in planned else "unverified-non-skill-target" if name.startswith(("builtin/", "platform/")) else "historical-target-not-shipped"} for name in mapped]
        require(item.get("targetStates") == expected_states, "retired/unverified target was claimed currently available")
        require(not mapped or all(name in planned for name in mapped) or item.get("releaseStatus") == "historical_mapping_unverified", "unshipped historical targets were labeled current capability mappings")
        require(item.get("runtimePackagesSourcePlanned") == [name for name in mapped if name in planned], "mapped skill source inclusion is inflated")
        require(item.get("runtimePackagesBoundedHistoricalTaskMatched") == [name for name in mapped if name in certified], "mapped skill execution is inflated")
    require(all(item.get("releaseStatus") != "published" for item in items), "a mapped source skill is still labeled published")
    require(summary.get("historicalCapabilitiesMapped") == sum(bool(row.get("runtimePackages")) for row in items), "historical mapping count is inflated")
    require(summary.get("sourceCapabilitiesMapped") == sum(row.get("releaseStatus") == "capability_mapped" for row in items), "source capability mapping count is inflated")
    require(summary.get("sourceCapabilitiesMappedToSourcePlan") == sum(row.get("releaseStatus") == "capability_mapped" and bool(row.get("runtimePackagesSourcePlanned")) for row in items), "source-plan capability mapping count is inflated")
    require(summary.get("sourceCapabilitiesBackedByBoundedHistoricalTask") == sum(row.get("releaseStatus") == "capability_mapped" and bool(row.get("runtimePackagesBoundedHistoricalTaskMatched")) for row in items), "bounded historical capability task count is inflated")
    require(not unknown, "current skill task evidence is unknown for: " + ", ".join(unknown) + "; source inclusion is not an executed task or native dispatch; native/delegated entries may use hosted receipts, not mandatory Python smoke")


def verify_acceptance():
    """Fail when the per-capability acceptance ledger drifts from the tree.

    This one checks a record, not a recording: whether every capability under
    `capabilities/` has a row, whether every row names a capability that exists,
    whether each brief count matches the briefs on disk and whether every claim
    of a delivery resolves to something. It does not require that any capability
    be accepted — most rows read "not-run" today and that is the honest answer.
    The acceptance rate is printed as a notice for exactly that reason.
    """
    issues = acceptance_ledger.ledger_issues()
    require(
        not issues,
        "acceptance ledger is inconsistent with the capability tree:\n  - %s" % "\n  - ".join(issues),
    )
    for notice in acceptance_ledger.harness_notices():
        print(notice)
    print(acceptance_ledger.coverage_notice())


def main(argv=None):
    global REPORTS, RESULTS, EVIDENCE, JOB_STATE, OPERATOR_MAX_AGE_DAYS
    skills_only = False
    if argv is not None:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--report-dir", type=Path, default=REPORTS, help="new audit summaries; historical files are not rewritten")
        parser.add_argument("--evidence-dir", type=Path, default=RESULTS, help="retained task documents and their evidence/ subtree")
        parser.add_argument("--skills-only", action="store_true", help="validate only skill inventory/evidence; this does not certify the release")
        parser.add_argument("--max-evidence-age-days", type=float, default=None,
                            help="an operator's own bound on the age of retained evidence; by default none: evidence counts for as "
                                 "long as the source it was taken on is the source in this tree")
        args = parser.parse_args(argv)
        OPERATOR_MAX_AGE_DAYS = args.max_evidence_age_days
        REPORTS, RESULTS = args.report_dir.resolve(), args.evidence_dir.resolve()
        EVIDENCE, JOB_STATE = RESULTS / "evidence", RESULTS / "evidence/job-state"
        skills_only = args.skills_only
    if skills_only:
        verify_skills()
        print("skill audit section passed; release and current image were not certified")
        return
    # Appended, never inserted. This audit is a fail-fast wall of refusals, so
    # where a new check goes decides which refusal an operator is shown first —
    # and the freshness refusals in verify_tools/verify_sources are the ones
    # that must keep speaking for themselves. Running last also means a stale
    # checkout never reaches this check, which is exactly why the ledger's own
    # coverage does not depend on the audit: `pnpm test:acceptance-ledger` runs
    # it offline on every commit through `test:web`, and `pnpm
    # check:acceptance-ledger` runs it on its own.
    verify_tools()
    verify_sources()
    verify_connectors()
    verify_skills()
    verify_acceptance()
    print("capability audit release gate passed")


if __name__ == "__main__":
    main(sys.argv[1:])
