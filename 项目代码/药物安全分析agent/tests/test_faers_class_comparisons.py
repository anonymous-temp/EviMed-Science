"""Report-level class comparators, treatment strata, and onset timing."""

from __future__ import annotations

from datetime import date

from safety_agent.faers import (
    DrugEntry,
    DrugScope,
    FrozenFAERSSnapshot,
    ReportRecord,
    SnapshotProvenance,
    SQLiteFAERSSnapshot,
    write_sqlite_snapshot,
)


def _report(
    primary_id: str,
    received_date: str,
    drugs: tuple[DrugEntry, ...],
    reactions: tuple[str, ...],
    *,
    event_date: str | None = None,
) -> ReportRecord:
    return ReportRecord(
        primary_id=primary_id,
        case_id=primary_id,
        case_version=1,
        received_date=date.fromisoformat(received_date),
        drugs=drugs,
        reactions=reactions,
        event_date=date.fromisoformat(event_date) if event_date else None,
    )


def _drug(
    name: str,
    role: str = "PS",
    *,
    start: str | None = None,
) -> DrugEntry:
    return DrugEntry(
        medicinal_product=name.upper(),
        normalized_names=(name,),
        role_code=role,
        therapy_start_date=date.fromisoformat(start) if start else None,
    )


def _snapshot() -> FrozenFAERSSnapshot:
    reports = (
        _report(
            "a-event",
            "2020-01-10",
            (_drug("class-a", start="2020-01-01"),),
            ("event-x",),
            event_date="2020-01-06",
        ),
        _report("a-other", "2020-02-01", (_drug("class-a"),), ("event-y",)),
        _report("b-event", "2020-03-01", (_drug("class-b"),), ("event-x",)),
        _report("b-other", "2020-04-01", (_drug("class-b"),), ("event-y",)),
        _report(
            "overlap",
            "2020-05-01",
            (_drug("class-a"), _drug("class-b")),
            ("event-x",),
        ),
        _report(
            "polytherapy",
            "2020-06-01",
            (_drug("class-a"), _drug("other-therapy", "C")),
            ("event-y",),
        ),
        _report("comparator-event", "2020-07-01", (_drug("other-therapy"),), ("event-x",)),
        _report("comparator-other", "2020-08-01", (_drug("other-therapy"),), ("event-y",)),
        _report("background-event", "2020-09-01", (_drug("unrelated"),), ("event-x",)),
    )
    return FrozenFAERSSnapshot(
        reports,
        SnapshotProvenance(
            snapshot_id="class-comparison-fixture",
            source="synthetic class comparison fixture",
            extracted_at="2026-07-20T00:00:00Z",
        ),
    )


def test_pooled_class_union_counts_each_report_once():
    snapshot = _snapshot()
    pooled = DrugScope(names=("class-a", "class-b"), role_codes=frozenset({"PS"}))

    counts = snapshot.contingency(pooled, "event-x")

    assert counts.joint == 3
    assert counts.drug_total == 6
    assert counts.event_total == 5
    assert counts.grand_total == 9


def test_member_vs_rest_of_class_uses_disjoint_groups_and_reports_overlap():
    snapshot = _snapshot()
    target = DrugScope(names=("class-a",), role_codes=frozenset({"PS"}))
    comparator = DrugScope(names=("class-b",), role_codes=frozenset({"PS"}))

    cells = snapshot.comparative_contingency(target, comparator, "event-x")

    assert (cells.a, cells.b, cells.c, cells.d) == (1, 2, 1, 1)
    assert cells.overlap_excluded == 1
    assert cells.n == 5


def test_therapeutic_area_comparator_is_expressible():
    snapshot = _snapshot()
    target = DrugScope(names=("class-a", "class-b"), role_codes=frozenset({"PS"}))
    comparator = DrugScope(names=("other-therapy",), role_codes=frozenset({"PS"}))

    cells = snapshot.comparative_contingency(target, comparator, "event-x")

    assert (cells.a, cells.b, cells.c, cells.d) == (3, 3, 1, 1)
    assert cells.overlap_excluded == 0


def test_monotherapy_polytherapy_and_time_to_onset_are_report_level():
    snapshot = _snapshot()
    target = DrugScope(names=("class-a",), role_codes=frozenset({"PS"}))

    strata = snapshot.therapy_strata(target, co_medication_names=("other-therapy",))
    onset = snapshot.time_to_onset(target, "event-x")

    assert (strata.monotherapy, strata.polytherapy) == (3, 1)
    assert onset.days == (5,)
    assert onset.missing == 1


def test_sqlite_backend_matches_in_memory_class_methods(tmp_path):
    source = _snapshot()
    path = write_sqlite_snapshot(source.reports, source.provenance, tmp_path / "class.sqlite")
    indexed = SQLiteFAERSSnapshot.from_path(path)
    target = DrugScope(names=("class-a",), role_codes=frozenset({"PS"}))
    comparator = DrugScope(names=("class-b",), role_codes=frozenset({"PS"}))

    assert indexed.comparative_contingency(target, comparator, "event-x") == (
        source.comparative_contingency(target, comparator, "event-x")
    )
    assert indexed.therapy_strata(target, co_medication_names=("other-therapy",)) == (
        source.therapy_strata(target, co_medication_names=("other-therapy",))
    )
    assert indexed.time_to_onset(target, "event-x") == source.time_to_onset(
        target, "event-x"
    )
