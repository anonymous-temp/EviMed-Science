#!/usr/bin/env python3
"""Prepare BioXArena tasks for a local held-out evaluation (run ON THE HOST after fetching the raw public task dirs).

BioXArena's test labels are private, so for each selected task 20 % of the PUBLIC training set is carved out as a local test:
  <raw>/<domain>/<task>/public/{train.csv, test.csv, sample_submission.csv, description.md, assets...}   (as shipped)
  -> <out>/<task>/            what the agent sees (mounted as inputs/):
        train.csv             the remaining ~80 % of the public train rows (labelled)
        test.csv              the carved ~20 %, target columns REMOVED
        sample_submission.csv ids of the local test rows with the shipped sample's default value(s)
        description.md        the shipped description, with the sample counts patched
        <assets>              unchanged extra files (e.g. data/expression_counts.npz, cath-domain-seqs.fa)
     <heldout>/<task>/labels.csv   id, target column(s) and `__group` (judge only, never mounted)
     <heldout>/<task>/split.json   how the split was made and the resulting sizes
The shipped public test.csv (official test inputs, labels private) is not given to the agent.

Split methods (spec.split.method; deterministic: random.Random(f"{seed}:{task}"), seed 20261028):
  random        shuffle rows, first 20 % are the local test
  stratified    the same inside every class of spec.split.col
  group         whole groups (spec.split.col, e.g. cell_line) until >= 20 % of rows are held out
  pair_disjoint entities appearing in two columns (spec.split.cols, e.g. two genes) are split into a held-out set H;
                local test = rows with BOTH entities in H, train = rows with NEITHER in H, crossing rows are dropped
                (as the official split of these tasks does); |H| is bisected so test / (test + train) is ~20 %.
Usage: bioxarena_prepare.py --spec data/host-fetch/bioxarena.json --raw /bench/data/bioxarena_raw
                            --out /bench/data/bioxarena --heldout /bench/data/bioxarena_heldout [--task NAME ...]
"""
import argparse
import csv
import json
import random
import re
import shutil
import sys
from pathlib import Path

SEED = 20261028
FRAC = 0.20


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        return r.fieldnames, list(r)


def write_csv(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def split_random(rows, rng):
    idx = list(range(len(rows)))
    rng.shuffle(idx)
    k = round(len(rows) * FRAC)
    return sorted(idx[k:]), sorted(idx[:k]), {}


def split_stratified(rows, rng, col):
    by = {}
    for i, r in enumerate(rows):
        by.setdefault(r[col], []).append(i)
    tr, te = [], []
    for c in sorted(by):
        ids = by[c][:]
        rng.shuffle(ids)
        k = max(1, round(len(ids) * FRAC)) if len(ids) > 1 else 0
        te += ids[:k]
        tr += ids[k:]
    return sorted(tr), sorted(te), {}


def split_group(rows, rng, col):
    by = {}
    for i, r in enumerate(rows):
        by.setdefault(r[col], []).append(i)
    groups = sorted(by)
    rng.shuffle(groups)
    te, want = [], FRAC * len(rows)
    held = []
    for g in groups:
        if len(te) >= want:
            break
        te += by[g]
        held.append(g)
    te_set = set(te)
    tr = [i for i in range(len(rows)) if i not in te_set]
    return sorted(tr), sorted(te), {"held_out_groups": len(held), "groups": len(groups)}


def split_pair_disjoint(rows, rng, cols):
    a, b = cols
    ents = sorted({r[a] for r in rows} | {r[b] for r in rows})
    rng.shuffle(ents)

    def at(k):
        h = set(ents[:k])
        te = [i for i, r in enumerate(rows) if r[a] in h and r[b] in h]
        tr = [i for i, r in enumerate(rows) if r[a] not in h and r[b] not in h]
        return tr, te

    lo, hi = 1, len(ents)
    while lo < hi:
        mid = (lo + hi) // 2
        tr, te = at(mid)
        if len(te) / max(1, len(te) + len(tr)) < FRAC:
            lo = mid + 1
        else:
            hi = mid
    tr, te = at(lo)
    return tr, te, {"entities": len(ents), "held_out_entities": lo, "dropped_crossing_rows": len(rows) - len(tr) - len(te)}


def prepare(spec, raw, out, heldout):
    task = spec["task"]
    pub = Path(raw) / spec["domain"] / task / "public"
    fields, rows = read_csv(pub / "train.csv")
    targets, idc = spec["target_cols"], spec.get("id_col", "id")
    rng = random.Random(f"{SEED}:{task}")
    m = spec["split"]["method"]
    if m == "random":
        tr, te, info = split_random(rows, rng)
    elif m == "stratified":
        tr, te, info = split_stratified(rows, rng, spec["split"]["col"])
    elif m == "group":
        tr, te, info = split_group(rows, rng, spec["split"]["col"])
    elif m == "pair_disjoint":
        tr, te, info = split_pair_disjoint(rows, rng, spec["split"]["cols"])
    else:
        raise ValueError(m)
    od = Path(out) / task
    hd = Path(heldout) / task
    for d in (od, hd):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
    write_csv(od / "train.csv", fields, [rows[i] for i in tr])
    in_fields = [f for f in fields if f not in targets]
    write_csv(od / "test.csv", in_fields, [rows[i] for i in te])
    # sample submission: header and default value(s) as shipped
    sf, srows = read_csv(pub / "sample_submission.csv")
    default = {c: (srows[0].get(c, "") if srows else "") for c in sf}
    write_csv(od / "sample_submission.csv", sf, [{**default, idc: rows[i][idc]} for i in te])
    # judge-only labels
    lab_fields = [idc] + targets + (["__group"] if spec.get("group_col") else [])
    lab = []
    for i in te:
        r = {c: rows[i][c] for c in [idc] + targets}
        if spec.get("group_col"):
            r["__group"] = rows[i][spec["group_col"]]
        lab.append(r)
    write_csv(hd / "labels.csv", lab_fields, lab)
    # description with patched counts
    desc = (pub / "description.md").read_text(encoding="utf-8")
    desc = re.sub(r"(\*\*Training samples\*\*:\s*)[\d,]+", lambda x: f"{x.group(1)}{len(tr):,}", desc)
    desc = re.sub(r"(\*\*Test samples\*\*:\s*)[\d,]+", lambda x: f"{x.group(1)}{len(te):,}", desc)
    desc = re.sub(r"\s*\(\d[\d,]* (?:cell lines|patients|cells)\)", "", desc)
    (od / "description.md").write_text(desc, encoding="utf-8")
    # extra assets
    skip = {"train.csv", "test.csv", "sample_submission.csv", "description.md"}
    for p in sorted(pub.rglob("*")):
        rel = p.relative_to(pub)
        if p.is_file() and not (len(rel.parts) == 1 and rel.name in skip):
            (od / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, od / rel)
    split = {"task": task, "method": m, "seed": SEED, "target_frac": FRAC, "train_rows": len(tr), "test_rows": len(te),
             "shipped_train_rows": len(rows), **info}
    (hd / "split.json").write_text(json.dumps(split, indent=1), encoding="utf-8")
    return split


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--heldout", required=True)
    ap.add_argument("--task", action="append")
    a = ap.parse_args()
    tasks = json.load(open(a.spec))["tasks"]
    for t in tasks:
        if a.task and t["task"] not in a.task:
            continue
        print(json.dumps(prepare(t, a.raw, a.out, a.heldout)))


if __name__ == "__main__":
    main()
