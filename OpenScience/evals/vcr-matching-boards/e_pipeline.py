"""Board E, the plugin's hybrid first stage on a whole TREC collection: lexical lists, dense lists, fusion, the age/sex filter, recall.

The lexical branch is the product's own FTS5/BM25 search over the model-written search (condition and ranked phrases), saved per topic
by `retrieve_e.mjs`. The dense branch is exact cosine search over the plugin's Qwen3.7 vectors (`embed_corpus.mjs`). Fusion is reciprocal
rank fusion over named lists. The filter drops a trial whose registry age range or sex excludes the age and sex the model read in the
record (the product's rule: a trial that states nothing is kept). Labels are read only by `recall`.

    python3 -I -B e_pipeline.py queries --notes <notes.jsonl> --plans <dir>... --out <queries.jsonl>
    python3 -I -B e_pipeline.py dense --queries <queries.f16> --corpus 2021=<dir> 2023=<dir> --out <dense.jsonl> [--depth 1000]
    python3 -I -B e_pipeline.py fuse --recipe <name> --lists <lists.jsonl>... --collections 2021=<dir> 2023=<dir> --out <fused.jsonl>
    python3 -I -B e_pipeline.py recall --qrels-dir <dir> --run <name>=<fused.jsonl>... --split <split_e.json> --set dev|test|all
"""
import argparse
import json
import re
import sqlite3
import statistics as st
import zlib
from pathlib import Path

import numpy as np

QUERY_INSTRUCTION = "Instruct: Given a patient's clinical record, retrieve clinical trials the patient could enrol in\nQuery: "


def jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def year_of(topic):
    return 2023 if topic.startswith("trec-2023-") else int(topic[5:9])


def corpus_of(topic):
    return "2023" if year_of(topic) == 2023 else "2021"


def plans(dirs):
    out = {}
    for d in dirs:
        for f in Path(d).glob("*.plan.json"):
            p = json.loads(f.read_text())
            out[p["topic"]] = p["request"]
    return out


def lexical(dirs):
    out = {}
    for d in dirs:
        for f in Path(d).glob("*.list.json"):
            p = json.loads(f.read_text())
            out[p["topic"]] = p["ids"]
    return out


def cmd_queries(a):
    req = plans(a.plans)
    rows = []
    for n in jsonl(a.notes):
        r = req.get(n["id"])
        if not r:
            continue
        rows.append({"id": f"{n['id']}|note", "text": n["note"]})
        rows.append({"id": f"{n['id']}|inst", "text": QUERY_INSTRUCTION + n["note"]})
        rows.append({"id": f"{n['id']}|summary", "text": QUERY_INSTRUCTION + (r.get("summary") or n["note"])})
        rows.append({"id": f"{n['id']}|terms", "text": QUERY_INSTRUCTION + "; ".join([r.get("condition") or ""] + list(r.get("terms") or []))})
        # what the V3 discovery embeds: the focused condition, then the patient's passages, no instruction
        rows.append({"id": f"{n['id']}|v3", "text": ((r.get("condition") or "") + "\n" + n["note"])[:8000]})
        rows.append({"id": f"{n['id']}|v3inst", "text": QUERY_INSTRUCTION + ((r.get("condition") or "") + "\n" + n["note"])[:8000]})
    Path(a.out).write_text("".join(json.dumps(r) + "\n" for r in rows))
    print(len(rows), "query texts")


def cmd_dense(a):
    qids = Path(a.queries + ".ids").read_text().split()
    q = np.fromfile(a.queries, dtype=np.float16).reshape(len(qids), -1).astype(np.float32)
    corpora = dict(x.split("=", 1) for x in a.corpus)
    out = []
    for key, directory in corpora.items():
        ids = Path(directory, "ids.txt").read_text().split()
        v = np.memmap(Path(directory, "vectors.f16"), dtype=np.float16, mode="r").reshape(len(ids), -1)
        rows = [i for i, qid in enumerate(qids) if corpus_of(qid.split("|")[0]) == key]
        if not rows:
            continue
        qq = q[rows]
        best_s = np.full((len(rows), 0), -1.0, dtype=np.float32)
        best_i = np.zeros((len(rows), 0), dtype=np.int64)
        step = 40000
        for start in range(0, len(ids), step):
            block = np.asarray(v[start:start + step], dtype=np.float32)
            s = qq @ block.T
            k = min(a.depth, s.shape[1])
            part = np.argpartition(-s, k - 1, axis=1)[:, :k]
            ps = np.take_along_axis(s, part, axis=1)
            best_s = np.concatenate([best_s, ps], axis=1)
            best_i = np.concatenate([best_i, part + start], axis=1)
            if best_s.shape[1] > a.depth:
                keep = np.argpartition(-best_s, a.depth - 1, axis=1)[:, :a.depth]
                best_s = np.take_along_axis(best_s, keep, axis=1)
                best_i = np.take_along_axis(best_i, keep, axis=1)
        for r, qrow in enumerate(rows):
            order = np.argsort(-best_s[r], kind="stable")
            topic, variant = qids[qrow].split("|")
            out.append({"topic": topic, "list": f"dense-{variant}", "ids": [ids[best_i[r][j]] for j in order], "scores": [round(float(best_s[r][j]), 5) for j in order]})
        print(f"[dense] corpus {key}: {len(ids)} trials, {len(rows)} queries")
    Path(a.out).write_text("".join(json.dumps(r) + "\n" for r in out))


AGE = re.compile(r"(\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute)", re.I)
UNIT = {"year": 1, "month": 1 / 12, "week": 1 / 52.18, "day": 1 / 365.25, "hour": 1 / 8766, "minute": 1 / 525960}


def age_years(text):
    m = AGE.search(text or "")
    return float(m.group(1)) * UNIT[m.group(2).lower()] if m else None


class Demographics:
    def __init__(self, collections):
        self.db = {}
        for key, directory in collections.items():
            manifest = json.loads(Path(directory, "collection.json").read_text())
            self.db[key] = sqlite3.connect(f"file:{Path(directory) / manifest['databasePath']}?mode=ro", uri=True)
        self.cache = {}

    def trial(self, key, nct):
        if (key, nct) not in self.cache:
            row = self.db[key].execute("SELECT payload FROM documents WHERE nct_id=?", (nct,)).fetchone()
            d = json.loads(zlib.decompress(row[0])) if row else {}
            self.cache[(key, nct)] = (age_years(d.get("minimum_age")), age_years(d.get("maximum_age")), (d.get("gender") or "").lower())
        return self.cache[(key, nct)]

    def admits(self, key, nct, age, sex):
        lo, hi, gender = self.trial(key, nct)
        if age is not None and ((lo is not None and age < lo) or (hi is not None and age > hi)):
            return False
        if sex in ("male", "female") and gender in ("male", "female") and gender != sex:
            return False
        return True


def cmd_fuse(a):
    req = plans(a.plans)
    lists = {}
    for path in a.lists:
        for row in jsonl(path):
            lists.setdefault(row["topic"], {})[row["list"]] = row["ids"]
    for topic, ids in lexical(a.plans).items():
        lists.setdefault(topic, {})["lexical"] = ids
    names = a.recipe.split("+")
    weights = {}
    for name in names:
        base, _, w = name.partition("*")
        weights[base] = float(w or 1)
    demo = Demographics(dict(x.split("=", 1) for x in a.collections)) if a.filter else None
    out = []
    for topic, have in sorted(lists.items()):
        if not all(n in have for n in weights):
            continue
        score = {}
        for name, w in weights.items():
            for rank, nct in enumerate(have[name][:a.per_list]):
                score[nct] = score.get(nct, 0.0) + w / (a.k + rank + 1)
        ranked = sorted(score, key=lambda t: (-score[t], t))
        if demo:
            r = req.get(topic, {})
            age, sex = r.get("age"), (r.get("sex") or "").lower()
            ranked = [t for t in ranked if demo.admits(corpus_of(topic), t, age, sex)]
        out.append({"topic": topic, "recipe": a.recipe, "ids": ranked[:a.depth]})
    Path(a.out).write_text("".join(json.dumps(r) + "\n" for r in out))
    print(f"[fuse] {a.recipe}: {len(out)} topics")


def qrels(directory):
    q = {}
    for year in (2021, 2022, 2023):
        for line in Path(directory, f"qrels{year}.txt").read_text().splitlines():
            p = line.split()
            if len(p) >= 4:
                topic = f"trec-2023-{p[0]}" if year == 2023 else f"trec-{year}{p[0]}"
                q.setdefault(topic, {})[p[2]] = int(p[3])
    return q


def cmd_recall(a):
    q = qrels(a.qrels_dir)
    split = json.loads(Path(a.split).read_text())
    chosen = set()
    for s in (("dev", "test") if a.set == "all" else (a.set,)):
        for ids in split[s].values():
            chosen.update(ids)
    depths = (10, 50, 100, 200, 300, 500, 1000)
    for spec in a.run:
        name, path = spec.split("=", 1)
        per = {}
        for row in jsonl(path):
            t = row["topic"]
            if t not in chosen or t not in q:
                continue
            truth = q[t]
            elig = {d for d, g in truth.items() if g == 2}
            rel = {d for d, g in truth.items() if g >= 1}
            y = year_of(t)
            for d in depths:
                top = set(row["ids"][:d])
                if elig:
                    per.setdefault((y, "E", d), []).append(len(top & elig) / len(elig))
                if rel:
                    per.setdefault((y, "R", d), []).append(len(top & rel) / len(rel))
        for kind in ("E", "R"):
            line = f"{name:34} {'eligible' if kind == 'E' else 'relevant'}"
            for y in (2021, 2022, 2023):
                vals = [f"{st.fmean(per[(y, kind, d)]):.3f}" if per.get((y, kind, d)) else "  -  " for d in depths]
                line += f" | {y}: " + " ".join(vals)
            print(line)
    print("depths", depths)


def cmd_board(a):
    """Board E candidate lists in Board A's layout, so the Jev, rerank and fit runners answer them unchanged: one cohort per year
    (cases.jsonl with the topic's note and its first --top fused candidates) and a collections/ directory linking the two TREC indexes."""
    notes = {n["id"]: n for n in jsonl(a.notes)}
    split = json.loads(Path(a.split).read_text())
    side = {t: s for s in ("dev", "test") for ids in split[s].values() for t in ids}
    out = Path(a.out)
    (out / "collections").mkdir(parents=True, exist_ok=True)
    for key, directory in (x.split("=", 1) for x in a.collections):
        link = out / "collections" / f"index{key}"
        if not link.exists():
            link.symlink_to(Path(directory).resolve())
    by_year = {}
    for row in jsonl(a.fused):
        t = row["topic"]
        if t not in notes:
            continue
        by_year.setdefault(year_of(t), []).append({"patientId": t, "caseId": t, "cohort": f"trec_{year_of(t)}", "note": notes[t]["note"],
            "candidateIds": row["ids"][:a.top], "candidateCount": min(a.top, len(row["ids"])), "collection": f"index{corpus_of(t)}", "split": side.get(t, "unscorable")})
    for year, cases in by_year.items():
        d = out / f"E-{year}"
        d.mkdir(exist_ok=True)
        (d / "cases.jsonl").write_text("".join(json.dumps(c) + "\n" for c in cases))
        print(f"[board] E-{year}: {len(cases)} topics, {sum(len(c['candidateIds']) for c in cases)} pairs")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("queries"); s.add_argument("--notes", required=True); s.add_argument("--plans", nargs="+", required=True); s.add_argument("--out", required=True)
    s = sub.add_parser("dense"); s.add_argument("--queries", required=True); s.add_argument("--corpus", nargs="+", required=True); s.add_argument("--out", required=True); s.add_argument("--depth", type=int, default=1000)
    s = sub.add_parser("fuse"); s.add_argument("--recipe", required=True); s.add_argument("--lists", nargs="*", default=[]); s.add_argument("--plans", nargs="+", required=True)
    s.add_argument("--collections", nargs="+", default=[]); s.add_argument("--out", required=True); s.add_argument("--k", type=int, default=60)
    s.add_argument("--per-list", type=int, default=1000); s.add_argument("--depth", type=int, default=1000); s.add_argument("--filter", action="store_true")
    s = sub.add_parser("recall"); s.add_argument("--qrels-dir", required=True); s.add_argument("--run", nargs="+", required=True); s.add_argument("--split", required=True); s.add_argument("--set", default="dev")
    s = sub.add_parser("board"); s.add_argument("--fused", required=True); s.add_argument("--notes", required=True); s.add_argument("--split", required=True)
    s.add_argument("--collections", nargs="+", required=True); s.add_argument("--out", required=True); s.add_argument("--top", type=int, default=300)
    a = p.parse_args()
    {"board": cmd_board, "queries": cmd_queries, "dense": cmd_dense, "fuse": cmd_fuse, "recall": cmd_recall}[a.cmd](a)


if __name__ == "__main__":
    main()
