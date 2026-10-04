#!/usr/bin/env python3
"""Assemble bibliometric-analysis-run.json from the managed job's own outputs.

The numbers are read out of result.json / search_metadata.json; the artifact list
is built by walking the job's output directory, so nothing is typed from memory.
"""
import hashlib
import json
import os

JOB = "/workspace/bibliometric-analysis-runs/bibliometric-20261004071320-d725e01dbd9b"
OUT = os.path.join(JOB, "output")
DEST = "/workspace/deliverables/glp1-obesity-bibliometric/bibliometric-analysis-run.json"

res = json.load(open(os.path.join(OUT, "result.json"), encoding="utf-8"))
meta = json.load(open(os.path.join(OUT, "data", "search_metadata.json"), encoding="utf-8"))
log = json.load(open(os.path.join(
    "/workspace/bibliometric-analysis-runs/.jobs",
    "bibliometric-20261004071320-d725e01dbd9b.json"), encoding="utf-8"))

arts = []
for root, _dirs, files in os.walk(OUT):
    for f in sorted(files):
        p = os.path.join(root, f)
        rel = os.path.relpath(p, OUT)
        with open(p, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        arts.append({
            "path": rel.replace(os.sep, "/"),
            "bytes": os.path.getsize(p),
            "sha256": digest,
        })
arts.sort(key=lambda a: a["path"])

doc = {
    "deliverable": "bibliometric-analysis-report.md",
    "jobId": "bibliometric-20261004071320-d725e01dbd9b",
    "status": res["status"],
    "contractKind": "bibliometric-analysis-report",
    "managedJob": {
        "id": "bibliometric-20261004071320-d725e01dbd9b",
        "terminalState": res["status"],
        "degraded": res["degraded"],
        "modules": res["modules"],
    },
    "analysisInputs": {
        "topic": res["topic"],
        "dateFrom": meta["date_from"],
        "dateTo": meta["date_to"],
        "maxRecords": meta["max_records"],
        "outputLanguage": "zh-CN",
    },
    "search": {
        "database": "PubMed (MEDLINE), via NCBI E-utilities esearch/efetch",
        "searchedAt": meta["searched_at"],
        "sort": meta["esearch_sort"],
        "formalQuery": meta["search_strategy"]["formal_query"],
        "concepts": meta["search_strategy"]["concepts"],
        "totalFound": meta["total_found"],
        "totalRetrieved": meta["retrieved"],
        "totalFetched": meta["total_fetched"],
        "afterDedup": meta["after_dedup"],
        "truncated": meta["truncated"],
    },
    "corpus": {
        "analysedRecords": res["records"],
        "citationCoverage": res["citationCoverage"],
    },
    "artifactCount": len(arts),
    "artifacts": arts,
    "artifactsRoot": "bibliometric-analysis-runs/bibliometric-20261004071320-d725e01dbd9b/output",
}
if log:
    doc["managedJob"]["recordedStatus"] = log.get("status")
    doc["managedJob"]["updatedAt"] = log.get("updatedAt") or log.get("updated_at")
    doc["managedJob"]["startedAt"] = log.get("startedAt") or log.get("started_at")

with open(DEST, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, ensure_ascii=False, indent=2)
print("artifacts:", len(arts))
print("terminal:", res["status"], "| degraded:", res["degraded"])
print(json.dumps(arts[:6], ensure_ascii=False, indent=1))
