"""Local-only relational checks. No patient identifiers, row values or text leave this process."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
from pathlib import Path


def fingerprint(path: Path) -> dict:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def audit_relations(directory: Path) -> dict:
    """Compare CSV key sets with an independent SQL aggregate; emit counts only."""
    definitions = {
        "admissions": ("inp_record.csv", ["patient_id", "case_no"]),
        "patients": ("patient_info.csv", ["patient_id"]),
        "labels": ("case_labels.csv", ["patient_id", "case_no"]),
    }
    summaries, sets, cases, pairs = {}, {}, {}, {}
    with sqlite3.connect(":memory:") as database:
        for table, (filename, columns) in definitions.items():
            source = directory / filename
            database.execute(f"CREATE TABLE {table} ({', '.join(c + ' TEXT' for c in columns)})")
            count, missing, complete_pairs = 0, 0, 0
            case_patients = {}
            patient_cases = set()
            keys = {column: set() for column in columns}
            with source.open(encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                if not set(columns) <= set(reader.fieldnames or []):
                    raise ValueError(f"Required keys absent in {filename}")
                for row in reader:
                    values = [row[column].strip() for column in columns]
                    count += 1
                    missing += any(not value for value in values)
                    for column, value in zip(columns, values):
                        if value:
                            keys[column].add(value)
                    if "case_no" in columns and all(values):
                        complete_pairs += 1
                        case_patients.setdefault(row["case_no"].strip(), set()).add(row["patient_id"].strip())
                        patient_cases.add((row["patient_id"].strip(), row["case_no"].strip()))
                    database.execute(f"INSERT INTO {table} VALUES ({','.join('?' for _ in columns)})", values)
            independent = database.execute(f"SELECT COUNT(*), COUNT(DISTINCT NULLIF(patient_id,'')) FROM {table}").fetchone()
            if independent != (count, len(keys["patient_id"])):
                raise AssertionError("Independent counts disagree")
            summaries[table] = {**fingerprint(source), "rows": count, "uniquePatients": len(keys["patient_id"]),
                                "rowsWithMissingKey": missing}
            if "case_no" in keys:
                summaries[table]["uniqueAdmissions"] = len(keys["case_no"])
                summaries[table]["duplicateAdmissionRows"] = complete_pairs - len(patient_cases)
                summaries[table]["conflictingPatientAssignments"] = sum(len(value) > 1 for value in case_patients.values())
            sets[table] = keys
            cases[table] = case_patients
            pairs[table] = patient_cases
        missing = len(sets["admissions"]["patient_id"] - sets["patients"]["patient_id"])
        independent_missing = database.execute("SELECT COUNT(DISTINCT a.patient_id) FROM admissions a LEFT JOIN patients p ON a.patient_id=p.patient_id WHERE a.patient_id<>'' AND p.patient_id IS NULL").fetchone()[0]
        if missing != independent_missing:
            raise AssertionError("Independent missing-patient counts disagree")
        summaries["relations"] = {
            "admittedPatientsWithoutDemographics": missing,
            "admissionsWithoutLabel": len(pairs["admissions"] - pairs["labels"]),
            "labelsWithoutAdmission": len(pairs["labels"] - pairs["admissions"]),
            "labelCasesWithPatientMismatch": sum(
                bool(patients - cases["admissions"][case])
                for case, patients in cases["labels"].items() if case in cases["admissions"]
            ),
        }
        sql_mismatch = database.execute("SELECT COUNT(DISTINCT l.case_no) FROM labels l WHERE l.patient_id<>'' AND l.case_no<>'' AND EXISTS (SELECT 1 FROM admissions a WHERE a.patient_id<>'' AND a.case_no=l.case_no) AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.case_no=l.case_no AND a.patient_id=l.patient_id)").fetchone()[0]
        if sql_mismatch != summaries["relations"]["labelCasesWithPatientMismatch"]:
            raise AssertionError("Independent patient-assignment checks disagree")
        for left, right, metric in [("admissions", "labels", "admissionsWithoutLabel"), ("labels", "admissions", "labelsWithoutAdmission")]:
            unmatched = database.execute(f"SELECT COUNT(*) FROM (SELECT DISTINCT patient_id,case_no FROM {left} WHERE patient_id<>'' AND case_no<>'' EXCEPT SELECT DISTINCT patient_id,case_no FROM {right} WHERE patient_id<>'' AND case_no<>'')").fetchone()[0]
            if unmatched != summaries["relations"][metric]:
                raise AssertionError("Independent composite-key checks disagree")
    return {"kind": "local-relational-data-audit", "independentAggregateAgreement": True,
            "outputsContainRowValues": False, "data": summaries}


def audit_corpus(source: Path) -> dict:
    """Read Parquet metadata and selected categorical columns, never vectors or source text."""
    import pyarrow.parquet as parquet

    file = parquet.ParquetFile(source)
    columns = file.schema_arrow.names
    selected = [name for name in ("book_path", "cat1", "cat2") if name in columns]
    uniques = {name: set() for name in selected}
    rows = 0
    for batch in file.iter_batches(batch_size=2048, columns=selected):
        rows += batch.num_rows
        for name in selected:
            uniques[name].update(value for value in batch.column(name).to_pylist() if value is not None)
    if rows != file.metadata.num_rows:
        raise AssertionError("Parquet metadata and streamed row counts disagree")
    return {"kind": "local-parquet-metadata-audit", **fingerprint(source), "rows": rows,
            "columns": columns, "distinctCounts": {key: len(values) for key, values in uniques.items()},
            "observedStructure": "document-corpus" if {"text", "vector", "chunk_id"} <= set(columns) else "unclassified",
            "clinicalOutcomeDatasetEstablished": False, "textAndVectorsLoaded": False,
            "independentAggregateAgreement": True, "outputsContainRowValues": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--relations", type=Path)
    parser.add_argument("--corpus", type=Path)
    args = parser.parse_args()
    if not (args.relations or args.corpus):
        parser.error("Supply a local relational directory or Parquet file.")
    result = {"schemaVersion": 1, "modelCalled": False, "networkRequired": False}
    if args.relations:
        result["relations"] = audit_relations(args.relations)
    if args.corpus:
        result["corpus"] = audit_corpus(args.corpus)
    print(json.dumps(result, ensure_ascii=False, indent=2))
