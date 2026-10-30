#!/usr/bin/env python3 -I
"""Build items/researchclawbench.jsonl (8 tasks) + data/host-fetch/researchclawbench.json (+ judge-only rubric images).

Source: HF InternScience/ResearchClawBench (MIT), tasks/<Domain>_<nnn>/ {task_info.json, data/, related_work/, target_study/}.
The dataset has 8 Life + 5 Neuroscience tasks (13). Baseline v1 uses 4 + 4: excluded as not CPU/E2E-feasible in the hosted
runtime are Life_003 (nanopore FAST5/POD5 alignment, uncalled4), Life_004 (BEAST-style phylogeography), Neuroscience_001 (deep
mechanistic network with PyTorch checkpoints); Life_005 and Life_007 are tiny theory tasks left out to keep wet/dry-lab variety;
the rest is taken in index order within each domain.
target_study/ (paper, rubric, answer images) is NEVER listed in `files`; only the rubric (checklist.json) and the images it
references are kept, in data/rcb_judge/<task>/ for the judge.
"""
import os
import json, urllib.request, urllib.parse
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
META = ROOT / "data/rcb_meta"
SEL = ["Life_000", "Life_001", "Life_002", "Life_006", "Neuroscience_000", "Neuroscience_002", "Neuroscience_003", "Neuroscience_004"]
REV = "fa82414b2ead64ea3a4df2c0688512198c42ba59"
BASE = f"https://huggingface.co/datasets/InternScience/ResearchClawBench/resolve/{REV}/"
tree = json.load(open(META / "tree.json"))

items, manifest = [], []
for d in SEL:
    ti = json.load(open(META / d / "task_info.json"))
    cl = json.load(open(META / d / "checklist.json"))
    fs = tree[d]
    dfiles = sorted([f for f in fs if "/data/" in f["path"]], key=lambda f: f["path"])
    rfiles = sorted([f for f in fs if "/related_work/" in f["path"]], key=lambda f: f["path"])
    pref = f"tasks/{d}/"
    lines = []
    for e in ti["data"]:
        p = e["path"].lstrip("./")
        lines.append(f"- inputs/{p}: {e.get('name', '')}. {e.get('description', '')}".rstrip())
    prompt = (ti["task"].strip() + "\n\nData files (read-only, under inputs/data/):\n" + "\n".join(lines) +
              "\n\nRelated papers are in inputs/related_work/.\n\n"
              "Carry the research through end to end: write your code in code/, intermediate results in outputs/, and the final "
              "research report to report/report.md (methodology, results with figures, discussion). Save every figure as a PNG in "
              "report/images/ and reference it in the report with a relative path such as images/figure_name.png.")
    files = []
    for f in dfiles + rfiles:
        rel = f["path"][len(pref):]
        files.append({"src": f"/bench/data/researchclawbench/{d}/{rel}", "dest": f"inputs/{rel}"})
    # judge-only material: rubric + referenced images
    jdir = ROOT / "data/rcb_judge" / d
    (jdir / "images").mkdir(parents=True, exist_ok=True)
    (jdir / "checklist.json").write_text(json.dumps(cl, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in cl:
        if c.get("path"):
            rel = c["path"].lstrip("./")
            out = jdir / rel
            if not out.exists():
                url = BASE + urllib.parse.quote(f"tasks/{d}/target_study/{rel}")
                out.write_bytes(urllib.request.urlopen(url, timeout=120).read())
    items.append({
        "key": f"researchclawbench/{d}", "bench": "researchclawbench", "id": d, "group": f"researchclawbench-{d}",
        "prompt": prompt, "line": None, "timeoutMin": 60, "files": files, "deleteGroupAfter": True,
        "gold": {"rubric": f"/bench/data/rcb_judge/{d}/checklist.json", "images_dir": f"/bench/data/rcb_judge/{d}/images/",
                 "report_path": "report/report.md", "task": ti["task"]},
        "scorer": "claude-rubric",
        "meta": {"domain": d.split("_")[0], "task": d, "n_data_files": len(dfiles), "n_related_work": len(rfiles),
                 "data_bytes": sum(f["size"] for f in dfiles), "related_work_bytes": sum(f["size"] for f in rfiles),
                 "rubric_items": len(cl), "rubric_text": sum(c["type"] == "text" for c in cl),
                 "rubric_image": sum(c["type"] == "image" for c in cl)},
    })
    manifest.append({
        "task": d, "target_root": f"/bench/data/researchclawbench/{d}/",
        "files": [{"path": f["path"][len(pref):], "url": BASE + urllib.parse.quote(f["path"]), "bytes": f["size"],
                   "sha256": f.get("sha256")} for f in dfiles + rfiles],
    })
with open(ROOT / "items/researchclawbench.jsonl", "w", encoding="utf-8") as f:
    for it in items:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
tot = sum(x["bytes"] for m in manifest for x in m["files"])
json.dump({"dataset": "InternScience/ResearchClawBench", "revision": REV,
           "note": "Fetch on the production host only: data/ and related_work/ of the 8 tasks. target_study/ must never be placed where an agent can read it. "
                   "sha256 is the HF LFS oid where the file is LFS-stored (null otherwise: check the byte size).",
           "total_bytes": tot, "tasks": manifest}, open(ROOT / "data/host-fetch/researchclawbench.json", "w"), indent=1)
print(len(items), "tasks; fetch MB:", round(tot / 1e6, 1))
for it in items:
    m = it["meta"]
    print(it["id"], m["n_data_files"], round(m["data_bytes"] / 1e6, 1), m["n_related_work"], round(m["related_work_bytes"] / 1e6, 1), m["rubric_items"])
