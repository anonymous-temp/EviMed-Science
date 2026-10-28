#!/usr/bin/env python3 -I
"""Build items/bixbench.jsonl (12 capsules, all their questions in ONE item) + data/host-fetch/bixbench.json.

Source: HF futurehouse/BixBench (v1.5 question set, 205 questions in 59 capsules). Nothing is downloaded here:
file lists come from the zips' central directories (tools/bix_zip_index.py), sha256 from the HF tree API.
Eligibility: unzipped CapsuleData <= 250 MB (and zip <= 250 MB), >= 3 questions, one capsule per data family.
Strata (primary topic, seed 20261028): imaging 2, other-stats 2, variant 1, epigenomics 1, functional/ML 2, transcriptomics 4.
The CapsuleNotebook-*/ folder of every zip holds the executed analysis (the answers): it is NEVER extracted.
"""
import os
import collections, hashlib, json, random, re
from pathlib import Path

ROOT = Path(os.environ.get('BENCH_ROOT', '.')).resolve()
SEED = 20261028
META = ROOT / "data/bixbench_meta"
rows = [json.loads(l) for l in open(META / "BixBench.jsonl", encoding="utf-8")]
idx = json.load(open(META / "zip_index.json"))
lfs = json.load(open(META / "zip_lfs.json"))
hf = json.load(open(META / "hf_sizes.json"))

caps = collections.defaultdict(list)
for r in rows:
    caps[r["data_folder"]].append(r)


def topic(cats):
    s = " ".join(cats) if isinstance(cats, list) else cats
    if "Imaging" in s:
        return "imaging"
    if "Genomic Variant" in s:
        return "variant"
    if "Epigenomics" in s:
        return "epigenomics"
    if "Functional Genomics" in s or "Machine Learning" in s:
        return "functional_ml"
    if s.strip() == "Other":
        return "other_stats"
    return "transcriptomics"


info = {}
for c, qs in caps.items():
    if c not in idx:
        continue
    ents = [e for e in idx[c]["entries"] if e["name"].startswith("CapsuleData-") and not e["name"].endswith("/")]
    un = sum(e["size"] for e in ents)
    sig = hashlib.sha1("|".join(sorted(e["name"].split("/", 1)[1] + str(e["size"]) for e in ents)).encode()).hexdigest()[:8]
    info[c] = {"qs": sorted(qs, key=lambda r: r["question_id"]), "ents": ents, "un": un, "sig": sig,
               "topic": topic(qs[0]["categories"]), "zip": idx[c]["zip_bytes"]}

eligible = [c for c, i in info.items() if i["un"] <= 250e6 and i["zip"] <= 250e6 and len(i["qs"]) >= 3]
rng = random.Random(SEED)
quota = {"imaging": 2, "other_stats": 2, "variant": 1, "epigenomics": 1, "functional_ml": 2, "transcriptomics": 4}
chosen, fam_used = [], set()
for t, n in quota.items():
    pool = sorted(c for c in eligible if info[c]["topic"] == t)
    rng.shuffle(pool)
    got = 0
    for c in pool:
        if info[c]["sig"] in fam_used:
            continue
        chosen.append(c)
        fam_used.add(info[c]["sig"])
        got += 1
        if got == n:
            break
    assert got == n, (t, got)
chosen.sort(key=lambda c: info[c]["qs"][0]["short_id"])
shorts = [info[c]["qs"][0]["short_id"] for c in chosen]
assert len(set(shorts)) == 12

LINE = 'End with a final section that starts with a line "Final answers:" followed by one numbered line per question: <number>. <answer>'
items, manifest = [], []
for c in chosen:
    i = info[c]
    short = i["qs"][0]["short_id"]
    uuid = i["qs"][0]["capsule_uuid"]
    prefix = f"CapsuleData-{uuid}/"
    qtxt = "\n\n".join(f"{n}. {q['question'].strip()}" for n, q in enumerate(i["qs"], 1))
    prompt = ("The data for this analysis is in the workspace folder inputs/. "
              "Answer the numbered questions below using that data.\n\n" + qtxt + "\n\n" + LINE)
    files = [{"src": f"/bench/data/bixbench/{short}/{e['name'][len(prefix):]}", "dest": f"inputs/{e['name'][len(prefix):]}"}
             for e in sorted(i["ents"], key=lambda e: e["name"])]
    gq = []
    for n, q in enumerate(i["qs"], 1):
        rg = None
        if q["eval_mode"] == "range_verifier":
            m = re.fullmatch(r"\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)", q["ideal"].strip())
            rg = [float(m.group(1)), float(m.group(2))] if m else None
        gq.append({"n": n, "qid": q["question_id"], "question": q["question"].strip(), "ideal": q["ideal"],
                   "eval_mode": q["eval_mode"], "range": rg, "distractors": q["distractors"]})
    items.append({
        "key": f"bixbench/{short}", "bench": "bixbench", "id": short, "group": f"bixbench-{short}", "prompt": prompt,
        "line": None, "timeoutMin": 40, "files": files, "deleteGroupAfter": True,
        "gold": {"questions": gq, "hypothesis": i["qs"][0]["hypothesis"], "paper": i["qs"][0]["paper"]},
        "scorer": "claude-open",
        "meta": {"short_id": short, "capsule_uuid": uuid, "topic": i["topic"], "n_questions": len(gq),
                 "categories": i["qs"][0]["categories"], "n_files": len(files), "data_bytes": i["un"], "zip_bytes": i["zip"],
                 "eval_modes": dict(collections.Counter(q["eval_mode"] for q in i["qs"]))},
    })
    zipname = f"CapsuleFolder-{uuid}.zip"
    manifest.append({
        "short_id": short, "capsule_uuid": uuid, "zip": zipname,
        "url": f"https://huggingface.co/datasets/futurehouse/BixBench/resolve/{hf['sha']}/{zipname}",
        "bytes": i["zip"], "sha256": lfs[zipname]["sha256"], "unzipped_data_bytes": i["un"],
        "target_dir": f"/bench/data/bixbench/{short}/",
        "extract": f"unzip -q -o {zipname} 'CapsuleData-{uuid}/*' -d _tmp && mv _tmp/CapsuleData-{uuid}/* /bench/data/bixbench/{short}/ && rm -rf _tmp",
        "never_extract": f"CapsuleNotebook-{uuid}/ (the executed notebook contains the answers)",
        "files": len(files),
    })
with open(ROOT / "items/bixbench.jsonl", "w", encoding="utf-8") as f:
    for it in items:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
tot_zip = sum(m["bytes"] for m in manifest)
tot_un = sum(m["unzipped_data_bytes"] for m in manifest)
json.dump({"dataset": "futurehouse/BixBench", "revision": hf["sha"], "note":
           "Fetch on the production host only. Download each zip, verify sha256, extract ONLY CapsuleData-<uuid>/ into target_dir "
           "(strip the prefix). Do not extract CapsuleNotebook-*.",
           "total_zip_bytes": tot_zip, "total_unzipped_bytes": tot_un, "capsules": manifest},
          open(ROOT / "data/host-fetch/bixbench.json", "w"), indent=1)
print(len(items), "questions:", sum(m["meta"]["n_questions"] for m in items), "zip MB:", tot_zip / 1e6, "unzipped MB:", tot_un / 1e6)
for m in items:
    print(m["id"], m["meta"]["topic"], m["meta"]["n_questions"], m["meta"]["n_files"], round(m["meta"]["data_bytes"] / 1e6, 1), m["meta"]["eval_modes"])
