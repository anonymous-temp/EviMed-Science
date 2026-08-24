#!/usr/bin/env python3
"""Reconcile reviewed source skills with the packages actually installed in EviMed.

Capability mapping is intentionally not called publication. A source skill is
"mapped" when an installed EviMed package covers the same use case; this does
not mean the incoming package was installed or independently executed.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RUNTIME_ROOT = REPO / "runtime" / "skills"
WEB_GLOBAL_PACKAGE_ROOTS = (
    RUNTIME_ROOT / "core",
    RUNTIME_ROOT / "external" / "ai4s-skills",
    RUNTIME_ROOT / "curated-scientific",
    RUNTIME_ROOT / "office",
)
WEB_AGENT_PACKAGE_ROOT = RUNTIME_ROOT / "evimed"
SKILL_EXECUTION_RESULT = HERE / "results" / "skill-execution-v1.json"
PLATFORM_SKILL_EXECUTION_RESULT = HERE / "results" / "platform-skill-execution-v1.json"
TOOL_EXECUTION_RESULT = HERE / "results" / "tool-probe-v3.json"
SPECIALIST_SKILL_TOOL_MAPPING = {
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


def add(mapping: dict[str, list[str]], packages: list[str], names: str) -> None:
    for name in names.split():
        mapping[name] = packages


def capability_mapping() -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = {}
    add(mapping, ["curated-scientific/time-series-forecasting"], "aeon timesfm-forecasting")
    add(mapping, ["curated-scientific/biomedical-knowledge-graph"], "arboreto networkx primekg")
    add(mapping, ["curated-scientific/astronomy-data-analysis"], "astropy")
    add(mapping, ["curated-scientific/medical-imaging-data"], "bids imaging-data-commons pydicom")
    add(mapping, ["curated-scientific/biomedical-database-search"], "bioservices database-lookup research-lookup")
    add(mapping, ["curated-scientific/quantum-computing-analysis"], "cirq pennylane qiskit qutip")
    add(mapping, ["curated-scientific/citation-integrity"], "citation-management pyzotero scholar-evaluation")
    add(mapping, ["curated-scientific/metabolic-network-modeling"], "cobrapy")
    add(mapping, ["curated-scientific/scientific-data-engineering"], "dask lamindb polars vaex zarr-python")
    add(mapping, ["curated-scientific/cheminformatics"], "datamol medchem molfeat rdkit")
    add(mapping, ["curated-scientific/biosequence-analysis", "curated-scientific/bulk-rna-seq"], "biopython deeptools")
    add(mapping, ["curated-scientific/drug-discovery-data"], "deepchem diffdock pytdc")
    add(mapping, ["curated-scientific/biosequence-analysis", "curated-scientific/scientific-deep-learning"], "esm hugging-science")
    add(mapping, ["curated-scientific/phylogenetic-analysis"], "etetoolkit phylogenetics scikit-bio")
    add(mapping, ["curated-scientific/flow-cytometry-analysis"], "flowio")
    add(mapping, ["curated-scientific/simulation-optimization"], "fluidsim pymoo simpy sympy what-if-oracle")
    add(mapping, ["curated-scientific/genome-variant-analysis", "curated-scientific/biosequence-analysis"], "geniml gtars onekgpd pysam")
    add(mapping, ["curated-scientific/geospatial-analysis"], "geopandas geomaster")
    add(mapping, ["curated-scientific/biomedical-database-search", "curated-scientific/biosequence-analysis"], "gget")
    add(mapping, ["curated-scientific/biosequence-analysis", "curated-scientific/drug-discovery-data"], "glycoengineering")
    add(mapping, ["curated-scientific/digital-pathology-analysis"], "histolab pathml")
    add(mapping, ["curated-scientific/hypothesis-development", "curated-scientific/statistical-analysis"], "hypogenic")
    add(mapping, ["curated-scientific/hypothesis-development"], "hypothesis-generation scientific-brainstorming scientific-critical-thinking")
    add(mapping, ["curated-scientific/mass-spectrometry-analysis"], "matchms pyopenms")
    add(mapping, ["curated-scientific/materials-science-analysis", "curated-scientific/simulation-optimization"], "molecular-dynamics")
    add(mapping, ["curated-scientific/materials-science-analysis"], "pymatgen")
    add(mapping, ["curated-scientific/biomedical-signal-analysis"], "neurokit2 neuropixels-analysis")
    add(mapping, ["curated-scientific/reproducible-workflows"], "nextflow")
    add(mapping, ["curated-scientific/scientific-deep-learning", "core/remote-compute"], "optimize-for-gpu")
    add(mapping, ["curated-scientific/genome-variant-analysis", "curated-scientific/reproducible-workflows"], "pacsomatic")
    add(mapping, ["curated-scientific/genome-variant-analysis", "curated-scientific/scientific-data-engineering"], "polars-bio tiledbvcf")
    add(mapping, ["curated-scientific/scientific-deep-learning", "curated-scientific/simulation-optimization"], "pufferlib stable-baselines3")
    add(mapping, ["curated-scientific/bayesian-modeling"], "pymc")
    add(mapping, ["curated-scientific/clinical-machine-learning"], "pyhealth scikit-learn shap")
    add(mapping, ["curated-scientific/scientific-deep-learning"], "pytorch-lightning transformers")
    add(mapping, ["curated-scientific/research-grant-development"], "research-grants")
    add(mapping, ["curated-scientific/single-cell-analysis"], "anndata cellxgene-census scanpy scvelo scvi-tools")
    add(mapping, ["curated-scientific/matplotlib", "core/publication-figures"], "scientific-visualization seaborn")
    add(mapping, ["curated-scientific/survival-analysis"], "scikit-survival")
    add(mapping, ["curated-scientific/statistical-analysis", "curated-scientific/time-series-forecasting"], "statsmodels")
    add(mapping, ["curated-scientific/scientific-deep-learning", "curated-scientific/biomedical-knowledge-graph"], "torch-geometric")
    add(mapping, ["curated-scientific/drug-discovery-data", "curated-scientific/scientific-deep-learning"], "torchdrug")
    add(mapping, ["curated-scientific/exploratory-data-analysis", "curated-scientific/single-cell-analysis"], "umap-learn")
    add(mapping, ["external/ai4s-skills/experiment-suite", "core/traceability-review"], "arbor")
    add(mapping, ["curated-scientific/biomedical-database-search", "curated-scientific/citation-integrity", "builtin/websearch"], "bgpt-paper-search paper-lookup paperzilla parallel-web")
    add(mapping, ["external/ai4s-skills/literature-survey"], "literature-review")
    add(mapping, ["external/ai4s-skills/paper-writer"], "scientific-writing venue-templates")
    add(mapping, ["external/ai4s-skills/paper-writer", "core/domain-check"], "clinical-reports")
    add(mapping, ["external/ai4s-skills/integrity-auditor", "core/traceability-review"], "peer-review")
    add(mapping, ["core/publication-figures", "curated-scientific/markdown-mermaid-writing"], "scientific-schematics")
    add(mapping, ["core/modal-run"], "modal")
    add(mapping, ["curated-scientific/bulk-rna-seq"], "bulk-rnaseq pydeseq2")
    add(mapping, ["curated-scientific/cancer-functional-genomics"], "depmap")
    add(mapping, ["curated-scientific/experimental-design"], "experimental-design")
    add(mapping, ["curated-scientific/exploratory-data-analysis"], "exploratory-data-analysis")
    add(mapping, ["curated-scientific/markdown-mermaid-writing"], "markdown-mermaid-writing")
    add(mapping, ["curated-scientific/matplotlib"], "matplotlib")
    add(mapping, ["curated-scientific/pathway-enrichment"], "pathway-enrichment")
    add(mapping, ["curated-scientific/statistical-analysis"], "statistical-analysis")
    add(mapping, ["curated-scientific/statistical-power"], "statistical-power")
    return mapping


BUNDLED = {
    "docx": ["office/docx"],
    "pdf": ["office/pdf"],
    "pptx": ["office/pptx"],
    "xlsx": ["office/xlsx"],
    "markitdown": ["platform/document-viewers"],
    "liteparse": ["platform/document-viewers"],
    "open-notebook": ["platform/notebooks"],
    "generate-image": ["core/publication-figures", "external/ai4s-skills/mindmap-render"],
    "infographics": ["core/publication-figures", "office/pptx"],
    "latex-posters": ["core/publication-figures"],
    "pptx-posters": ["core/publication-figures", "office/pptx"],
    "scientific-slides": ["office/pptx"],
    "exa-search": ["builtin/websearch"],
    "get-available-resources": ["platform/runtime-capabilities"],
}

CREDENTIALED_OPTIONAL = {
    "adaptyv", "benchling-integration", "dnanexus-integration", "ginkgo-cloud-lab",
    "labarchive-integration", "latchbio-integration", "matlab", "omero-integration",
    "protocolsio-integration", "rowan", "tamarind",
}

PHYSICAL_HARDWARE = {"opentrons-integration", "pylabrobot"}
CLINICAL_SAFETY = {"clinical-decision-support", "treatment-plans"}


def runtime_package_exists(identifier: str) -> bool:
    if identifier.startswith(("builtin/", "platform/")):
        return True
    return (RUNTIME_ROOT / identifier / "SKILL.md").is_file()


def enabled_root_packages(root: Path) -> list[str]:
    inventory_file = root / "inventory.json"
    enabled = None
    if inventory_file.is_file():
        inventory = json.loads(inventory_file.read_text(encoding="utf-8"))
        delivery = inventory.get("policy", {}).get("delivery", {})
        if delivery.get("contractVersion") != 1 or delivery.get("defaultEnabledTier") != "executable":
            raise SystemExit("unsupported runtime skill delivery inventory: %s" % inventory_file)
        executable = delivery.get("executable")
        if not isinstance(executable, dict):
            raise SystemExit("invalid runtime executable inventory: %s" % inventory_file)
        enabled = set(executable)
    packages = []
    if not root.is_dir():
        return packages
    for manifest in sorted(root.glob("*/SKILL.md")):
        if enabled is None or manifest.parent.name in enabled:
            packages.append(manifest.parent.relative_to(RUNTIME_ROOT).as_posix())
    return packages


def fresh_web_packages() -> list[str]:
    packages = [
        package
        for root in WEB_GLOBAL_PACKAGE_ROOTS
        for package in enabled_root_packages(root)
    ]
    packages.extend(enabled_root_packages(WEB_AGENT_PACKAGE_ROOT))
    return sorted(packages)


def execution_certified_packages() -> set[str]:
    certified: set[str] = set()
    if SKILL_EXECUTION_RESULT.is_file():
        document = json.loads(SKILL_EXECUTION_RESULT.read_text(encoding="utf-8"))
        rows = document.get("skills", [])
        if (
            document.get("schemaVersion") != 1
            or document.get("executionCertified") != sum(bool(row.get("passed")) for row in rows)
            or document.get("environment", {}).get("matchesInventory") is not True
        ):
            raise SystemExit("curated Skill execution evidence is invalid")
        certified.update(
            "curated-scientific/%s" % row["skill"]
            for row in rows
            if row.get("passed") is True and isinstance(row.get("skill"), str)
        )
    if not PLATFORM_SKILL_EXECUTION_RESULT.is_file():
        return certified
    document = json.loads(PLATFORM_SKILL_EXECUTION_RESULT.read_text(encoding="utf-8"))
    rows = document.get("packages", [])
    if (
        document.get("schemaVersion") != 1
        or document.get("executionCertified") != sum(bool(row.get("passed")) for row in rows)
        or document.get("environment", {}).get("dependencyContract") != "selected audit runtime plus package-declared dependencies"
    ):
        raise SystemExit("platform Skill execution evidence is invalid")
    certified.update(
        row["package"]
        for row in rows
        if row.get("passed") is True and isinstance(row.get("package"), str)
    )
    if not TOOL_EXECUTION_RESULT.is_file():
        return certified
    document = json.loads(TOOL_EXECUTION_RESULT.read_text(encoding="utf-8"))
    results = {row.get("tool"): row for row in document.get("results", [])}
    if (
        document.get("schemaVersion") != 3
        or document.get("registered") != len(results)
        or document.get("executionCertified") != sum(bool(row.get("operational")) for row in results.values())
    ):
        raise SystemExit("specialist tool execution evidence is invalid")
    for package, tool in SPECIALIST_SKILL_TOOL_MAPPING.items():
        evidence = results.get(tool, {})
        if evidence.get("operational") is not True or evidence.get("operation") not in {"task", "start_then_poll_to_terminal"}:
            raise SystemExit("specialist Skill lacks task execution evidence: %s" % package)
        certified.add(package)
    return certified


def observed_local_runtime_counts() -> list[dict]:
    rows = []
    for root in sorted((REPO / ".openscience-web-data" / "users").glob(
        "*/projects/*/runtime/xdg-config/opencode/skills"
    )):
        rows.append({
            "runtime": root.relative_to(REPO).as_posix(),
            "skillPackages": len(list(root.glob("*/SKILL.md"))),
        })
    return rows


def source_value(source: dict, current: str, legacy: str, fallback=None):
    value = source.get(current, source.get(legacy, fallback))
    return fallback if value is None else value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=HERE / "results")
    args = parser.parse_args()
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    incoming = payload.get("items", []) if isinstance(payload, dict) else payload
    if not isinstance(incoming, list):
        raise SystemExit("skill audit input must be a list or an object with items")
    mapping = capability_mapping()
    web_packages = set(fresh_web_packages())
    certified_packages = execution_certified_packages()
    if certified_packages - web_packages:
        raise SystemExit("execution evidence contains a Skill outside the clean Web runtime")
    rows = []
    for source in incoming:
        name = source_value(source, "name", "sourceName")
        if not isinstance(name, str) or not name:
            raise SystemExit("skill audit input contains an invalid source name")
        packages = mapping.get(name)
        if packages:
            disposition = "covered_by_rehabilitated_runtime"
            release = "capability_mapped"
            decision = "Capability is mapped to a smaller audited EviMed package; this does not publish or install the incoming package."
        elif name in BUNDLED:
            packages = BUNDLED[name]
            disposition = "covered_by_bundled_platform"
            release = "capability_mapped"
            decision = "Capability exists in the platform; duplicate incoming instructions are not installed and are not counted as a published package."
        elif name in CREDENTIALED_OPTIONAL:
            packages = []
            disposition = "credentialed_or_licensed_optional"
            release = "not_default"
            decision = "Useful external service, but global publication would fail without an operator account, contract, or proprietary runtime."
        elif name in PHYSICAL_HARDWARE:
            packages = []
            disposition = "physical_hardware_not_default"
            release = "not_default"
            decision = "Physical laboratory actuation requires device-specific validation and is intentionally outside the default autonomous SaaS runtime."
        elif name in CLINICAL_SAFETY:
            packages = []
            disposition = "excluded_clinical_decision_support"
            release = "excluded"
            decision = "Clinical treatment or decision support is outside the current research-agent scope and is not published as an autonomous research skill."
        else:
            packages = []
            disposition = "excluded_no_unique_research_gap"
            release = "excluded"
            decision = "No unique safe EviMed research gap remains after the unified runtime packages; the incoming package is omitted from the action space."
        missing = [package for package in packages if not runtime_package_exists(package)]
        if missing:
            raise SystemExit(f"{name} maps to missing runtime packages: {missing}")
        rows.append({
            "sourceName": name,
            "sourceSeverity": source_value(source, "severity", "sourceSeverity", ""),
            "sourceFindings": source_value(source, "findings", "sourceFindings", 0),
            "sourceScannerSafe": bool(source_value(source, "scannerSafe", "sourceScannerSafe", False)),
            "previousStatus": source_value(source, "finalStatus", "previousStatus", ""),
            "releaseStatus": release,
            "disposition": disposition,
            "runtimePackages": packages,
            "runtimePackagesInstalledInWeb": [
                package for package in packages
                if package in web_packages
            ],
            "runtimePackagesExecutionCertified": [
                package for package in packages
                if package in certified_packages
            ],
            "platformCapabilities": [
                package for package in packages if package.startswith(("builtin/", "platform/"))
            ],
            "incomingSourceLoaded": source_value(source, "finalStatus", "previousStatus", "") == "integrated_audited",
            "decision": decision,
            "sourceSnapshotAction": "Preserve for audit evidence; do not copy excluded instructions into the runtime.",
        })

    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "schemaVersion": 4,
        "incomingSkillsReviewed": len(rows),
        "freshWebOpenCodeSkillPackages": len(web_packages),
        "freshWebGlobalSkillPackages": sum(
            len(enabled_root_packages(root)) for root in WEB_GLOBAL_PACKAGE_ROOTS
        ),
        "freshWebSpecialistSkillPackages": len(enabled_root_packages(WEB_AGENT_PACKAGE_ROOT)),
        "freshWebInstalledPackageIds": sorted(web_packages),
        "observedLocalRuntimeSkillPackageCounts": observed_local_runtime_counts(),
        "desktopRepositorySkillPackages": len(list(RUNTIME_ROOT.rglob("SKILL.md"))),
        "webExecutionCertifiedSkillPackages": len(certified_packages),
        "webExecutionCertifiedPackageIds": sorted(certified_packages),
        "releaseStatus": dict(Counter(row["releaseStatus"] for row in rows)),
        "dispositions": dict(Counter(row["disposition"] for row in rows)),
        "incomingSourceInstructionsLoaded": sum(row["incomingSourceLoaded"] for row in rows),
        "sourceCapabilitiesMapped": sum(row["releaseStatus"] == "capability_mapped" for row in rows),
        "sourceCapabilitiesMappedToFreshRuntime": sum(
            row["releaseStatus"] == "capability_mapped" and bool(row["runtimePackagesInstalledInWeb"])
            for row in rows
        ),
        "sourceCapabilitiesBackedByExecutedRuntime": sum(
            row["releaseStatus"] == "capability_mapped" and bool(row["runtimePackagesExecutionCertified"])
            for row in rows
        ),
        "sourcePackagesPublished": 0,
        "note": (
            "A clean Web runtime currently receives %d global executable-tier Skills plus %d EviMed specialist packages. "
            "Existing local runtimes may still show 62 packages created before the executable-tier delivery inventory was added; "
            "that observation is not the clean-deployment contract. Mapping one of 149 reviewed source capabilities does not "
            "install or publish that source package. Execution certification applies only to packages with retained task artifacts "
            "and matching dependency evidence."
        ) % (
            sum(len(enabled_root_packages(root)) for root in WEB_GLOBAL_PACKAGE_ROOTS),
            len(enabled_root_packages(WEB_AGENT_PACKAGE_ROOT)),
        ),
    }
    document = json.dumps({"summary": summary, "items": rows}, ensure_ascii=False, indent=2) + "\n"
    for filename in ("skill-audit-v2.json", "skill-audit-v3.json", "skill-audit-v4.json"):
        (args.output_dir / filename).write_text(document, encoding="utf-8")
    for filename in ("skill-audit-v2.csv", "skill-audit-v3.csv", "skill-audit-v4.csv"):
        handle = (args.output_dir / filename).open("w", newline="", encoding="utf-8-sig")
        with handle:
            writer = csv.writer(handle)
            writer.writerow([
                "Source skill", "Severity", "Findings", "Runtime status", "Disposition",
                "Mapped runtime packages", "Source instructions loaded", "Decision",
            ])
            for row in rows:
                writer.writerow([
                    row["sourceName"], row["sourceSeverity"], row["sourceFindings"],
                    row["releaseStatus"], row["disposition"], "; ".join(row["runtimePackages"]),
                    "yes" if row["incomingSourceLoaded"] else "no", row["decision"],
                ])
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
