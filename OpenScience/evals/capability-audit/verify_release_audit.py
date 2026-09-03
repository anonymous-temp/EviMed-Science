#!/usr/bin/env python3
"""Fail the release when capability counts exceed their machine evidence."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / "results"
# Probe receipts point at files the audit run produced inside a live server
# workspace, which .gitignore keeps out of the repository. The generator mirrors
# them here, workspace-relative, so a clean clone can verify the same evidence.
EVIDENCE = RESULTS / "evidence"
JOB_STATE = EVIDENCE / "job-state"
SPECIALIST_SOURCES = REPO.parent / "项目代码"


def read(name):
    return json.loads((RESULTS / name).read_text(encoding="utf-8"))


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def parsed_fresh(value, label, max_age_days=14):
    try:
        observed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise SystemExit("%s timestamp is invalid" % label)
    now = datetime.now(timezone.utc)
    require(observed <= now + timedelta(minutes=5), "%s timestamp is in the future" % label)
    require(observed >= now - timedelta(days=max_age_days), "%s evidence is stale" % label)
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


def verify_tools():
    document = read("tool-probe-v3.json")
    parsed_fresh(document.get("probedAt"), "tool audit")
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
    not_offered = document.get("notOffered") or []
    require(
        isinstance(not_offered, list) and all(isinstance(name, str) for name in not_offered),
        "tool audit notOffered is not a list of tool names",
    )
    not_offered = set(not_offered)
    unknown = sorted(not_offered - registry)
    require(not unknown, "tool audit reports tools the registry does not declare as not offered: %s" % ", ".join(unknown))
    unapproved = sorted(not_offered - set(server.OPTIONAL_TOOLS))
    require(
        not unapproved,
        "tools this product does not declare optional were switched off: %s" % ", ".join(unapproved),
    )
    expected = len(registry - not_offered)
    require(document.get("registered") == expected, "tool registry count is not %d" % expected)
    require(document.get("executionCertified") == expected, "all %d tools are not execution-certified" % expected)
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
            parsed_fresh(item.get("executedAt"), "%s job" % item.get("tool"))
            require(item.get("artifactCount", 0) > 0, "%s lacks artifacts" % item.get("tool"))
            require(item.get("artifactCount") == len(item.get("artifacts", [])), "%s artifact count does not reconcile" % item.get("tool"))
            require(all(receipt.get("bytes", 0) > 0 and len(receipt.get("sha256", "")) == 64 for receipt in item.get("artifacts", [])), "%s has invalid artifact receipts" % item.get("tool"))
            require(EVIDENCE.is_dir(), "%s receipt evidence snapshot is unavailable" % item.get("tool"))
            state_file = JOB_STATE / ("%s.json" % item.get("jobId"))
            require(state_file.is_file() and not state_file.is_symlink(), "%s job state is unavailable" % item.get("tool"))
            state = json.loads(state_file.read_text(encoding="utf-8"))
            require(state.get("status") in {"succeeded", "blocked"}, "%s job is not terminal" % item.get("tool"))
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
    require(len(registered) == len(public_sources.BIOMEDICAL_SOURCE_IDS), "public connector registry contains duplicate ids")
    require(len(conditional) == 8 and not registered.intersection(conditional), "conditional connector registry is invalid")
    require(set(public_sources.QUERYABLE_BIOMEDICAL_SOURCE_IDS) == registered | conditional, "queryable connector registry drifted")
    require(set(module.active_connector_ids()) == registered, "catalogued public connectors do not exactly match the live registry")
    require(summary.get("reviewedTotal") == 123 and sum(states.values()) == 123, "reviewed data-source count drifted")
    require(summary.get("connectedPublic") == len(registered) and states.get("connected_public") == len(registered), "connected data-source count is inflated")
    require(summary.get("skillGuidanceOnly") == 13 and states.get("skill_guidance") == 13, "skill-guidance data-source count drifted")
    require(summary.get("notConnected") == 123 - len(registered) - 13, "not-connected data-source count drifted")
    require({key: states.get(key) for key in (
        "blocked_approval", "blocked_license", "blocked_no_api", "ready_credentials",
        "adapter_credentials_required", "ready_private_adapter", "catalog_only",
    )} == {
        "blocked_approval": 4,
        "blocked_license": 18,
        "blocked_no_api": 11,
        "ready_credentials": 8,
        "adapter_credentials_required": 2,
        "ready_private_adapter": 3,
        "catalog_only": None,
    }, "blocked or conditional data-source counts drifted")
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
    parsed_fresh(document.get("probedAt"), "connector audit")
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
    document = read("skill-audit-v4.json")
    summary = document.get("summary", {})
    require(summary.get("schemaVersion") == 4, "skill audit schema is stale")
    require(summary.get("incomingSkillsReviewed") == 149, "skill review count is not 149")
    skill_root = REPO / "runtime" / "skills"

    def enabled(root):
        inventory_file = root / "inventory.json"
        allowed = None
        if inventory_file.is_file():
            inventory = json.loads(inventory_file.read_text(encoding="utf-8"))
            delivery = inventory.get("policy", {}).get("delivery", {})
            require(delivery.get("contractVersion") == 1 and delivery.get("defaultEnabledTier") == "executable", "runtime skill inventory contract is invalid")
            allowed = set(delivery.get("executable", {}))
        return [
            manifest.parent.relative_to(skill_root).as_posix()
            for manifest in root.glob("*/SKILL.md")
            if allowed is None or manifest.parent.name in allowed
        ]

    global_roots = (
        skill_root / "core",
        skill_root / "external" / "ai4s-skills",
        skill_root / "curated-scientific",
        skill_root / "office",
    )
    global_installed = sorted(package for root in global_roots for package in enabled(root))
    specialist_installed = sorted(enabled(skill_root / "evimed"))
    installed = sorted(global_installed + specialist_installed)
    # Derived from the installed tree, not written down. Four packages were
    # added after this audit was last recorded and three pinned literals here
    # each failed in turn with a number rather than a name; the recording is
    # what has to match the tree, and pinning the tree's own size only means an
    # extra edit every time a Skill ships. The floors are the walk assertion:
    # a glob that stopped matching would otherwise agree with a recording that
    # had also stopped counting.
    require(len(global_installed) >= 50, "the global Skill scan found %d packages; it is not reading the tree" % len(global_installed))
    require(len(specialist_installed) >= 8, "the specialist Skill scan found %d packages; it is not reading the tree" % len(specialist_installed))
    require(
        summary.get("freshWebGlobalSkillPackages") == len(global_installed),
        "clean Web global Skill count is not %d" % len(global_installed),
    )
    require(
        summary.get("freshWebSpecialistSkillPackages") == len(specialist_installed),
        "clean Web specialist Skill count is not %d" % len(specialist_installed),
    )
    # `freshWebOpenCodeSkillPackages` is the same count under the name the
    # generator wrote while the retired kernel was the one being counted. The
    # recorded results in `results/` were measured then and are not rewritten —
    # editing a recording to look current is falsified evidence — so this reads
    # the current name and falls back to the recorded one. Drop the fallback
    # once the audit has been re-recorded under the DSH runtime.
    installed_count = summary.get("freshWebRuntimeSkillPackages")
    if installed_count is None:
        installed_count = summary.get("freshWebOpenCodeSkillPackages")
        # Said out loud rather than absorbed: a reader of a passing gate would
        # otherwise take a count measured under the retired kernel for a count
        # measured under the one that ships.
        print(
            "notice: skill-audit-v4.json carries freshWebOpenCodeSkillPackages, "
            "so this count was recorded under the retired kernel; re-record the "
            "skill audit under the DSH runtime",
        )
    require(installed_count == len(installed), "clean Web runtime Skill count is not %d" % len(installed))
    require(summary.get("freshWebInstalledPackageIds") == installed, "skill audit does not match the clean runtime delivery contract")

    execution = read("skill-execution-v1.json")
    parsed_fresh(execution.get("finishedAt"), "Skill execution audit")
    require(execution.get("schemaVersion") == 1, "Skill execution audit schema is stale")
    curated_inventory_file = skill_root / "curated-scientific" / "inventory.json"
    curated_engine_file = skill_root / "curated-scientific" / "_runtime" / "execute_skill.py"
    curated_inventory = json.loads(curated_inventory_file.read_text(encoding="utf-8"))
    curated_ids = set(curated_inventory["policy"]["delivery"]["executable"])
    execution_rows = execution.get("skills", [])
    certified_ids = {row.get("skill") for row in execution_rows if row.get("passed") is True}
    certified_packages = sorted("curated-scientific/%s" % name for name in certified_ids)
    require(execution.get("inventorySha256") == file_sha256(curated_inventory_file), "Skill execution evidence does not match the current inventory")
    require(execution.get("runtimeEngineSha256") == file_sha256(curated_engine_file), "Skill execution evidence does not match the current runtime engine")
    require(execution.get("environment", {}).get("matchesInventory") is True, "Skill execution environment does not match pinned dependencies")
    require(execution.get("inventoryExecutable") == 38 and execution.get("executionCertified") == 38 and execution.get("failed") == 0, "all 38 curated Skills are not execution-certified")
    require(len(execution_rows) == 38 and certified_ids == curated_ids, "Skill execution evidence does not exactly cover the curated inventory")
    for row in execution_rows:
        require(row.get("operation") == "smoke-task" and row.get("returnCode") == 0 and row.get("passed") is True, "%s lacks a completed task receipt" % row.get("skill"))
        receipts = row.get("artifacts", [])
        require(len(receipts) >= 2, "%s lacks retained artifacts" % row.get("skill"))
        for receipt in receipts:
            artifact = (REPO / str(receipt.get("path", ""))).resolve()
            require(artifact.is_relative_to(REPO) and artifact.is_file() and not artifact.is_symlink(), "%s retained artifact is unavailable" % row.get("skill"))
            require(artifact.stat().st_size == receipt.get("bytes") and file_sha256(artifact) == receipt.get("sha256"), "%s retained artifact receipt does not match disk" % row.get("skill"))

    platform_execution = read("platform-skill-execution-v1.json")
    parsed_fresh(platform_execution.get("finishedAt"), "platform Skill execution audit")
    require(platform_execution.get("schemaVersion") == 1, "platform Skill execution audit schema is stale")
    require(platform_execution.get("environment", {}).get("dependencyContract") == "selected audit runtime plus package-declared dependencies", "platform Skill execution dependency contract drifted")
    expected_platform_packages = {
        "core/domain-check", "core/hpc-slurm", "core/large-file", "core/modal-run",
        "core/publication-figures", "core/remote-compute", "core/stats-integrity",
        "core/traceability-review", "external/ai4s-skills/integrity-auditor",
        "external/ai4s-skills/mindmap-render", "office/docx", "office/pdf", "office/pptx", "office/xlsx",
    }
    platform_rows = platform_execution.get("packages", [])
    platform_certified = {row.get("package") for row in platform_rows if row.get("passed") is True}
    require(
        platform_execution.get("installedPackagesExamined") == 14
        and platform_execution.get("executionCertified") == 14
        and platform_execution.get("failed") == 0
        and len(platform_rows) == 14
        and platform_certified == expected_platform_packages,
        "all 14 bounded platform Skills are not execution-certified",
    )
    for row in platform_rows:
        package = row.get("package")
        require(row.get("operation") == "task" and row.get("returnCode") == 0 and row.get("passed") is True, "%s lacks a completed platform task receipt" % package)
        require(row.get("checks") and all(row["checks"].values()), "%s failed a platform task validation" % package)
        manifest = skill_root / str(package) / "SKILL.md"
        entrypoint = (REPO / str(row.get("entrypoint", ""))).resolve()
        require(manifest.is_file() and file_sha256(manifest) == row.get("manifestSha256"), "%s manifest execution evidence drifted" % package)
        require(entrypoint.is_relative_to(REPO) and entrypoint.is_file() and file_sha256(entrypoint) == row.get("entrypointSha256"), "%s entrypoint execution evidence drifted" % package)
        receipts = row.get("artifacts", [])
        require(len(receipts) >= 1, "%s lacks a retained task artifact" % package)
        for receipt in receipts:
            artifact = (REPO / str(receipt.get("path", ""))).resolve()
            require(artifact.is_relative_to(REPO) and artifact.is_file() and not artifact.is_symlink(), "%s retained platform artifact is unavailable" % package)
            require(artifact.stat().st_size == receipt.get("bytes") and file_sha256(artifact) == receipt.get("sha256"), "%s retained platform artifact receipt does not match disk" % package)

    specialist_skill_tools = {
        "evimed/adr-analysis": "drug_safety_analysis",
        "evimed/bibliometric-analysis": "bibliometric_analysis",
        "evimed/comprehensive-drug-evaluation": "comprehensive_drug_evaluation",
        "evimed/drug-selection": "drug_selection_evaluation",
        "evimed/mendelian-randomization": "mendelian_randomization",
        "evimed/meta-analysis": "meta_analysis",
        "evimed/off-label-analysis": "offlabel_evidence_packet",
        "evimed/peer-review": "peer_review",
        "evimed/research-topic-selection": "research_topic_selection",
    }
    tool_results = {row.get("tool"): row for row in read("tool-probe-v3.json").get("results", [])}
    for package, tool in specialist_skill_tools.items():
        evidence = tool_results.get(tool, {})
        require(evidence.get("operational") is True and evidence.get("operation") in {"task", "start_then_poll_to_terminal"}, "%s lacks linked tool-task evidence" % package)
    all_certified_packages = sorted(set(certified_packages) | expected_platform_packages | set(specialist_skill_tools))
    require(
        summary.get("webExecutionCertifiedSkillPackages") == len(all_certified_packages),
        "clean Web execution-certified Skill count is not %d" % len(all_certified_packages),
    )
    require(summary.get("webExecutionCertifiedPackageIds") == all_certified_packages, "Skill audit does not match retained execution receipts")
    require(summary.get("sourceCapabilitiesMapped") == 127, "source capability mapping count is not 127")
    require(summary.get("sourcePackagesPublished") == 0, "mapped source capabilities were misreported as published packages")
    items = document.get("items", [])
    require(len(items) == 149, "skill audit does not contain 149 reviewed inputs")
    require(sum(item.get("releaseStatus") == "capability_mapped" for item in items) == 127, "mapped skill row count is not 127")
    require(summary.get("sourceCapabilitiesMappedToFreshRuntime") == sum(
        item.get("releaseStatus") == "capability_mapped" and bool(item.get("runtimePackagesInstalledInWeb"))
        for item in items
    ), "fresh-runtime capability mapping count is inflated")
    require(summary.get("sourceCapabilitiesBackedByExecutedRuntime") == sum(
        item.get("releaseStatus") == "capability_mapped" and bool(item.get("runtimePackagesExecutionCertified"))
        for item in items
    ), "executed-runtime capability mapping count is inflated")
    require(all(item.get("releaseStatus") != "published" for item in items), "a mapped source skill is still labeled published")


def main():
    verify_tools()
    verify_sources()
    verify_connectors()
    verify_skills()
    print("capability audit release gate passed")


if __name__ == "__main__":
    main()
