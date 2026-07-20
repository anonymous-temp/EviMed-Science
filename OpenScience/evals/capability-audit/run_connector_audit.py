#!/usr/bin/env python3
"""Run dual-query quality probes for every public biomedical connector."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MCP_ROOT = REPO / "runtime" / "mcp" / "evimed-research"
QUERY_CASES = {
    "arxiv": ("protein structure machine learning", "climate change population health"),
    "cbioportal": ("TP53", "lung"),
    "chebi": ("aspirin", "glucose"),
    "clinvar": ("BRCA1 pathogenic", "CFTR pathogenic"),
    "crossref": ("aspirin cardiovascular randomized trial", "diabetes systematic review"),
    "dailymed": ("metformin", "atorvastatin"),
    "dbsnp": ("rs429358", "rs7903146"),
    "ena": ("breast cancer", "type 2 diabetes"),
    "europe-pmc": ("aspirin cardiovascular prevention", "diabetes precision medicine"),
    "gdc-tcga": ("TCGA-BRCA", "TCGA-LUAD"),
    "hpo": ("hypertension", "epileptic seizure"),
    "interpro": ("protein kinase", "DNA repair"),
    "jaspar": ("TP53", "STAT3"),
    "mesh": ("diabetes mellitus", "essential hypertension"),
    "monarch": ("diabetes mellitus", "epileptic seizure"),
    "mygene": ("BRCA1", "TP53"),
    "myvariant": ("rs429358", "rs7903146"),
    "ncbi-gene": ("BRCA1 human", "TP53 human"),
    "ncbi-geo": ("breast cancer expression", "type 2 diabetes expression"),
    "ncbi-protein": ("BRCA1 human", "TP53 human"),
    "ncbi-taxonomy": ("Homo sapiens", "Mus musculus"),
    "openalex": ("aspirin cardiovascular prevention", "diabetes machine learning"),
    "openfda": ("metformin", "atorvastatin"),
    "pmc": ("aspirin cardiovascular prevention", "diabetes precision medicine"),
    "pride": ("breast cancer proteomics", "diabetes proteomics"),
    "pubchem": ("aspirin", "metformin"),
    "pubmed": ("aspirin cardiovascular prevention", "diabetes precision medicine"),
    "quickgo": ("TP53", "BRCA1"),
    "reactome": ("DNA repair", "insulin signaling"),
    "rxnorm": ("metformin", "atorvastatin"),
    "sra": ("breast cancer RNA sequencing", "diabetes RNA sequencing"),
    "string": ("TP53", "BRCA1"),
    "uniprot": ("TP53 human", "BRCA1 human"),
    "who-gho": ("maternal mortality", "life expectancy"),
    "clinicaltrials-gov": ("metformin type 2 diabetes", "aspirin cardiovascular prevention"),
    "isrctn": ("diabetes", "asthma"),
    "biorxiv": ("10.64898/2026.06.26.734908", "10.64898/2026.01.24.701325"),
    "medrxiv": ("10.1101/2025.08.29.25334726", "10.1101/2025.10.19.25337876"),
    "bindingdb": ("P23219", "P35354"),
    "chembl": ("aspirin", "metformin"),
    "clinpgx-pharmgkb": ("warfarin", "clopidogrel"),
    "gwas-catalog-ebi": ("type 2 diabetes", "breast cancer"),
    "alphafold-db-predicted-protein-structures": ("P38398", "P04637"),
    "emdb-electron-microscopy-data-bank": ("ribosome", "hemoglobin"),
    "encode-encyclopedia-of-dna-elements": ("BRCA1", "TP53"),
    "ensembl": ("BRCA1", "TP53"),
    "gtex-genotype-tissue-expression": ("BRCA1", "TP53"),
    "human-protein-atlas-hpa": ("BRCA1", "TP53"),
    "mousemine-mouse-genome-informatics-intermine-based": ("BRCA1", "TP53"),
    "metabolomics-workbench": ("ST000001", "ST000002"),
    "rcsb-protein-data-bank-pdb": ("4HHB", "1TUP"),
    "ucsc-genome-browser": ("BRCA1", "TP53"),
    "wikipathways": ("insulin", "apoptosis"),
    "iuphar-bps-guide-to-pharmacology": ("BRCA1", "EGFR"),
    "open-targets": ("BRCA1", "TP53"),
    "dgidb": ("TP53", "EGFR"),
    "gnomad": ("BRCA1", "TP53"),
    "openneuro": ("ds000224", "ds000001"),
    "civic": ("BRAF", "EGFR"),
    "human-cell-atlas": (
        "74b6d569-3b11-42ef-b6b1-a0454522b4a0",
        "53c53cd4-8127-4e12-bc7f-8fe1610a715c",
    ),
    "1000-genomes-project": ("PRJEB31736", "PRJNA262923"),
    "archs4": ("kidney", "glioblastoma"),
    "rummageo-geo-gene-set-enrichment-search": ("kidney", "glioblastoma"),
    "sider": ("aspirin", "metformin"),
}


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_connector_audit_server", MCP_ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def traceable(source):
    return (
        isinstance(source, dict)
        and isinstance(source.get("source"), str)
        and bool(source["source"].strip())
        and isinstance(source.get("retrievedAt"), str)
        and bool(source["retrievedAt"].strip())
        and bool(source.get("id") or source.get("url"))
    )


def probe_case(server, source, query, gateway_used):
    started = time.monotonic()
    attempts = 0
    while attempts < 3:
        attempts += 1
        result = server.call_tool("evimed_biomedical_source_search", {
            "source": source,
            "query": query,
            "limit": 2,
        })
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        if result.get("status") in {"success", "warning"} or error.get("retryable") is not True:
            break
        if attempts < 3:
            time.sleep(1 << (attempts - 1))
    elapsed = round((time.monotonic() - started) * 1000)
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    items = data.get("items") if isinstance(data.get("items"), list) else []
    sources = result.get("sources") if isinstance(result.get("sources"), list) else []
    identifiers = sorted({
        str(value)
        for item in items if isinstance(item, dict)
        for value in (item.get("id"), item.get("url"))
        if value
    })
    provenance = data.get("provenance") if isinstance(data.get("provenance"), dict) else {}
    checks = {
        "toolResult": result.get("status") in {"success", "warning"},
        "recordsPresent": len(items) > 0,
        "sourceCountPresent": len(sources) > 0,
        "traceableSources": len(sources) > 0 and all(traceable(item) for item in sources),
        "connectorIdentity": len(sources) > 0 and all(item.get("source") == source for item in sources),
        "requestProvenance": provenance.get("tool") == "evimed_biomedical_source_search"
        and provenance.get("arguments", {}).get("source") == source
        and provenance.get("arguments", {}).get("query") == query,
        "recordIdentifiers": len(identifiers) > 0,
    }
    bundled = source in set(getattr(server.public_sources, "BUNDLED_DATASET_SOURCE_IDS", ()))
    return {
        "query": query,
        "status": result.get("status", "error"),
        "summary": result.get("summary", ""),
        "errorCode": (result.get("error") or {}).get("code") if isinstance(result.get("error"), dict) else None,
        "records": len(items),
        "sources": len(sources),
        "identifiers": identifiers[:10],
        "elapsedMs": elapsed,
        "attempts": attempts,
        "executionRoute": (
            "bundled_verified_dataset" if bundled
            else ("server_allowlisted_gateway" if gateway_used else "direct_audit_only")
        ),
        "checks": checks,
        "pass": all(checks.values()),
    }


def source_result(source, cases, gateway_used):
    identifiers = [set(case["identifiers"]) for case in cases]
    distinct = bool(identifiers[0] and identifiers[1] and identifiers[0] != identifiers[1])
    quality_checks = {
        "twoQueriesExecuted": len(cases) == 2,
        "allCasesPassedContract": all(case["pass"] for case in cases),
        "distinctQueryResults": distinct,
        "controlledProductionRoute": gateway_used and all(
            case.get("executionRoute") in {"server_allowlisted_gateway", "bundled_verified_dataset"}
            for case in cases
        ),
        "runtimeArbitraryEgressNotRequired": gateway_used,
    }
    return {
        "source": source,
        "status": "quality_pass" if all(quality_checks.values()) else "quality_fail",
        "cases": cases,
        "qualityChecks": quality_checks,
        "records": sum(case["records"] for case in cases),
        "sources": sum(case["sources"] for case in cases),
        "elapsedMs": sum(case["elapsedMs"] for case in cases),
    }
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=HERE / "results")
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--require-production-gateway", action="store_true")
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(workspace)
    gateway_url = os.environ.get("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "").strip()
    model_config = os.environ.get("EVIMED_MODEL_CONFIG_FILE", "").strip()
    gateway_used = bool(gateway_url and model_config)
    if args.require_production_gateway and not gateway_used:
        raise SystemExit("production gateway audit requires EVIMED_PUBLIC_SOURCE_GATEWAY_URL and EVIMED_MODEL_CONFIG_FILE")
    server = load_server()
    registry = tuple(server.public_sources.BIOMEDICAL_SOURCE_IDS)
    registry_source = MCP_ROOT / "public_sources.py"
    registry_source_sha256 = hashlib.sha256(registry_source.read_bytes()).hexdigest()
    if set(registry) != set(QUERY_CASES):
        raise SystemExit("connector fixtures do not exactly cover the public connector registry")
    selected = set(args.source)
    if selected - set(registry):
        raise SystemExit("unknown connector selection: %s" % ", ".join(sorted(selected - set(registry))))
    previous = {}
    previous_file = args.output_dir / "connector-probe-v3.json"
    if selected and previous_file.is_file():
        previous_document = json.loads(previous_file.read_text(encoding="utf-8"))
        previous_source_sha256 = previous_document.get("summary", {}).get("registrySourceSha256")
        if previous_source_sha256 != registry_source_sha256:
            raise SystemExit(
                "connector source changed since the prior receipt; rerun the complete connector audit"
            )
        previous = {item["source"]: item for item in previous_document.get("results", [])}
    results = []
    for source in registry:
        if selected and source not in selected:
            if source not in previous:
                raise SystemExit("resume requested but %s has no prior result" % source)
            cases = previous[source]["cases"]
        else:
            cases = [probe_case(server, source, query, gateway_used) for query in QUERY_CASES[source]]
        results.append(source_result(source, cases, gateway_used))
        print(json.dumps({"source": source, "status": results[-1]["status"]}, ensure_ascii=False), flush=True)
    passed = sum(item["status"] == "quality_pass" for item in results)
    if hashlib.sha256(registry_source.read_bytes()).hexdigest() != registry_source_sha256:
        raise SystemExit("public connector registry changed during the audit; no release evidence was written")
    bundled_sources = tuple(getattr(server.public_sources, "BUNDLED_DATASET_SOURCE_IDS", ()))
    bundled_datasets = []
    for source in bundled_sources:
        if source != "sider":
            raise SystemExit("bundled dataset evidence is not implemented for %s" % source)
        dataset = Path(server.public_sources._sider_cache_file()).resolve()
        license_file = dataset.with_name("sider-4.1.LICENSE.json")
        if not license_file.is_file():
            raise SystemExit("SIDER license receipt is unavailable")
        bundled_datasets.append({
            "source": source,
            "path": dataset.relative_to(REPO).as_posix(),
            "bytes": dataset.stat().st_size,
            "sha256": hashlib.sha256(dataset.read_bytes()).hexdigest(),
            "licensePath": license_file.resolve().relative_to(REPO).as_posix(),
        })
    document = {
        "schemaVersion": 3,
        "probedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "summary": {
            "registered": len(registry),
            "registrySha256": hashlib.sha256("\0".join(registry).encode("utf-8")).hexdigest(),
            "registrySourceSha256": registry_source_sha256,
            "qualityPass": passed,
            "qualityFail": len(registry) - passed,
            "queriesExecuted": sum(len(item["cases"]) for item in results),
            "productionRoute": "controlled_connector_routes" if gateway_used else "direct_audit_only",
            "productionRoutes": ["bundled_verified_dataset", "server_allowlisted_gateway"] if gateway_used else ["direct_audit_only"],
            "productionGatewayUsed": gateway_used,
            "directSourceRequests": not gateway_used,
            "runtimeArbitraryEgress": False if gateway_used else None,
            "bundledDatasetSources": list(bundled_sources),
            "bundledDatasets": bundled_datasets,
            "claimBoundary": (
                "This certifies two distinct traceable queries and response-contract quality per connector at the recorded time. "
                "It does not certify every query shape, recall, ranking quality, or future upstream availability."
            ),
        },
        "results": results,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    for filename in ("connector-probe-v2.json", "connector-probe-v3.json"):
        (args.output_dir / filename).write_text(payload, encoding="utf-8")
    raise SystemExit(0 if passed == len(registry) else 1)


if __name__ == "__main__":
    main()
