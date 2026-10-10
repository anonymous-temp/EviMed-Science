#!/usr/bin/env python3
"""Reconcile historical skill mappings with the current source-planned composition.

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

from audit_inventory import skill_composition, skill_execution_coverage, skill_evidence_metadata


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RUNTIME_ROOT = REPO / "runtime" / "skills"
RESULTS = HERE / "results"


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
    "generate-image": ["core/publication-figures", "external/ai4s-skills/mindmap-render"],
    "infographics": ["core/publication-figures", "office/pptx"],
    "latex-posters": ["core/publication-figures"],
    "pptx-posters": ["core/publication-figures", "office/pptx"],
    "scientific-slides": ["office/pptx"],
    "exa-search": ["builtin/websearch"],
    "get-available-resources": ["platform/runtime-capabilities"],
}

RETIRED_MAPPINGS = {"open-notebook": ["platform/notebooks"]}

CREDENTIALED_OPTIONAL = {
    "adaptyv", "benchling-integration", "dnanexus-integration", "ginkgo-cloud-lab",
    "labarchive-integration", "latchbio-integration", "matlab", "omero-integration",
    "protocolsio-integration", "rowan", "tamarind",
}

PHYSICAL_HARDWARE = {"opentrons-integration", "pylabrobot"}
CLINICAL_SAFETY = {"clinical-decision-support", "treatment-plans"}


def fresh_web_packages() -> list[str]:
    return [item["id"] for item in skill_composition(REPO)["packages"]]


def execution_certified_packages() -> set[str]:
    return {row["packageId"] for row in skill_execution_coverage(REPO, RESULTS, skill_composition(REPO)) if row["state"] in {"bounded-historical-task-matched", "bounded-hosted-task-matched"}}


def source_value(source: dict, current: str, legacy: str, fallback=None):
    value = source.get(current, source.get(legacy, fallback))
    return fallback if value is None else value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=HERE / "results")
    parser.add_argument("--evidence-dir", type=Path, default=RESULTS,
                        help="retained task reports; use the same directory when verifying the new summary")
    args = parser.parse_args()
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    incoming = payload.get("items", []) if isinstance(payload, dict) else payload
    if not isinstance(incoming, list):
        raise SystemExit("skill audit input must be a list or an object with items")
    mapping = capability_mapping()
    composition = skill_composition(REPO)
    web_packages = {item["id"] for item in composition["packages"]}
    evidence_dir = args.evidence_dir.resolve()
    coverage = skill_execution_coverage(REPO, evidence_dir, composition)
    certified_packages = {row["packageId"] for row in coverage if row["state"] in {"bounded-historical-task-matched", "bounded-hosted-task-matched"}}
    rows = []
    for source in incoming:
        name = source_value(source, "name", "sourceName")
        if not isinstance(name, str) or not name:
            raise SystemExit("skill audit input contains an invalid source name")
        packages = mapping.get(name)
        if name in RETIRED_MAPPINGS:
            packages = RETIRED_MAPPINGS[name]
            disposition = "retired_product_mapping"
            release = "historical_mapping_unverified"
            decision = "Historical Notebook mapping is retired; it is not a current platform capability."
        elif packages:
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
        target_states = [{"target": package, "state": "source-planned" if package in web_packages else "unverified-non-skill-target" if package.startswith(("builtin/", "platform/")) else "historical-target-not-shipped"} for package in packages]
        if release == "capability_mapped" and any(item["state"] != "source-planned" for item in target_states):
            release = "historical_mapping_unverified"
            disposition = "historical_targets_not_verified"
            decision = "Historical semantic mapping retained for review; one or more targets are not shipped or not verified by the current composition/registry. Source path existence is not current availability."
        rows.append({
            "sourceName": name,
            "sourceSeverity": source_value(source, "severity", "sourceSeverity", ""),
            "sourceFindings": source_value(source, "findings", "sourceFindings", 0),
            "sourceScannerSafe": bool(source_value(source, "scannerSafe", "sourceScannerSafe", False)),
            "previousStatus": source_value(source, "finalStatus", "previousStatus", ""),
            "releaseStatus": release,
            "disposition": disposition,
            "runtimePackages": packages,
            "mappingBasis": "historical-reviewed-semantic-targets",
            "targetStates": target_states,
            "runtimePackagesSourcePlanned": [
                package for package in packages
                if package in web_packages
            ],
            "runtimePackagesBoundedHistoricalTaskMatched": [
                package for package in packages
                if package in certified_packages
            ],
            "historicalNonSkillTargets": [
                package for package in packages if package.startswith(("builtin/", "platform/"))
            ],
            "historicalIncomingSourceLoaded": source_value(source, "finalStatus", "previousStatus", "") == "integrated_audited",
            "currentImageExecution": "unknown",
            "boundedHistoricalTaskState": "bounded-historical-task-matched" if packages and all(package in certified_packages for package in packages) else "unknown",
            "decision": decision,
            "sourceSnapshotAction": "Preserve for audit evidence; do not copy excluded instructions into the runtime.",
        })

    args.output_dir.mkdir(parents=True, exist_ok=True)
    if any((args.output_dir / name).exists() for name in ("skill-audit-v5.json", "skill-audit-v5.csv")):
        raise SystemExit("audit output already exists; use a new --output-dir to preserve evidence")
    summary = {
        "schemaVersion": 5,
        "incomingSkillsReviewed": len(rows),
        "sourcePlannedComposition": composition,
        "sourcePlannedSkillPackages": len(web_packages),
        "imageObservation": "unknown",
        "executionCoverage": coverage,
        "historicalExecutionEvidence": skill_evidence_metadata(evidence_dir),
        "boundedHistoricalTaskPackageCount": len(certified_packages),
        "boundedHistoricalTaskPackageIds": sorted(certified_packages),
        "unknownExecutionPackageIds": [row["packageId"] for row in coverage if row["state"] == "unknown"],
        "releaseStatus": dict(Counter(row["releaseStatus"] for row in rows)),
        "dispositions": dict(Counter(row["disposition"] for row in rows)),
        "historicalIncomingSourceInstructionsLoaded": sum(row["historicalIncomingSourceLoaded"] for row in rows),
        "historicalCapabilitiesMapped": sum(bool(row["runtimePackages"]) for row in rows),
        "sourceCapabilitiesMapped": sum(row["releaseStatus"] == "capability_mapped" for row in rows),
        "sourceCapabilitiesMappedToSourcePlan": sum(
            row["releaseStatus"] == "capability_mapped" and bool(row["runtimePackagesSourcePlanned"])
            for row in rows
        ),
        "sourceCapabilitiesBackedByBoundedHistoricalTask": sum(
            row["releaseStatus"] == "capability_mapped" and bool(row["runtimePackagesBoundedHistoricalTaskMatched"])
            for row in rows
        ),
        "sourcePackagesPublished": 0,
        "note": "Dockerfile COPY and preset assembly describe the source plan, not an observed image or offered tools. Optional/private roots, personal generations and kernel-provided plugins need separate current deployment evidence. Historical receipts certify only unchanged packages with matching artifacts/dependencies; all other execution is unknown.",
    }
    document = json.dumps({"summary": summary, "items": rows}, ensure_ascii=False, indent=2) + "\n"
    for filename in ("skill-audit-v5.json",):
        with (args.output_dir / filename).open("x", encoding="utf-8") as handle:
            handle.write(document)
    for filename in ("skill-audit-v5.csv",):
        handle = (args.output_dir / filename).open("x", newline="", encoding="utf-8-sig")
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
                    "yes" if row["historicalIncomingSourceLoaded"] else "no", row["decision"],
                ])
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
