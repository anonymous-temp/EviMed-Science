"""Ingest an official TREC Clinical Trials snapshot into the sealed index the platform's trial reader opens (board E).

The TREC 2021 and 2022 tracks share the ClinicalTrials.gov snapshot of 2021-04-27, the 2023 track has its own (2023-05-08).
Each snapshot is a set of zip files of one public-XML record per trial. This script reads one zip at a time, never extracts it
to disk, and writes the layout `apps/server/src/vcrTrialCorpus.mjs` reads (`sourceFormat: clinicaltrials-xml`): a `documents`
table (id, nct_id, xml_sha256, payload_sha256, zlib JSON payload, archive) and a contentless FTS5 table `terms` (title, condition,
summary, description, eligibility; BM25 over a porter/unicode61 tokenizer) joined by rowid. Only what the reader presents is kept:
id, title, brief summary, conditions, interventions, eligibility text, status, phase, ages, sex. The detailed description is not
kept and not indexed (the SIGIR collection of `evals/vcr-platform-comparison/prepare.py` has none either).

Idempotent and resumable: a zip is one transaction, the set of `archive` values in the database is the record of what is in, and a
zip already in is skipped. No qrels, topic or answer column enters the index. Free space on the target disk is checked before a
zip is read and every few thousand records; below the floor it stops (the transaction rolls back, nothing half-written stays).

    python3 -I -B ingest_e.py add  --zip <zip> --index <dir> --id trec-ct-2021 [--min-free-gb 2.5] [--fill]
    python3 -I -B ingest_e.py seal --index <dir> --id trec-ct-2021 --snapshot 2021-04-27 [--expect-docs 375580] [--optimize]

`add` prints one JSON line (documents added, skipped, bytes). `seal` writes `<id>.sqlite` read-only state, `collection.json` (the
manifest the platform's `vcrTrialCorpusManifest` names) and `provenance.json` (the hash of every zip read, the counts).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import textwrap
import time
import xml.etree.ElementTree as ET
import zipfile
import zlib

NCT = re.compile(r"^NCT[0-9]{8}$")
MEMBER_MAX = 64_000_000
SCHEMA = """CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY,nct_id TEXT UNIQUE,
    xml_sha256 TEXT,payload_sha256 TEXT,payload BLOB,archive TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(title,condition,summary,description,eligibility,
        content='',tokenize='porter unicode61');"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def block(node):
    """A textblock as the record shows it: the XML's indentation removed, line structure kept."""
    if node is None or node.text is None:
        return ""
    text = textwrap.dedent(node.text.replace("\r\n", "\n").replace("\r", "\n"))
    return "\n".join(line.rstrip() for line in text.strip().split("\n"))


def field(root, path):
    node = root.find(path)
    return " ".join((node.text or "").split()) if node is not None else ""


def parse_trial(xml_bytes):
    """The fields the reader keeps, or None when the bytes are not a trial record."""
    root = ET.fromstring(xml_bytes)
    if root.tag != "clinical_study":
        return None
    nct = field(root, "id_info/nct_id")
    if not NCT.match(nct):
        return None
    title = field(root, "brief_title") or field(root, "official_title")
    conditions = [" ".join((node.text or "").split()) for node in root.findall("condition")]
    interventions = [" ".join((node.text or "").split()) for node in root.findall("intervention/intervention_name")]
    return {
        "nct_id": nct, "title": title,
        "condition": "\n".join(value for value in conditions if value),
        "summary": block(root.find("brief_summary/textblock")), "detailed_description": "",
        "eligibility": block(root.find("eligibility/criteria/textblock")),
        "phase": field(root, "phase"), "study_type": field(root, "study_type"),
        "interventions": "\n".join(value for value in interventions if value),
        "overall_status": field(root, "overall_status"), "gender": field(root, "eligibility/gender"),
        "minimum_age": field(root, "eligibility/minimum_age"), "maximum_age": field(root, "eligibility/maximum_age"),
    }


def free_gb(path):
    return shutil.disk_usage(path).free / 1e9


def guard(path, floor_gb):
    free = free_gb(path)
    if free < floor_gb:
        raise SystemExit(f"stop: {free:.2f} GB free on the target disk is under the {floor_gb} GB floor")


def add(zip_path, index_dir, collection_id, floor_gb, fill=False):
    zip_path, index_dir = Path(zip_path), Path(index_dir)
    index_dir.mkdir(parents=True, exist_ok=True)
    guard(index_dir, floor_gb)
    database = index_dir / f"{collection_id}.sqlite"
    archive = zip_path.name
    db = sqlite3.connect(database, isolation_level=None)
    try:
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("PRAGMA cache_size=-65536")
        db.executescript(SCHEMA)
        if not fill and db.execute("SELECT count(*) FROM documents WHERE archive=?", (archive,)).fetchone()[0]:
            return {"zip": archive, "status": "already_ingested", "documents": 0}
        archive_sha = file_sha(zip_path)
        added = skipped = invalid = mismatched = 0
        refused = []
        started = time.time()
        db.execute("BEGIN")
        try:
            with zipfile.ZipFile(zip_path) as bundle:
                members = sorted((info for info in bundle.infolist() if info.filename.lower().endswith(".xml") and not info.is_dir()), key=lambda info: info.filename)
                for count, info in enumerate(members):
                    if info.file_size > MEMBER_MAX:
                        invalid += 1
                        refused.append({"member": info.filename, "reason": "too_large", "bytes": info.file_size})
                        continue
                    if count % 4000 == 0:
                        guard(index_dir, floor_gb)
                    raw = bundle.read(info)
                    reason = "not_a_trial_record"
                    try:
                        payload = parse_trial(raw)
                    except ET.ParseError:
                        payload, reason = None, "xml_parse_error"
                    if payload is None:
                        invalid += 1
                        refused.append({"member": info.filename, "reason": reason, "bytes": info.file_size})
                        continue
                    if Path(info.filename).stem.upper() != payload["nct_id"]:
                        mismatched += 1
                    payload["xml_sha256"] = sha(raw)
                    payload["source_archive"] = archive
                    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
                    taken = db.execute("SELECT 1 FROM documents WHERE nct_id=?", (payload["nct_id"],)).fetchone()
                    if taken:
                        skipped += 1
                        continue
                    saved = db.execute("INSERT INTO documents(nct_id,xml_sha256,payload_sha256,payload,archive) VALUES (?,?,?,?,?)",
                                       (payload["nct_id"], payload["xml_sha256"], sha(encoded), zlib.compress(encoded, 9), archive))
                    db.execute("INSERT INTO terms(rowid,title,condition,summary,description,eligibility) VALUES (?,?,?,?,?,?)",
                               (saved.lastrowid, payload["title"], payload["condition"], payload["summary"], "", payload["eligibility"]))
                    added += 1
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
    finally:
        db.close()
    progress = index_dir / "provenance.json"
    record = json.loads(progress.read_text()) if progress.exists() else {"zips": {}}
    record["zips"][archive + ("#fill" if fill else "")] = {"sha256": archive_sha, "bytes": zip_path.stat().st_size, "documents": added, "duplicates": skipped, "invalid": invalid,
                               "nameMismatch": mismatched, "refusedMembers": refused[:50]}
    progress.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return {"zip": archive, "status": "ingested", "documents": added, "duplicates": skipped, "invalid": invalid, "nameMismatch": mismatched,
            "seconds": round(time.time() - started, 1), "sqliteBytes": database.stat().st_size}


def seal(index_dir, collection_id, snapshot, source_version, expect_docs, optimize, floor_gb):
    index_dir = Path(index_dir)
    source_version = source_version or f"{collection_id}-snapshot-{snapshot}"
    database = index_dir / f"{collection_id}.sqlite"
    db = sqlite3.connect(database, isolation_level=None)
    try:
        documents = db.execute("SELECT count(*) FROM documents").fetchone()[0]
        if expect_docs is not None and documents != expect_docs:
            raise SystemExit(f"stop: {documents} documents, {expect_docs} expected; not sealed")
        if optimize:
            guard(index_dir, floor_gb + database.stat().st_size / 2e9)
            db.execute("INSERT INTO terms(terms) VALUES('optimize')")
        db.execute("PRAGMA journal_mode=DELETE")
    finally:
        db.close()
    for leftover in (Path(f"{database}-wal"), Path(f"{database}-shm"), Path(f"{database}-journal")):
        if leftover.exists():
            raise SystemExit(f"stop: {leftover.name} is still there; not sealed")
    manifest = {"version": 1, "id": collection_id, "sourceVersion": source_version, "snapshotDate": snapshot, "sourceFormat": "clinicaltrials-xml",
                "databasePath": database.name, "databaseSha256": file_sha(database)}
    (index_dir / "collection.json").write_text(json.dumps(manifest, indent=2) + "\n")
    progress = index_dir / "provenance.json"
    record = json.loads(progress.read_text()) if progress.exists() else {"zips": {}}
    record.update({"documents": documents, "databaseBytes": database.stat().st_size, "databaseSha256": manifest["databaseSha256"], "snapshotDate": snapshot})
    progress.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return {"documents": documents, "databaseBytes": database.stat().st_size, **manifest}


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("add")
    one.add_argument("--zip", required=True)
    one.add_argument("--index", required=True)
    one.add_argument("--id", required=True)
    one.add_argument("--min-free-gb", type=float, default=2.5)
    one.add_argument("--fill", action="store_true", help="read a zip that was already ingested once more and add only the records the index lacks")
    two = sub.add_parser("seal")
    two.add_argument("--index", required=True)
    two.add_argument("--id", required=True)
    two.add_argument("--snapshot", required=True)
    two.add_argument("--source-version")
    two.add_argument("--expect-docs", type=int)
    two.add_argument("--optimize", action="store_true")
    two.add_argument("--min-free-gb", type=float, default=2.5)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9_.:@-]{1,160}", args.id):
        raise SystemExit("--id is not a collection id")
    if args.command == "add":
        result = add(args.zip, args.index, args.id, args.min_free_gb, args.fill)
    else:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.snapshot):
            raise SystemExit("--snapshot is YYYY-MM-DD")
        result = seal(args.index, args.id, args.snapshot, args.source_version, args.expect_docs, args.optimize, args.min_free_gb)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
