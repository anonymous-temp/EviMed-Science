"""Build the private matching boards from the pinned public benchmark files.

Reads, never executes: the TrialGPT 2.0 benchmark data (SIGIR, TREC 2021,
TREC 2022, NIH-TrialBench), the TrialGPT 1.0 paper-subset lists and the public
criterion annotations. Writes two directories that must stay outside the
repository:

  --out         what a runtime may be given: cases (patient note plus shuffled
                candidate ids), the criterion board, a sealed trial collection per
                cohort in the format the platform's frozen-corpus reader expects,
                the frozen split, and a manifest of every input digest
  --labels-out  what only the scorer may read: the criterion board's expert and
                GPT-4 columns and the NIH target trials

No model is called and no label influences any file under --out.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I does not add the script directory

from common import (
    ANNOTATIONS_SHA256, ANNOTATIONS_SOURCE, COHORTS, CRITERION, DEV_TOPICS_PER_TREC_COHORT, EVALUATORS,
    NCT_ID, NIH, PATIENT_ID, SHUFFLE_SEED, TG1_COMMIT, TG1_REPO, TG2_COMMIT, TG2_REPO, TREC_2023_TOPICS,
    candidate_order, check_evaluator, read_git_head, read_json, read_jsonl, sha256_bytes, sha256_file,
    write_json, write_jsonl,
)

FROZEN_SPLIT = Path(__file__).with_name("split.json")
SNAPSHOT_DATE = "2026-11-04"
SEVEN_FIELDS = ("annotation_id", "patient_id", "note", "trial_id", "trial_title", "criterion_type", "criterion_text")
TRIAL_KEYS = ("nctid", "title", "brief_summary", "raw_criteria", "study_type", "phases", "condition",
              "minimum_age", "maximum_age", "sex", "overall_status")
COLLECTIONS = {"sigir": "tg2-sigir", "trec_2021": "tg2-trec-2021", "trec_2022": "tg2-trec-2022",
               NIH["dir"]: "tg2-nih-trialbench"}


# ---------------------------------------------------------------------------
# Pins and inputs
# ---------------------------------------------------------------------------

def verify_pins(tg2, tg1):
    if read_git_head(tg2) != TG2_COMMIT:
        raise ValueError("The TrialGPT 2.0 clone is not at the pinned commit")
    if read_git_head(tg1) != TG1_COMMIT:
        raise ValueError("The TrialGPT 1.0 clone is not at the pinned commit")
    for name in EVALUATORS:
        check_evaluator(tg2, name)


def input_files(tg2, tg1, annotations):
    """Every file the boards read, as (label, path); labels keep digests stable across machines."""
    tg2, tg1 = Path(tg2), Path(tg1)
    files = [("annotations/" + Path(annotations).name, Path(annotations))]
    for relative, _ in EVALUATORS.values():
        files.append(("tg2/" + relative, tg2 / relative))
    for name in (*COHORTS, NIH["dir"]):
        base = tg2 / "data" / name
        for fixed in ("benchmark_cases.jsonl", "queries.jsonl", "case_search_space.jsonl"):
            files.append((f"tg2/data/{name}/{fixed}", base / fixed))
        if name in COHORTS:
            files.append((f"tg2/data/{name}/qrels/test.tsv", base / "qrels" / "test.tsv"))
        files.extend((f"tg2/data/{name}/trials/{path.name}", path) for path in sorted((base / "trials").glob("*.json")))
    for name in COHORTS:
        base = tg1 / "dataset" / name
        files.append((f"tg1/dataset/{name}/retrieved_trials.json", base / "retrieved_trials.json"))
        files.append((f"tg1/dataset/{name}/qrels/test.tsv", base / "qrels" / "test.tsv"))
    return files


def hash_inputs(files):
    return {label: sha256_file(path) for label, path in files}


def digest_listing(hashes):
    listing = "".join(f"{value}  {label}\n" for label, value in sorted(hashes.items()))
    return listing, sha256_bytes(listing.encode())


# ---------------------------------------------------------------------------
# Cohorts, pools and the frozen split
# ---------------------------------------------------------------------------

def read_qrels(path):
    """pid -> {trial: label}; the same three-column reading the official evaluator does."""
    labels = {}
    rows = 0
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 3 or parts[0].strip().lower() in {"query-id", "qid", "queryid"}:
            continue
        labels.setdefault(parts[0].strip(), {})[parts[1].strip()] = int(parts[2])
        rows += 1
    return labels, rows


def load_cohort(tg2, name):
    base = Path(tg2) / "data" / name
    queries = read_jsonl(base / "queries.jsonl")
    order = [str(row.get("_id") or row.get("patient_id")) for row in queries]
    cases = read_jsonl(base / "benchmark_cases.jsonl")
    if len(set(order)) != len(order) or {case["patient_id"] for case in cases} != set(order):
        raise ValueError(f"{name}: queries and cases disagree about patients")
    if any(not PATIENT_ID.match(pid) for pid in order):
        raise ValueError(f"{name}: unsafe patient id")
    return {"order": order, "cases": {case["patient_id"]: case for case in cases}, "queries": queries}


def check_ranking_cohort(name, data, qrels, trial_ids, expected=None):
    """Candidate lists must equal the qrels pools; returns aggregate counts only."""
    expected = expected or COHORTS[name]
    pairs = 0
    for pid, case in data["cases"].items():
        candidates = case["candidate_trial_ids"]
        if len(candidates) != len(set(candidates)) or case["candidate_trial_count"] != len(candidates):
            raise ValueError(f"{name}: candidate list is duplicated or its count is wrong")
        pool = set(qrels.get(pid, {}))
        if set(candidates) != pool:
            raise ValueError(f"{name}: a candidate list differs from its qrels pool")
        if not set(candidates) <= trial_ids:
            raise ValueError(f"{name}: a candidate has no trial file")
        pairs += len(candidates)
    queries = {row.get("_id"): row.get("text") for row in data["queries"]}
    if any(queries[pid] != case["patient_summary"] for pid, case in data["cases"].items()):
        raise ValueError(f"{name}: a case note differs from its query text")
    evaluable = sum(1 for case in data["cases"].values() if case["candidate_trial_ids"])
    counts = {"cases": len(data["cases"]), "evaluable": evaluable, "pairs": pairs}
    if counts != {key: expected[key] for key in counts}:
        raise ValueError(f"{name}: counts {counts} differ from the paper's {expected}")
    return counts


def build_split(order, no_candidates, nih_ids, criterion_patients):
    """Dev: SIGIR, plus the first ten TREC 2021 and 2022 topics in query order. Everything else is test."""
    n = DEV_TOPICS_PER_TREC_COHORT
    sigir = [pid for pid in order["sigir"] if pid not in no_candidates["sigir"]]
    return {
        "version": 1,
        "rule": ("dev: every SIGIR topic with candidates and the first ten TREC 2021 and TREC 2022 topics in "
                 "queries.jsonl order; test: the remaining TREC 2021 and TREC 2022 topics, all forty TREC 2023 "
                 "topics (not in the pinned data; ids follow the earlier campaign's trec-2023-N naming and must "
                 "be mapped when that data is pinned) and every NIH-TrialBench vignette; the criterion board is "
                 "drawn from SIGIR patients, so all of it is dev"),
        "dev": {"sigir": sigir, "trec_2021": order["trec_2021"][:n], "trec_2022": order["trec_2022"][:n],
                "criterion": sorted(criterion_patients)},
        "test": {
            "trec_2021": order["trec_2021"][n:], "trec_2022": order["trec_2022"][n:],
            "trec_2023": [f"trec-2023-{index}" for index in range(1, TREC_2023_TOPICS + 1)],
            NIH["dir"]: list(nih_ids),
        },
        "unscorable": {name: sorted(no_candidates[name]) for name in ("sigir",) if no_candidates[name]},
    }


def settle_split(split, path, freeze):
    """True when the split is to be frozen now (written after every check passes); False when it already is."""
    path = Path(path)
    if not path.exists():
        if not freeze:
            raise FileNotFoundError("The split is not frozen; run once with --freeze-split")
        return True
    if read_json(path) != split:
        raise ValueError("The frozen split differs from the one these inputs produce")
    return False


def split_of(split, name, pid):
    return "dev" if pid in split["dev"].get(name, ()) else "test"


# ---------------------------------------------------------------------------
# Boards
# ---------------------------------------------------------------------------

def ranking_cases(name, data, split):
    cases = []
    for pid in data["order"]:
        case = data["cases"][pid]
        if not case["candidate_trial_ids"]:
            continue
        ids = candidate_order(pid, case["candidate_trial_ids"])
        cases.append({"caseId": pid, "patientId": pid, "cohort": name, "collection": COLLECTIONS[name],
                      "split": split_of(split, name, pid), "note": case["patient_summary"],
                      "candidateIds": ids, "candidateCount": len(ids)})
    return cases


def nih_cases(data, trial_ids):
    cases, targets = [], []
    for pid in data["order"]:
        case = data["cases"][pid]
        ids = case["candidate_trial_ids"]
        target = case["target_trial_id"]
        if len(set(ids)) != len(ids) or target not in ids or not set(ids) <= trial_ids:
            raise ValueError("NIH-TrialBench: a candidate list is invalid or misses its target")
        cases.append({"caseId": pid, "patientId": pid, "cohort": NIH["dir"], "collection": COLLECTIONS[NIH["dir"]],
                      "split": "test", "note": case["patient_summary"],
                      "candidateIds": candidate_order(pid, ids), "candidateCount": len(ids)})
        targets.append({"patientId": pid, "targetTrialId": target, "targetStudyType": case["target_study_type"],
                        "ic": case["ic"], "candidateCount": len(ids)})
    if sum(case["candidateCount"] for case in cases) != NIH["pairs"] or len(cases) != NIH["cases"]:
        raise ValueError("NIH-TrialBench counts differ from the published ones")
    return cases, targets


def read_annotations(path):
    path = Path(path)
    if path.suffix == ".parquet":
        import pyarrow.parquet  # imported lazily: only the parquet form needs it
        return pyarrow.parquet.read_table(path).to_pylist()
    return read_jsonl(path)


def criterion_board(rows, expected=None):
    """Patient cases with each pair's annotated clauses numbered per kind, the flat seven-field rows, and labels."""
    expected = expected or CRITERION
    if len(rows) != expected["rows"] or len({row["annotation_id"] for row in rows}) != len(rows):
        raise ValueError("Require the 1015 unique criterion annotations")
    rows = sorted(rows, key=lambda row: int(row["annotation_id"]))
    seven = [{key: row[key] for key in SEVEN_FIELDS} for row in rows]
    patients, labels = {}, []
    counters = Counter()
    for row in rows:
        pid, trial, kind = row["patient_id"], row["trial_id"], row["criterion_type"]
        if not PATIENT_ID.match(pid) or not NCT_ID.match(trial) or kind not in ("inclusion", "exclusion"):
            raise ValueError("Unsafe patient, trial or criterion type")
        patient = patients.setdefault(pid, {"caseId": pid, "patientId": pid, "cohort": "criterion",
                                            "split": "dev", "note": row["note"], "trials": {}})
        if patient["note"] != row["note"]:
            raise ValueError("A patient note differs between annotations")
        entry = patient["trials"].setdefault(trial, {"registryId": trial, "trialTitle": row["trial_title"], "clauses": []})
        number = counters[(pid, trial, kind)]
        counters[(pid, trial, kind)] += 1
        clause = {"annotationId": int(row["annotation_id"]), "kind": kind, "number": number, "text": row["criterion_text"]}
        if row["criterion_text"] is None:
            clause["textNull"] = True
        entry["clauses"].append(clause)
        labels.append({"annotationId": int(row["annotation_id"]), "patientId": pid, "registryId": trial,
                       "kind": kind, "number": number, "expert": row["expert_eligibility"],
                       "gpt4": row["gpt4_eligibility"], "expertSentences": json.loads(row["expert_sentences"]),
                       "gpt4Sentences": json.loads(row["gpt4_sentences"]), "training": bool(row["training"])})
    cases = []
    for pid in sorted(patients):
        patient = patients[pid]
        patient["trials"] = [patient["trials"][trial] for trial in sorted(patient["trials"])]
        patient["sentenceCount"] = len(patient["note"].split("\n"))
        cases.append(patient)
    counts = {"rows": len(rows), "patients": len(cases), "pairs": sum(len(case["trials"]) for case in cases)}
    if counts != {key: expected[key] for key in counts}:
        raise ValueError(f"Criterion board counts {counts} differ from the published ones")
    return cases, seven, labels


# ---------------------------------------------------------------------------
# Trial collections
# ---------------------------------------------------------------------------

def trial_payload(raw, name, archive):
    """One trial JSON file as the platform's collection reader names its fields. Text is carried unchanged."""
    trial = json.loads(raw)
    missing = [key for key in TRIAL_KEYS if key not in trial]
    if missing or f"{trial.get('nctid')}.json" != name or not NCT_ID.match(str(trial.get("nctid"))):
        raise ValueError(f"Trial file {name} does not carry the expected fields")
    return {
        "nct_id": trial["nctid"], "title": trial["title"], "condition": "\n".join(trial["condition"]),
        "summary": trial["brief_summary"], "detailed_description": "", "eligibility": trial["raw_criteria"],
        "phase": "/".join(trial["phases"]), "interventions": "", "overall_status": trial["overall_status"],
        "gender": trial["sex"], "minimum_age": trial["minimum_age"], "maximum_age": trial["maximum_age"],
        "study_type": trial["study_type"], "source_sha256": sha256_bytes(raw), "source_archive": archive,
    }


def build_collection(trial_dir, out_dir, cohort, snapshot_date=SNAPSHOT_DATE):
    """Seal one SQLite index (documents plus contentless FTS5 terms) and write its collection manifest."""
    cid = COLLECTIONS[cohort]
    database = Path(out_dir) / f"{cid}.sqlite"
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(database)
    ids, empty = set(), 0
    try:
        db.executescript("""CREATE TABLE documents(id INTEGER PRIMARY KEY,nct_id TEXT UNIQUE,
            xml_sha256 TEXT,payload_sha256 TEXT,payload BLOB,archive TEXT);
            CREATE VIRTUAL TABLE terms USING fts5(title,condition,summary,description,eligibility,
                content='',tokenize='porter unicode61');""")
        for path in sorted(Path(trial_dir).glob("*.json")):
            archive = f"TrialGPT2.0/{TG2_COMMIT[:12]}/data/{cohort}/trials/{path.name}"
            raw = path.read_bytes()
            payload = trial_payload(raw, path.name, archive)
            encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
            saved = db.execute("INSERT INTO documents(nct_id,xml_sha256,payload_sha256,payload,archive) VALUES (?,?,?,?,?)",
                               (payload["nct_id"], payload["source_sha256"], sha256_bytes(encoded), zlib.compress(encoded), archive))
            db.execute("INSERT INTO terms(rowid,title,condition,summary,description,eligibility) VALUES (?,?,?,?,?,?)",
                       (saved.lastrowid, payload["title"], payload["condition"], payload["summary"], "", payload["eligibility"]))
            ids.add(payload["nct_id"])
            empty += not payload["eligibility"].strip()
        db.commit()
    finally:
        db.close()
    manifest = {"version": 1, "id": cid, "sourceVersion": f"trialgpt2-{TG2_COMMIT[:12]}-{cohort}".replace("_", "-"),
                "snapshotDate": snapshot_date, "sourceFormat": "trialgpt-json", "databasePath": database.name,
                "databaseSha256": sha256_file(database)}
    write_json(Path(out_dir) / "collection.json", manifest)
    return ids, {"records": len(ids), "emptyEligibility": empty}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def file_digests(root):
    root = Path(root)
    return {str(path.relative_to(root)): sha256_file(path)
            for path in sorted(root.rglob("*")) if path.is_file() and path.name != "manifest.json"}


def trial_ids_of(tg2, name):
    return {path.stem for path in (Path(tg2) / "data" / name / "trials").glob("*.json")}


def stage(tg2, annotations, split_path, freeze, listing, out, labels, snapshot_date):
    cohorts = {name: load_cohort(tg2, name) for name in COHORTS}
    nih = load_cohort(tg2, NIH["dir"])
    qrels, qrels_rows = {}, {}
    for name in COHORTS:
        qrels[name], qrels_rows[name] = read_qrels(Path(tg2) / "data" / name / "qrels" / "test.tsv")
    trial_sets = {name: trial_ids_of(tg2, name) for name in (*COHORTS, NIH["dir"])}
    counts = {name: check_ranking_cohort(name, cohorts[name], qrels[name], trial_sets[name]) for name in COHORTS}
    for name in COHORTS:
        if qrels_rows[name] != counts[name]["pairs"]:
            raise ValueError(f"{name}: qrels rows differ from candidate pairs")

    no_candidates = {name: {pid for pid, case in cohorts[name]["cases"].items() if not case["candidate_trial_ids"]}
                     for name in COHORTS}
    c_cases, seven, c_labels = criterion_board(read_annotations(annotations))
    if not all(case["patientId"].startswith("sigir-") for case in c_cases):
        raise ValueError("The criterion board is expected to hold SIGIR patients only")
    split = build_split({name: cohorts[name]["order"] for name in COHORTS}, no_candidates, nih["order"],
                        [case["patientId"] for case in c_cases])
    freezing = settle_split(split, split_path, freeze)

    boards = Path(out)
    for name in COHORTS:
        write_jsonl(boards / f"A-{name.replace('_', '')}" / "cases.jsonl", ranking_cases(name, cohorts[name], split))
    b_cases, b_targets = nih_cases(nih, trial_sets[NIH["dir"]])
    write_jsonl(boards / "B-nih" / "cases.jsonl", b_cases)
    write_jsonl(Path(labels) / "B-nih" / "targets.jsonl", b_targets)

    write_jsonl(boards / "C-criterion" / "cases.jsonl", c_cases)
    write_json(boards / "C-criterion" / "rows.json", seven)
    write_jsonl(Path(labels) / "C-criterion" / "labels.jsonl", c_labels)

    collections = {}
    for name in (*COHORTS, NIH["dir"]):
        ids, info = build_collection(Path(tg2) / "data" / name / "trials", Path(out) / "collections" / COLLECTIONS[name], name, snapshot_date)
        collections[COLLECTIONS[name]] = info
    write_json(Path(out) / "split.json", split)
    (Path(out) / "inputs.sha256").write_text(listing, encoding="utf-8")
    if freezing:  # only after every check above has passed
        write_json(split_path, split)
    return {"counts": counts, "nih": {"cases": len(b_cases), "pairs": sum(case["candidateCount"] for case in b_cases)},
            "criterion": {"rows": len(seven), "patients": len(c_cases),
                          "pairs": sum(len(case["trials"]) for case in c_cases),
                          "nullCriterionText": [row["annotation_id"] for row in seven if row["criterion_text"] is None]},
            "collections": collections}


def prepare(tg2, tg1, annotations, out, labels_out, split_path=FROZEN_SPLIT, freeze_split=False, snapshot_date=SNAPSHOT_DATE):
    out, labels_out = Path(out).resolve(), Path(labels_out).resolve()
    if out == labels_out or out in labels_out.parents or labels_out in out.parents:
        raise ValueError("Labels must live in a directory of their own, outside the inputs")
    verify_pins(tg2, tg1)
    if sha256_file(annotations) != ANNOTATIONS_SHA256 and Path(annotations).suffix == ".parquet":
        raise ValueError("The annotations differ from the verified public acquisition")
    files = input_files(tg2, tg1, annotations)
    hashes = hash_inputs(files)
    listing, input_digest = digest_listing(hashes)

    if out.exists() or labels_out.exists():
        if not (out / "manifest.json").exists() or not (labels_out / "manifest.json").exists():
            raise FileExistsError("A partial preparation exists; remove both directories and run again")
        for root in (out, labels_out):
            manifest = read_json(root / "manifest.json")
            if manifest["inputsDigest"] != input_digest or manifest["files"] != file_digests(root):
                raise FileExistsError("Prepared boards exist and differ from these inputs; remove them first")
        return {**read_json(out / "manifest.json")["summary"], "status": "already prepared"}

    out.parent.mkdir(parents=True, exist_ok=True)
    labels_out.parent.mkdir(parents=True, exist_ok=True)
    stage_out = Path(tempfile.mkdtemp(prefix=".prepare-out-", dir=out.parent))
    stage_labels = Path(tempfile.mkdtemp(prefix=".prepare-labels-", dir=labels_out.parent))
    try:
        shutil.rmtree(stage_out), shutil.rmtree(stage_labels)
        summary = stage(tg2, annotations, split_path, freeze_split, listing, stage_out, stage_labels, snapshot_date)
        pins = {"trialgpt2": {"repo": TG2_REPO, "commit": TG2_COMMIT}, "trialgpt1": {"repo": TG1_REPO, "commit": TG1_COMMIT},
                "annotations": {"source": ANNOTATIONS_SOURCE, "sha256": ANNOTATIONS_SHA256}}
        common = {"version": 1, "pins": pins, "inputsDigest": input_digest, "shuffleSeed": SHUFFLE_SEED}
        write_json(stage_out / "manifest.json", {**common, "role": "inputs", "summary": summary, "files": file_digests(stage_out)})
        write_json(stage_labels / "manifest.json", {**common, "role": "labels", "summary": summary, "files": file_digests(stage_labels)})
        stage_out.rename(out)
        stage_labels.rename(labels_out)
    except BaseException:
        shutil.rmtree(stage_out, ignore_errors=True)
        shutil.rmtree(stage_labels, ignore_errors=True)
        raise
    return {**summary, "status": "prepared"}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tg2", type=Path, required=True, help="TrialGPT 2.0 clone at the pinned commit")
    parser.add_argument("--tg1", type=Path, required=True, help="TrialGPT 1.0 clone at the pinned commit")
    parser.add_argument("--annotations", type=Path, required=True, help="criterion annotations (.parquet, or .jsonl)")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--labels-out", type=Path, required=True)
    parser.add_argument("--split", type=Path, default=FROZEN_SPLIT)
    parser.add_argument("--freeze-split", action="store_true", help="write the split file when it does not exist yet")
    args = parser.parse_args()
    print(json.dumps(prepare(args.tg2, args.tg1, args.annotations, args.out, args.labels_out, args.split, args.freeze_split),
                     indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
