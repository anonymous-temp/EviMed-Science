"""Exact same-drug-object matching over frozen FAERS report fixtures."""

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from safety_agent.faers import (
    DrugScope,
    FrozenFAERSSnapshot,
    SQLiteFAERSSnapshot,
    write_sqlite_snapshot,
)

DATA = Path(__file__).parent / "data"


def _snapshot() -> FrozenFAERSSnapshot:
    return FrozenFAERSSnapshot.from_path(DATA / "faers_report_binding.json")


def test_latest_case_version_is_kept_before_counting():
    snapshot = _snapshot()
    assert [report.primary_id for report in snapshot.reports] == ["1001-v2", "1002", "1003"]
    assert len(snapshot.provenance.sha256) == 64


def test_declared_snapshot_hash_must_match_canonical_content(tmp_path):
    payload = json.loads((DATA / "faers_report_binding.json").read_text(encoding="utf-8"))
    payload["provenance"]["sha256"] = "0" * 64
    path = tmp_path / "tampered-snapshot.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="SHA-256"):
        FrozenFAERSSnapshot.from_path(path)


def test_equal_frequency_reactions_have_a_deterministic_lexical_tiebreak(tmp_path):
    payload = json.loads((DATA / "faers_report_binding.json").read_text(encoding="utf-8"))
    payload["reports"][2]["reactions"] = ["Gamma", "Alpha", "Beta"]
    path = tmp_path / "tie-snapshot.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    snapshot = FrozenFAERSSnapshot.from_path(path)
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))

    assert [bucket.term for bucket in snapshot.top_reactions(scope, limit=2)] == [
        "alpha",
        "beta",
    ]


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda report: report.update(drugs=["not-an-object"]), "drug entry"),
        (lambda report: report.update(primary_id=""), "primary_id"),
        (lambda report: report.update(case_version=0), "case_version"),
        (lambda report: report.update(age_years=float("nan")), "age_years"),
        (lambda report: report.update(outcomes="death"), "outcomes"),
        (lambda report: report.update(reactions=[None]), "reactions"),
    ],
)
def test_malformed_snapshot_reports_are_rejected(tmp_path, mutation, match):
    payload = json.loads((DATA / "faers_report_binding.json").read_text(encoding="utf-8"))
    mutation(payload["reports"][0])
    path = tmp_path / "invalid-snapshot.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match=match):
        FrozenFAERSSnapshot.from_path(path)


def test_drug_name_and_primary_suspect_role_bind_to_same_drug_object():
    snapshot = _snapshot()
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))

    counts = snapshot.contingency(scope, "lactic acidosis")

    # 1001-v2 contains metformin and a PS drug, but metformin itself is C.
    # It must not enter the drug marginal or joint count.
    assert counts.joint == 0
    assert counts.drug_total == 1  # 1002 only
    assert counts.event_total == 2  # 1001-v2 and 1003
    assert counts.grand_total == 3


def test_role_and_date_scope_are_explicit_and_reproducible():
    snapshot = _snapshot()
    all_roles = DrugScope(
        names=("metformin",),
        role_codes=frozenset({"PS", "SS", "C", "I"}),
        date_from="2020-01-01",
        date_to="2020-12-31",
    )
    counts = snapshot.contingency(all_roles, "lactic acidosis")
    assert (counts.joint, counts.drug_total, counts.event_total, counts.grand_total) == (
        1,
        2,
        1,
        2,
    )


def test_snapshot_overview_and_top_reactions_use_exact_target_scope():
    snapshot = _snapshot()
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))
    overview = snapshot.overview(scope)
    top = snapshot.top_reactions(scope)

    assert overview.total_reports == 1
    assert [(bucket.term, bucket.count) for bucket in overview.yearly] == [("2020", 1)]
    assert [(bucket.term, bucket.count) for bucket in overview.concomitant_drugs] == [
        ("ASPIRIN", 1)
    ]
    assert [(bucket.term, bucket.count) for bucket in top] == [("nausea", 1)]


def test_sqlite_snapshot_matches_json_backend_without_materializing_universe(tmp_path):
    source = _snapshot()
    path = write_sqlite_snapshot(source.reports, source.provenance, tmp_path / "faers.sqlite")
    snapshot = SQLiteFAERSSnapshot.from_path(path)
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))

    assert snapshot.contingency(scope, "lactic acidosis") == source.contingency(
        scope, "lactic acidosis"
    )
    assert snapshot.overview(scope) == source.overview(scope)
    assert snapshot.top_reactions(scope) == source.top_reactions(scope)
    assert len(snapshot.provenance.sha256) == 64


def test_report_record_invariants_cannot_be_bypassed_by_direct_construction():
    report = _snapshot().reports[0]
    with pytest.raises(ValueError, match="age_years"):
        replace(report, age_years=-1.0)
    with pytest.raises(ValueError, match="reaction"):
        replace(report, reactions=())


def test_sqlite_loader_rejects_semantically_corrupt_rows(tmp_path):
    source = _snapshot()
    path = write_sqlite_snapshot(source.reports, source.provenance, tmp_path / "bad.sqlite")
    path.chmod(0o644)
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA ignore_check_constraints = ON")
        connection.execute("UPDATE reports SET age_years = -1 WHERE primary_id = '1002'")
        connection.commit()
    path.chmod(0o444)

    with pytest.raises(ValueError, match="semantic validation"):
        SQLiteFAERSSnapshot.from_path(path)


def test_concomitant_counts_exclude_target_aliases_and_duplicate_rows(tmp_path):
    payload = json.loads((DATA / "faers_report_binding.json").read_text(encoding="utf-8"))
    payload["reports"][2]["drugs"].extend(
        [
            {
                "medicinal_product": "METFORMIN",
                "normalized_names": ["metformin"],
                "role_code": "C",
            },
            {
                "medicinal_product": "ASPIRIN",
                "normalized_names": ["aspirin"],
                "role_code": "C",
            },
        ]
    )
    json_path = tmp_path / "duplicates.json"
    json_path.write_text(json.dumps(payload), encoding="utf-8")
    in_memory = FrozenFAERSSnapshot.from_path(json_path)
    sqlite_path = write_sqlite_snapshot(
        in_memory.reports, in_memory.provenance, tmp_path / "duplicates.sqlite"
    )
    indexed = SQLiteFAERSSnapshot.from_path(sqlite_path)
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))

    expected = [("ASPIRIN", 1)]
    assert [
        (bucket.term, bucket.count)
        for bucket in in_memory.overview(scope).concomitant_drugs
    ] == expected
    assert [
        (bucket.term, bucket.count)
        for bucket in indexed.overview(scope).concomitant_drugs
    ] == expected


def test_sqlite_snapshot_rejects_mutation_after_validation(tmp_path):
    source = _snapshot()
    path = write_sqlite_snapshot(
        source.reports, source.provenance, tmp_path / "immutable.sqlite"
    )
    snapshot = SQLiteFAERSSnapshot.from_path(path)
    path.chmod(0o644)

    with pytest.raises(ValueError, match="changed after validation"):
        snapshot.contingency(
            DrugScope(names=("metformin",), role_codes=frozenset({"PS"})),
            "nausea",
        )
