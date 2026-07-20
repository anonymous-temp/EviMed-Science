"""Published drug-class tables are deterministic regression oracles."""

import json
from datetime import date
from pathlib import Path

import pytest

from safety_agent.drug_classes import ClassAnalysisEngine, build_exclusive_table
from safety_agent.faers import (
    DrugEntry,
    FrozenFAERSSnapshot,
    ReportRecord,
    SnapshotProvenance,
    SQLiteFAERSSnapshot,
    write_sqlite_snapshot,
)
from safety_agent.signals import analyze


DATA = Path(__file__).parent / "data" / "faers_regression" / "v1"


def _anchors():
    return json.loads((DATA / "class_publication_anchors.json").read_text(encoding="utf-8"))


def _calibrated_panel(member_name, event, *, a, b, c, d):
    reports = []
    groups = (
        ("target-event", a, member_name, event),
        ("target-other", b, member_name, "control event"),
        ("background-event", c, "unrelated", event),
        ("background-other", d, "unrelated", "control event"),
    )
    for prefix, count, drug_name, reaction in groups:
        for index in range(count):
            primary_id = f"{prefix}-{index}"
            reports.append(
                ReportRecord(
                    primary_id=primary_id,
                    case_id=primary_id,
                    case_version=1,
                    received_date=date(2020, 1, 1),
                    drugs=(DrugEntry(
                        medicinal_product=drug_name,
                        normalized_names=(drug_name,),
                        role_code="PS",
                    ),),
                    reactions=(reaction,),
                )
            )
    return FrozenFAERSSnapshot(
        reports,
        SnapshotProvenance(
            snapshot_id="published-ror-calibrated-panel-v1",
            source="synthetic margins calibrated to a published rounded ROR",
            extracted_at="2026-07-20T00:00:00Z",
        ),
    )


@pytest.mark.parametrize(
    "member",
    _anchors()["anchors"]["glp1ra-bhattacharyya-2024"]["members"],
    ids=lambda item: item["id"],
)
def test_glp1_member_vs_rest_of_class_ror_reproduces_published_table(member):
    anchor = _anchors()["anchors"]["glp1ra-bhattacharyya-2024"]
    for outcome in ("mortality", "serious"):
        class_event_total = sum(item[outcome] for item in anchor["members"])
        class_total = sum(item["total"] for item in anchor["members"])
        table = build_exclusive_table(
            target_total=member["total"],
            target_event=member[outcome],
            comparator_total=class_total - member["total"],
            comparator_event=class_event_total - member[outcome],
        )
        metrics = analyze(table)
        if member[outcome] == 0:
            # The paper reports an uncorrected zero. The production engine
            # deliberately applies Haldane-Anscombe to every cell so the CI
            # remains estimable; preserve and disclose that method difference.
            assert member[f"published_{outcome}_ror"] == 0
            assert metrics.haldane_anscombe_applied is True
            assert metrics.ror.value == pytest.approx(0.0169592683)
        else:
            assert metrics.ror.value == pytest.approx(
                member[f"published_{outcome}_ror"], abs=0.015
            )


def test_class_publication_anchors_cover_required_method_families():
    anchors = _anchors()["anchors"]

    assert set(anchors) == {
        "sglt2i-zhou-2021",
        "glp1ra-bhattacharyya-2024",
        "parpi-shu-2022",
        "jaki-verden-2021",
    }
    capabilities = {
        capability
        for anchor in anchors.values()
        for capability in anchor["required_capabilities"]
    }
    assert {
        "pooled_class_vs_all_faers",
        "member_vs_all_faers",
        "member_vs_rest_of_class",
        "therapeutic_area_comparator",
        "monotherapy_polytherapy",
        "shared_unique_signals",
        "soc_smq_ime",
        "approval_period_sensitivity",
        "time_to_onset",
    } <= capabilities


def test_glp1_anchor_preserves_the_papers_internal_total_inconsistency():
    anchor = _anchors()["anchors"]["glp1ra-bhattacharyya-2024"]

    assert sum(member["total"] for member in anchor["members"]) == 239201
    assert anchor["abstract_total"] == 287201
    assert anchor["quality_notes"]


def test_sglt2_publication_counts_and_soc_directions_are_frozen():
    anchor = _anchors()["anchors"]["sglt2i-zhou-2021"]
    published = anchor["published"]

    assert published["all_reports"] == 11822884
    assert published["class_reports"] == 57818
    assert published["monotherapy_reports"] == 54227
    assert published["monotherapy_ime_pairs"] == 21408
    assert all(item["n"] > 0 and item["ic025"] > 0 for item in published["soc_signals"])
    assert "requires_paper_matched_raw_quarters" in anchor["comparison_status"]


def test_parp_publication_pt_signal_directions_are_frozen():
    anchor = _anchors()["anchors"]["parpi-shu-2022"]

    assert {(item["member"], item["pt"]) for item in anchor["published_pt_signals"]} == {
        ("olaparib", "anaemia"),
        ("niraparib", "constipation"),
        ("talazoparib", "anaemia"),
    }
    assert all(
        item["n"] >= 3 and item["ror"] > 1 and item["ror_lower"] > 1
        for item in anchor["published_pt_signals"]
    )


def test_jak_publication_ror_eb05_and_sensitivity_directions_are_frozen():
    anchor = _anchors()["anchors"]["jaki-verden-2021"]

    assert all(
        item["n"] >= 3
        and item["ror_lower"] > 1
        and item["eb05"] > 1
        for item in anchor["published_pt_signals"]
    )
    assert "No tendency" in anchor["sensitivity_conclusion"]
    assert "estimator" in anchor["comparison_status"]


@pytest.mark.parametrize(
    ("class_id", "member_name", "member_id", "event", "cells", "published_ror"),
    [
        (
            "sglt2i",
            "canagliflozin",
            "canagliflozin",
            "diabetic ketoacidosis",
            (10, 10, 2, 20),
            10.0,
        ),
        ("parpi", "olaparib", "olaparib", "anaemia", (473, 1000, 10, 298), 14.10),
        (
            "jaki",
            "tofacitinib",
            "tofacitinib",
            "pulmonary thrombosis",
            (34, 1000, 10, 694),
            2.36,
        ),
    ],
)
def test_published_direction_panels_execute_the_production_class_engine(
    class_id, member_name, member_id, event, cells, published_ror
):
    snapshot = _calibrated_panel(
        member_name,
        event,
        a=cells[0],
        b=cells[1],
        c=cells[2],
        d=cells[3],
    )

    result = ClassAnalysisEngine(snapshot).run(class_id, [event])
    row = next(
        item
        for item in result.comparisons
        if item.target_id == member_id and item.comparator == "all_faers"
    )

    assert (row.a, row.b, row.c, row.d) == pytest.approx(cells)
    assert row.ror == pytest.approx(published_ror, abs=0.01)
    assert row.ror_ci95_lower > 1


def test_published_jak_panel_executes_indexed_sqlite_production_path(tmp_path):
    source = _calibrated_panel(
        "tofacitinib", "pulmonary thrombosis", a=34, b=1000, c=10, d=694
    )
    path = write_sqlite_snapshot(
        source.reports, source.provenance, tmp_path / "jak-paper-panel.sqlite"
    )

    result = ClassAnalysisEngine(SQLiteFAERSSnapshot.from_path(path)).run(
        "jaki", ["pulmonary thrombosis"]
    )
    row = next(
        item
        for item in result.comparisons
        if item.target_id == "tofacitinib" and item.comparator == "all_faers"
    )

    assert row.ror == pytest.approx(2.36, abs=0.01)
    assert row.ror_ci95_lower > 1
