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


def test_equal_version_numeric_primary_ids_use_numeric_tiebreak(tmp_path):
    source = _snapshot()
    base = source.reports[0]
    reports = [
        replace(base, case_id="numeric-tie", primary_id="9"),
        replace(base, case_id="numeric-tie", primary_id="10"),
    ]
    in_memory = FrozenFAERSSnapshot(reports, source.provenance)
    assert [report.primary_id for report in in_memory.reports] == ["10"]

    path = write_sqlite_snapshot(reports, source.provenance, tmp_path / "numeric-tie.sqlite")
    SQLiteFAERSSnapshot.from_path(path)
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT primary_id FROM reports").fetchall() == [("10",)]


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


def test_route_and_asymmetric_background_window_apply_to_exact_drug_object(tmp_path):
    source = _snapshot()
    reports = []
    for report in source.reports:
        drugs = tuple(
            replace(drug, route="oral")
            if drug.medicinal_product == "METFORMIN"
            else drug
            for drug in report.drugs
        )
        reports.append(replace(report, drugs=drugs))
    in_memory = type(source)(reports, source.provenance)
    scope = DrugScope(
        names=("metformin",),
        role_codes=frozenset({"PS"}),
        routes=("oral",),
        date_from="2020-01-01",
        date_to="2020-12-31",
        background_date_from="2020-01-01",
        background_date_to="2021-12-31",
    )

    counts = in_memory.contingency(scope, "lactic acidosis")
    assert (counts.joint, counts.drug_total, counts.event_total, counts.grand_total) == (
        0,
        1,
        2,
        3,
    )
    wrong_route = replace(scope, routes=("intravenous",))
    assert in_memory.contingency(wrong_route, "nausea").drug_total == 0

    # Route, name and role must all match one drug entry.  A PS metformin
    # injected intravenously plus a separate oral concomitant must not satisfy
    # the oral-metformin scope through cross-object array matching.
    cross_object_reports = []
    for report in source.reports:
        drugs = tuple(
            replace(
                drug,
                route=("intravenous" if drug.medicinal_product == "METFORMIN" else "oral"),
            )
            if drug.medicinal_product in {"METFORMIN", "ASPIRIN"}
            else drug
            for drug in report.drugs
        )
        cross_object_reports.append(replace(report, drugs=drugs))
    cross_object = type(source)(cross_object_reports, source.provenance)
    assert cross_object.contingency(scope, "nausea").drug_total == 0
    cross_object_path = write_sqlite_snapshot(
        cross_object.reports,
        cross_object.provenance,
        tmp_path / "cross-object-route.sqlite",
    )
    cross_object_indexed = SQLiteFAERSSnapshot.from_path(cross_object_path)
    assert cross_object_indexed.contingency(scope, "nausea").drug_total == 0

    path = write_sqlite_snapshot(
        in_memory.reports, in_memory.provenance, tmp_path / "route.sqlite"
    )
    indexed = SQLiteFAERSSnapshot.from_path(path)
    assert indexed.contingency(scope, "lactic acidosis") == counts


def test_background_window_must_contain_target_window():
    with pytest.raises(ValueError, match="contain"):
        DrugScope(
            names=("cefiderocol",),
            date_from="2019-10-01",
            date_to="2024-09-30",
            background_date_from="2020-01-01",
            background_date_to="2024-09-30",
        )


def test_bounded_background_cannot_truncate_an_open_target_window():
    with pytest.raises(ValueError, match="open target start"):
        DrugScope(
            names=("cefiderocol",),
            date_to="2024-09-30",
            background_date_from="2004-01-01",
            background_date_to="2024-09-30",
        )
    with pytest.raises(ValueError, match="open target end"):
        DrugScope(
            names=("cefiderocol",),
            date_from="2019-10-01",
            background_date_from="2004-01-01",
            background_date_to="2024-09-30",
        )


def test_snapshot_overview_and_top_reactions_use_exact_target_scope():
    snapshot = _snapshot()
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))
    overview = snapshot.overview(scope)
    top = snapshot.top_reactions(scope)

    assert overview.total_reports == 1
    assert [(bucket.term, bucket.count) for bucket in overview.yearly] == [("2020", 1)]
    assert [(bucket.term, bucket.count) for bucket in overview.sex] == [("female", 1)]
    assert [(bucket.term, bucket.count) for bucket in overview.age_buckets] == [
        ("45-64", 1)
    ]
    assert [(bucket.term, bucket.count) for bucket in overview.outcomes] == [
        ("hospitalization", 1)
    ]
    assert [(bucket.term, bucket.count) for bucket in overview.countries] == [
        ("US", 1),
        ("not reported", 0),
    ]
    assert [(bucket.term, bucket.count) for bucket in overview.concomitant_drugs] == [
        ("ASPIRIN", 1)
    ]
    assert [(bucket.term, bucket.count) for bucket in overview.indications] == [
        ("Diabetes mellitus", 1)
    ]
    assert [(bucket.term, bucket.count) for bucket in top] == [("nausea", 1)]


def test_snapshot_overview_preserves_missing_demographic_buckets_and_empty_years():
    snapshot = _snapshot()
    scope = DrugScope(
        names=("metformin",),
        role_codes=frozenset({"PS", "C"}),
        date_from="2020-01-01",
        date_to="2021-12-31",
    )
    overview = snapshot.overview(scope)

    assert [(bucket.term, bucket.count) for bucket in overview.yearly] == [
        ("2020", 2),
        ("2021", 0),
    ]
    assert {bucket.term: bucket.count for bucket in overview.sex} == {
        "female": 1,
        "not reported": 1,
    }
    assert {bucket.term: bucket.count for bucket in overview.age_buckets} == {
        "45-64": 1,
        "not reported": 1,
    }


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


def test_sqlite_v1_snapshot_remains_readable_but_rejects_route_scope(tmp_path):
    source = _snapshot()
    path = write_sqlite_snapshot(
        source.reports, source.provenance, tmp_path / "legacy-v1.sqlite"
    )
    path.chmod(0o644)
    with sqlite3.connect(path) as connection:
        connection.execute("ALTER TABLE reports DROP COLUMN event_date")
        connection.execute("ALTER TABLE drugs DROP COLUMN therapy_start_date")
        connection.execute("ALTER TABLE drugs DROP COLUMN therapy_end_date")
        connection.execute("ALTER TABLE drugs DROP COLUMN route")
        connection.execute(
            "UPDATE metadata SET value = '1' WHERE key = 'schema_version'"
        )
        connection.commit()
    path.chmod(0o444)

    snapshot = SQLiteFAERSSnapshot.from_path(path)
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))
    assert snapshot.contingency(scope, "nausea").drug_total == 1
    with pytest.raises(ValueError, match="version 2"):
        snapshot.contingency(replace(scope, routes=("oral",)), "nausea")


def test_sqlite_v2_snapshot_remains_readable_but_rejects_time_to_onset(tmp_path):
    source = _snapshot()
    path = write_sqlite_snapshot(
        source.reports, source.provenance, tmp_path / "legacy-v2.sqlite"
    )
    path.chmod(0o644)
    with sqlite3.connect(path) as connection:
        connection.execute("ALTER TABLE reports DROP COLUMN event_date")
        connection.execute("ALTER TABLE drugs DROP COLUMN therapy_start_date")
        connection.execute("ALTER TABLE drugs DROP COLUMN therapy_end_date")
        connection.execute(
            "UPDATE metadata SET value = '2' WHERE key = 'schema_version'"
        )
        connection.commit()
    path.chmod(0o444)

    snapshot = SQLiteFAERSSnapshot.from_path(path)
    scope = DrugScope(names=("metformin",), role_codes=frozenset({"PS"}))
    assert snapshot.contingency(scope, "nausea").drug_total == 1
    with pytest.raises(ValueError, match="version 3"):
        snapshot.time_to_onset(scope, "nausea")
