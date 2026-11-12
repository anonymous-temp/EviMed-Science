"""Prepare label-free platform inputs and a pinned TrialGPT trial collection.

The operator supplies the previously acquired public seven-field inputs and
official SIGIR corpus. The SQLite index contains trial text only. Reference
geometry is saved outside model-inputs; no answer labels are consumed here.
"""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import zlib

FIELDS = {"annotation_id", "patient_id", "note", "trial_id", "trial_title", "criterion_type", "criterion_text"}
PIN = "1b3242cd50c153a9c324661d4a0bd94fc68a4226"
INPUT_SHA = "b01f6acfd40801392f8cf0f753edd973e5a658d79e0dcd47e5a49da1fd3488c7"
CORPUS_SHA = "4b430f25e1557d188017f9a2eeac20905a32fd9862cbd74fa7e8ca6cbf6836d4"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def prepare(inputs, corpus, out):
    input_bytes, corpus_bytes = inputs.read_bytes(), corpus.read_bytes()
    if sha(input_bytes) != INPUT_SHA or sha(corpus_bytes) != CORPUS_SHA:
        raise ValueError("Input bytes do not match the verified public acquisition")
    if out.exists():
        raise FileExistsError("Prepared campaign already exists")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=out.parent) as temporary:
        stage = Path(temporary) / "output"
        result = build(input_bytes, corpus_bytes, stage, out)
        stage.rename(out)
        return result


def build(input_bytes, corpus_bytes, out, published):
    rows = json.loads(input_bytes)
    if len(rows) != 1015 or any(set(row) != FIELDS for row in rows):
        raise ValueError("Require the 1015 original seven-field public inputs, with no answer columns")
    if len({row["annotation_id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate annotation IDs")
    out.mkdir(parents=True, exist_ok=False)
    dbfile = out / "sigir.sqlite"
    db = sqlite3.connect(dbfile)
    trials = {}
    try:
        db.executescript("""CREATE TABLE documents(id INTEGER PRIMARY KEY,nct_id TEXT UNIQUE,
            xml_sha256 TEXT,payload_sha256 TEXT,payload BLOB,archive TEXT);
            CREATE VIRTUAL TABLE terms USING fts5(title,condition,summary,description,eligibility,
                content='',tokenize='porter unicode61');""")
        for raw in corpus_bytes.splitlines(keepends=True):
                row = json.loads(raw)
                ident, meta = row["_id"], row["metadata"]
                if not re.fullmatch(r"NCT\d{8}", ident) or ident in trials:
                    raise ValueError("Invalid or duplicate corpus identity")
                inclusion, exclusion = meta["inclusion_criteria"], meta["exclusion_criteria"]
                separator = "\n\nExclusion Criteria:\n"
                eligibility = inclusion + separator + exclusion
                payload = {"nct_id": ident, "title": meta["brief_title"],
                    "condition": "\n".join(meta.get("diseases_list", [])),
                    "summary": meta.get("brief_summary", ""), "detailed_description": "",
                    "eligibility": eligibility, "phase": meta.get("phase", ""),
                    "interventions": "\n".join(meta.get("drugs_list", [])),
                    "overall_status": "", "gender": "", "minimum_age": "", "maximum_age": "",
                    "source_sha256": sha(raw), "source_archive": f"TrialGPT/{PIN}/dataset/sigir/corpus.jsonl"}
                encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
                saved = db.execute("INSERT INTO documents(nct_id,xml_sha256,payload_sha256,payload,archive) VALUES (?,?,?,?,?)",
                    (ident, sha(raw), sha(encoded), zlib.compress(encoded), payload["source_archive"]))
                db.execute("INSERT INTO terms(rowid,title,condition,summary,description,eligibility) VALUES (?,?,?,?,?,?)",
                    (saved.lastrowid,payload["title"],payload["condition"],payload["summary"],"",eligibility))
                trials[ident] = {**payload, "sections": {"inclusion": [0,len(inclusion)],
                    "exclusion": [len(inclusion) + len(separator),len(eligibility)]}}
        db.commit()
    finally:
        db.close()
    collection = {"version":1,"id":"sigir-trialgpt","sourceVersion":f"trialgpt-sigir-{PIN[:12]}",
        "snapshotDate":"2026-11-02","sourceFormat":"trialgpt-json", "databasePath":str((published / "sigir.sqlite").resolve()),
        "databaseSha256":sha(dbfile.read_bytes())}
    save(out / "collection.json", collection)
    groups = defaultdict(list)
    for row in rows:
        groups[row["patient_id"]].append(row)
    cases, sources, gold_units = [], {}, []
    for patient_id, annotations in sorted(groups.items()):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", patient_id):
            raise ValueError("Unsafe patient ID")
        notes = {row["note"] for row in annotations}
        if len(notes) != 1:
            raise ValueError("Patient note differs between annotations")
        trial_ids = sorted({row["trial_id"] for row in annotations})
        folder = out / "model-inputs" / patient_id
        folder.mkdir(parents=True)
        (folder / "patient.txt").write_text(next(iter(notes)))
        (folder / "trials.txt").write_text("Frozen trial collection: sigir-trialgpt\nHistorical records; status is not current.\n" + "\n".join(trial_ids) + "\n")
        files = [{"path":str((published / "model-inputs" / patient_id / name).resolve()),"name":name,"sha256":sha((folder/name).read_bytes())}
                 for name in ("patient.txt","trials.txt")]
        cases.append({"id":patient_id,"patientId":patient_id,"trialIds":trial_ids,"files":files})
        for row in annotations:
            ident, kind = row["trial_id"], row["criterion_type"]
            trial = trials[ident]
            source_id = ident + ":" + kind
            version = sha(trial["eligibility"].encode())
            sources[source_id] = {"id":source_id,"version":version,"trial_id":ident,
                                  "criterion_type":kind,"text":trial["eligibility"],
                                  "section_start":trial["sections"][kind][0], "section_end":trial["sections"][kind][1]}
            gold_units.append({"id":str(row["annotation_id"]),"patient_id":patient_id,"trial_id":ident,
                "criterion_type":kind,"source_id":source_id,"source_version":version,"text":row["criterion_text"] or ""})
    save(out / "alignment-reference.json", {"sources":list(sources.values()),"gold_units":gold_units})
    manifest = {"version":1,"task":"matching","collection":"sigir-trialgpt","patients":len(cases),"annotations":len(rows),
        "trialCorpusCount":len(trials),"sourcePin":PIN,"inputsSha256":sha(input_bytes),
        "corpusSha256":sha(corpus_bytes),"snapshotDateMeaning":"public archive acquired on 2026-11-02, not registry update date",
        "presentation":"Original section bytes with an explicit Exclusion Criteria header inserted; section spans retained.",
        "cases":cases}
    save(out / "cases.json", manifest)
    return {key:value for key,value in manifest.items() if key != "cases"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("inputs", "corpus", "out"): parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.inputs, args.corpus, args.out), indent=2))
