"""End-to-end class analysis uses the same frozen production path."""

from datetime import date
import sqlite3

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from safety_agent.api.app import create_app
from safety_agent.api.service import ServiceContext
from safety_agent.core.config import Settings
from safety_agent.drug_classes import ClassAnalysisEngine
from safety_agent.evidence.evimed import EviMedEvidenceClient
from safety_agent.core.exceptions import NoDataError
from safety_agent.faers import (
    DrugEntry,
    FrozenFAERSSnapshot,
    ReportRecord,
    SnapshotProvenance,
    SQLiteFAERSSnapshot,
    write_sqlite_snapshot,
)
from safety_agent.report import class_signal_csv, render_class_markdown
from safety_agent.signals import MGPSPrior


def _drug(name: str, role: str = "PS", start: str | None = None) -> DrugEntry:
    return DrugEntry(
        medicinal_product=name.upper(),
        normalized_names=(name,),
        role_code=role,
        therapy_start_date=date.fromisoformat(start) if start else None,
    )


def _report(pid, received, drugs, reactions, event=None):
    return ReportRecord(
        primary_id=pid,
        case_id=pid,
        case_version=1,
        received_date=date.fromisoformat(received),
        event_date=date.fromisoformat(event) if event else None,
        drugs=tuple(drugs),
        reactions=tuple(reactions),
    )


def _snapshot():
    dka = "diabetic ketoacidosis"
    reports = [
        _report("c1", "2013-05-10", [_drug("canagliflozin", start="2013-05-01")], [dka], "2013-05-06"),
        _report("c2", "2013-06-10", [_drug("canagliflozin")], ["nausea"]),
        _report("d1", "2013-07-10", [_drug("dapagliflozin", start="2013-07-01")], [dka], "2013-07-08"),
        _report("d2", "2013-08-10", [_drug("dapagliflozin"), _drug("metformin", "C")], ["nausea"]),
        _report("both", "2013-09-10", [_drug("canagliflozin"), _drug("dapagliflozin")], [dka]),
        _report("met", "2013-10-10", [_drug("metformin")], [dka]),
        _report("background", "2013-11-10", [_drug("unrelated")], [dka]),
    ]
    return FrozenFAERSSnapshot(
        reports,
        SnapshotProvenance(
            snapshot_id="class-e2e-v1",
            source="synthetic class e2e fixture",
            extracted_at="2026-07-20T00:00:00Z",
        ),
    )


def _two_member_snapshot(first: str, second: str, comparator: str, event: str):
    reports = [
        _report("first-event", "2020-01-10", [_drug(first)], [event]),
        _report("first-other", "2020-02-10", [_drug(first)], ["nausea"]),
        _report("second-event", "2020-03-10", [_drug(second)], [event]),
        _report("second-other", "2020-04-10", [_drug(second)], ["nausea"]),
        _report("comparator-event", "2020-05-10", [_drug(comparator)], [event]),
        _report("comparator-other", "2020-06-10", [_drug(comparator)], ["nausea"]),
        _report("background", "2020-07-10", [_drug("unrelated")], [event]),
    ]
    return FrozenFAERSSnapshot(
        reports,
        SnapshotProvenance(
            snapshot_id="four-class-production-path-v1",
            source="synthetic four-class method fixture",
            extracted_at="2026-07-20T00:00:00Z",
        ),
    )


def test_class_engine_covers_every_paper_method_family():
    result = ClassAnalysisEngine(_snapshot()).run(
        "sglt2i", ["diabetic ketoacidosis"]
    )

    modes = {row.comparator for row in result.comparisons}
    assert result.total_reports == 5
    assert result.member_report_counts["empagliflozin"] == 0
    assert "empagliflozin" in result.members_without_reports
    assert not any(row.target_id == "empagliflozin" for row in result.comparisons)
    assert {"all_faers", "rest_of_class", "therapeutic_area"} <= modes
    assert result.therapy_strata.monotherapy == 4
    assert result.therapy_strata.polytherapy == 1
    assert result.time_to_onset[0].observed == 2
    assert result.time_to_onset[0].missing == 1
    assert result.taxonomy[0].is_ime is True
    assert result.taxonomy[0].soc == "Metabolism and nutrition disorders"
    assert result.approval_sensitivity
    overlap_rows = [
        row for row in result.comparisons
        if row.target_id == "canagliflozin" and row.comparator == "rest_of_class"
    ]
    assert overlap_rows[0].overlap_excluded == 1

    markdown = render_class_markdown(result)
    csv_text = class_signal_csv(result)
    assert "Shared and unique signals" in markdown
    assert "SOC / SMQ / IME" in markdown
    assert "overlap_excluded" in csv_text
    assert "expected_count" in csv_text


@pytest.mark.parametrize(
    ("class_id", "first", "second", "comparator", "event"),
    [
        ("sglt2i", "canagliflozin", "dapagliflozin", "metformin", "diabetic ketoacidosis"),
        ("glp1ra-products", "byetta", "victoza", "metformin", "pancreatitis"),
        ("parpi", "lynparza", "zejula", "carboplatin", "myelodysplastic syndrome"),
        ("jaki", "jakafi", "xeljanz", "adalimumab", "pulmonary embolism"),
    ],
)
def test_all_four_publication_classes_run_through_production_engine(
    class_id, first, second, comparator, event
):
    result = ClassAnalysisEngine(
        _two_member_snapshot(first, second, comparator, event)
    ).run(class_id, [event])

    modes = {row.comparator for row in result.comparisons}
    assert {"all_faers", "rest_of_class", "therapeutic_area"} <= modes
    assert result.taxonomy_coverage == 1.0
    assert sum(count > 0 for count in result.member_report_counts.values()) == 2
    assert result.members_without_reports


def test_unknown_pt_is_rejected_instead_of_becoming_haldane_estimate():
    with pytest.raises(NoDataError, match="requested reactions"):
        ClassAnalysisEngine(_snapshot()).run("sglt2i", ["unknown paper pt"])


def test_active_comparators_skip_empty_event_columns():
    event = "pulmonary embolism"
    reports = [
        _report("canag", "2020-01-01", [_drug("canagliflozin")], ["nausea"]),
        _report("dapa", "2020-02-01", [_drug("dapagliflozin")], ["nausea"]),
        _report("met", "2020-03-01", [_drug("metformin")], ["nausea"]),
        _report("background-event", "2020-04-01", [_drug("unrelated")], [event]),
        _report("background-other", "2020-05-01", [_drug("unrelated")], ["headache"]),
    ]
    snapshot = FrozenFAERSSnapshot(
        reports,
        SnapshotProvenance(
            snapshot_id="empty-comparator-event-column",
            source="synthetic estimability fixture",
            extracted_at="2026-07-20T00:00:00Z",
        ),
    )

    result = ClassAnalysisEngine(snapshot).run("sglt2i", [event])

    assert any(row.comparator == "all_faers" for row in result.comparisons)
    assert not any(
        row.comparator in {"rest_of_class", "therapeutic_area"}
        for row in result.comparisons
    )


def test_class_result_carries_fitted_prior_provenance():
    prior = MGPSPrior(fitted=True, fit_id="gps-fixture-v1")
    result = ClassAnalysisEngine(_snapshot(), prior=prior).run(
        "sglt2i", ["diabetic ketoacidosis"]
    )

    assert result.gps_prior_fitted is True
    assert result.gps_prior_id == "gps-fixture-v1"
    assert all(row.gps_prior_id == "gps-fixture-v1" for row in result.comparisons)
    assert all(row.expected_count >= 0 for row in result.comparisons)


def test_legacy_v2_snapshot_degrades_tto_without_failing_class_analysis(tmp_path):
    source = _snapshot()
    path = write_sqlite_snapshot(
        source.reports, source.provenance, tmp_path / "class-v2.sqlite"
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

    result = ClassAnalysisEngine(SQLiteFAERSSnapshot.from_path(path)).run(
        "sglt2i", ["diabetic ketoacidosis"]
    )

    assert result.time_to_onset_available is False
    assert result.time_to_onset == []
    assert any("schema v3" in note for note in result.limitations)


class _ClosableOpenFDA:
    async def aclose(self):
        return None


def test_class_rest_api_lists_definitions_and_runs_frozen_analysis(tmp_path):
    service = ServiceContext(
        Settings(deepseek_api_key=SecretStr("")),
        openfda=_ClosableOpenFDA(),
        llm=None,
        evidence=EviMedEvidenceClient("", ""),
        faers_snapshot=_snapshot(),
        jobs_dir=tmp_path,
    )
    with TestClient(create_app(service=service, enable_ws=False)) as client:
        listing = client.get("/api/v1/adr/classes")
        assert listing.status_code == 200
        assert "sglt2i" in {item["id"] for item in listing.json()["classes"]}

        response = client.post(
            "/api/v1/adr/classes/analyze",
            json={"class_id": "sglt2i", "reactions": ["diabetic ketoacidosis"]},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["snapshot_id"] == "class-e2e-v1"
        assert body["suspect_binding"] == "same_drug_object"
        assert body["statistics_version"] == "gps-v2"
        assert {row["comparator"] for row in body["comparisons"]} >= {
            "all_faers", "rest_of_class", "therapeutic_area"
        }

        report = client.post(
            "/api/v1/adr/classes/analyze?report=true",
            json={"class_id": "sglt2i", "reactions": ["diabetic ketoacidosis"]},
        )
        assert report.status_code == 200
        assert "First-year post-approval sensitivity" in report.text


def test_class_rest_api_bounds_reaction_workload(tmp_path):
    service = ServiceContext(
        Settings(deepseek_api_key=SecretStr("")),
        openfda=_ClosableOpenFDA(),
        llm=None,
        evidence=EviMedEvidenceClient("", ""),
        faers_snapshot=_snapshot(),
        jobs_dir=tmp_path,
    )
    with TestClient(create_app(service=service, enable_ws=False)) as client:
        too_many = client.post(
            "/api/v1/adr/classes/analyze",
            json={"class_id": "sglt2i", "reactions": [f"pt-{i}" for i in range(21)]},
        )
        too_long = client.post(
            "/api/v1/adr/classes/analyze",
            json={"class_id": "sglt2i", "reactions": ["x" * 201]},
        )

    assert too_many.status_code == 422
    assert too_long.status_code == 422
