#!/usr/bin/env python3 -I
"""Build items/bioxarena.jsonl (6 tasks, 6 domains) + data/host-fetch/bioxarena.json (task specs + fetch commands).

Source: HF mbzuai-ai4bio/BioXArena-Data-Public (CC-BY-NC-4.0; revision 3787cf1f, release 2026-10-07 "corrected data").
Only per-DOMAIN archives exist besides the 48.9 GB full tarball, so the host fetches a domain archive as a STREAM and keeps only the
selected task directory (`curl ... | tar -xz --wildcards '<domain>/<task>/*'`): no archive is stored.
Tasks (all small, CPU-feasible, one per domain; sizes are the unpacked public/ dir): see TASKS.
Local evaluation: tools/bioxarena_prepare.py carves ~20 % of the public train rows as a local test (labels held out).
"""
import os
import json
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
REV = "3787cf1f6eb217d09a109e0baca0cb7e15298b30"
HF = f"https://huggingface.co/datasets/mbzuai-ai4bio/BioXArena-Data-Public/resolve/{REV}/Data-Public-by-Domain/"
manifest_txt = (ROOT / "data/bioxarena_meta/MANIFEST.txt").read_text()
import re
arch = {}
for m in re.finditer(r"■ (\S+)\s+\[([\d.]+) (MB|GB), \d+ tasks\]\s+sha256=([0-9a-f]{64})", manifest_txt):
    name, size, unit, sha = m.groups()
    arch[name.split("-")[0] if name.startswith(("chemical", "network", "perturbation", "phenotype", "sequence", "single", "text", "imaging", "structure")) else name] = (name, float(size) * (1e6 if unit == "MB" else 1e9), sha)
# archive names: chemical-biology-8tasks-all.tar.gz etc. -> key by domain
def archive_for(domain):
    for name, size, sha in arch.values():
        if name.startswith(domain.split("-")[0]):
            return name, size, sha
    raise KeyError(domain)

TASKS = [
    {"domain": "chemical-biology", "task": "egfr-binding-affinity", "title": "EGFR binding affinity regression (SMILES -> pChEMBL)",
     "id_col": "id", "target_cols": ["affinity"], "metric": "pearson", "split": {"method": "random"},
     "split_caveat": "official split is by Taylor-Butina structural cluster; the local split is random, so analogues leak and scores are optimistic",
     "unpacked_bytes": 729008},
    {"domain": "network-biology", "task": "synthetic-lethality-prediction", "title": "Synthetic lethality of gene pairs",
     "id_col": "id", "target_cols": ["label"], "metric": "roc_auc", "split": {"method": "pair_disjoint", "cols": ["gene_a_id", "gene_b_id"]},
     "unpacked_bytes": 17111310},
    {"domain": "sequence", "task": "remote-homology-detection", "title": "Remote homology: TM-score of CATH domain pairs from sequence",
     "id_col": "id", "target_cols": ["tm_max"], "metric": "spearman", "split": {"method": "pair_disjoint", "cols": ["chain_1", "chain_2"]},
     "split_caveat": "official split holds out MMseqs2 clusters (30 % identity); the local split holds out whole domains only, so it is easier",
     "unpacked_bytes": 5882127},
    {"domain": "perturbation-dynamics", "task": "cancer-drug-sensitivity", "title": "Cancer drug sensitivity (ln IC50) for unseen cell lines",
     "id_col": "id", "target_cols": ["ln_ic50"], "metric": "mean_within_group_spearman", "group_col": "drug_id",
     "split": {"method": "group", "col": "cell_line"}, "unpacked_bytes": 26476192},
    {"domain": "phenotype-disease", "task": "breast-cancer-subtype", "title": "Breast cancer molecular subtype (METABRIC)",
     "id_col": "id", "target_cols": ["subtype"], "metric": "macro_f1", "split": {"method": "stratified", "col": "subtype"},
     "unpacked_bytes": 3167346},
    {"domain": "single-cell", "task": "cell-type-from-expression", "title": "Cell type from 30-transcript expression profiles",
     "id_col": "id", "target_cols": ["cell_type"], "metric": "accuracy", "split": {"method": "stratified", "col": "cell_type"},
     "unpacked_bytes": 354061},
]
LINE = ("Read inputs/description.md first. Train a model on inputs/train.csv and write your predictions for every row of "
        "inputs/test.csv to outputs/submission.csv in the format of inputs/sample_submission.csv.")

items, tasks_out, fetch = [], [], {}
for t in TASKS:
    name, size, sha = archive_for(t["domain"])
    fetch.setdefault(name, {"url": HF + name, "bytes": int(size), "sha256": sha, "domain": t["domain"], "tasks": []})["tasks"].append(t["task"])
    inv = json.load(open(ROOT / f"data/bioxarena_meta/inv/{t['domain']}/{t['task']}/inventory.json"))
    skip = {"public/train.csv", "public/test.csv", "public/sample_submission.csv", "public/description.md"}
    assets = [x["name"][len("public/"):] for x in inv if x["name"] not in skip]
    files = [{"src": f"/bench/data/bioxarena/{t['task']}/{n}", "dest": f"inputs/{n}"}
             for n in ["train.csv", "test.csv", "sample_submission.csv", "description.md"] + assets]
    items.append({
        "key": f"bioxarena/{t['task']}", "bench": "bioxarena", "id": t["task"], "group": f"bioxarena-{t['task']}", "prompt": LINE,
        "line": None, "timeoutMin": 60, "files": files, "deleteGroupAfter": True,
        "gold": {"labels": f"/bench/data/bioxarena_heldout/{t['task']}/labels.csv", "metric": t["metric"],
                 "target_cols": t["target_cols"], "id_col": t["id_col"], "group_col": t.get("group_col"),
                 "prediction_file": "outputs/submission.csv"},
        "scorer": "bioxarena-metric",
        "meta": {"domain": t["domain"], "task": t["task"], "title": t["title"], "metric": t["metric"],
                 "split": t["split"], "split_caveat": t.get("split_caveat")},
    })
    tasks_out.append({**t, "assets": assets, "public_files": inv})
with open(ROOT / "items/bioxarena.jsonl", "w", encoding="utf-8") as f:
    for it in items:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
for a in fetch.values():
    a["extract"] = (f"curl -sSL --fail '{a['url']}' | tar -xzf - -C /bench/data/bioxarena_raw --wildcards " +
                    " ".join(f"'{a['domain']}/{k}/*'" for k in a["tasks"]))
json.dump({
    "dataset": "mbzuai-ai4bio/BioXArena-Data-Public", "revision": REV, "license": "CC-BY-NC-4.0",
    "note": ("Fetch on the production host only. Per-domain archives are STREAMED through tar and only the listed task dirs are kept "
             "(raw tasks land in /bench/data/bioxarena_raw/<domain>/<task>/public/); stream total = sum of archive bytes below "
             "(no archive is stored). Add `| tee >(sha256sum > <name>.sha)` before `| tar` to verify against `sha256`. Then run: "
             "python3 tools/bioxarena_prepare.py --spec data/host-fetch/bioxarena.json --raw /bench/data/bioxarena_raw "
             "--out /bench/data/bioxarena --heldout /bench/data/bioxarena_heldout"),
    "stream_total_bytes": sum(a["bytes"] for a in fetch.values()),
    "unpacked_total_bytes": sum(t["unpacked_bytes"] for t in TASKS),
    "archives": list(fetch.values()), "tasks": tasks_out}, open(ROOT / "data/host-fetch/bioxarena.json", "w"), indent=1)
print(len(items), "tasks; stream GB:", round(sum(a["bytes"] for a in fetch.values()) / 1e9, 2), "unpacked MB:", round(sum(t["unpacked_bytes"] for t in TASKS) / 1e6, 1))
for a in fetch.values():
    print(a["extract"][:230])
