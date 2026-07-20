"""REST API contract tests (TestClient, stubbed service layer, no network).

The stub openFDA counts reproduce the T1 known-answer panel (a=10, b=90,
c=20, d=1880, N=2000) so numeric assertions stay honest.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from safety_agent.api.app import create_app
from safety_agent.api.service import ServiceContext
from safety_agent.core.config import Settings
from safety_agent.core.exceptions import NoResults
from safety_agent.evidence.evimed import EviMedEvidenceClient
from safety_agent.faers import FrozenFAERSSnapshot
from safety_agent.openfda.client import CountTerm
from safety_agent.signals import (
    MGPSFitResult,
    MGPSPrior,
    gps_prior_fit_id,
    gps_scope_fingerprint,
    write_gps_fit_artifact,
)

T1_ROR = 10.4444444444
DATA = Path(__file__).parent / "data"


class StubOpenFDA:
    async def count_total(self, search: str | None = None) -> int:
        if search is None:
            return 2000
        drug = 'patient.drug.medicinalproduct:"atorvastatin"' in search
        reaction = "patient.reaction.reactionmeddrapt" in search
        if drug and reaction:
            return 10
        if drug:
            if "receivedate" in search:
                return 5
            if "patientonsetage" in search:
                return 20
            if "seriousness" in search:
                return 30
            return 100
        if reaction:
            return 30
        return 0

    async def count_terms(self, field: str, search: str | None = None, *, limit: int = 100):
        if field == "patient.reaction.reactionmeddrapt.exact":
            return [CountTerm("Myalgia", 35), CountTerm("Nausea", 40)]
        if field == "patient.drug.medicinalproduct.exact":
            return [CountTerm("ATORVASTATIN", 100)]
        if field == "patient.patientsex":
            return [CountTerm("1", 55), CountTerm("2", 45)]
        return [CountTerm("us", 80)]

    async def search_labels(self, drug=None, *, search=None, limit=3):
        return []

    async def aclose(self) -> None:
        return None


class EmptyOpenFDA(StubOpenFDA):
    async def count_total(self, search: str | None = None) -> int:
        if search and "medicinalproduct" in search:
            return 0
        return await super().count_total(search)


class MetforminOpenFDA(StubOpenFDA):
    async def count_total(self, search: str | None = None) -> int:
        if search and "metformin" in search.casefold():
            return 10
        return await super().count_total(search)


class EmptyJointOpenFDA(StubOpenFDA):
    async def count_total(self, search: str | None = None) -> int:
        if (
            search
            and "medicinalproduct" in search
            and "reactionmeddrapt" in search
        ):
            raise NoResults(search=search)
        return await super().count_total(search)


def _client(openfda=None, tmp_path=None, faers_snapshot=None) -> TestClient:
    settings = Settings(deepseek_api_key=SecretStr(""))
    service = ServiceContext(
        settings,
        openfda=openfda or StubOpenFDA(),
        llm=None,
        evidence=EviMedEvidenceClient("", ""),
        faers_snapshot=faers_snapshot,
        jobs_dir=tmp_path,
    )
    return TestClient(create_app(service=service, enable_ws=False))


@pytest.fixture
def client(tmp_path):
    # The context manager keeps the anyio portal (and thus background job
    # tasks) alive across requests.
    with _client(tmp_path=tmp_path) as test_client:
        yield test_client


# -- health & validation ---------------------------------------------------------


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_analyze_missing_drug_is_422(client):
    response = client.post("/api/v1/adr/analyze", json={"reactions": ["myalgia"]})
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == 422 and "drug" in body["msg"]


def test_analyze_blank_drug_is_422(client):
    response = client.post("/api/v1/adr/analyze", json={"drug": "   "})
    assert response.status_code == 422
    assert response.json()["code"] == 422


def test_analyze_bad_language_is_422(client):
    response = client.post(
        "/api/v1/adr/analyze", json={"drug": "atorvastatin", "language": "fr"}
    )
    assert response.status_code == 422


def test_analyze_null_reactions_accepted(client):
    response = client.post(
        "/api/v1/adr/analyze?wait=true", json={"drug": "atorvastatin", "reactions": None}
    )
    assert response.status_code == 200


# -- sync analyze (?wait=true) -----------------------------------------------------


def test_analyze_wait_returns_full_result(client):
    response = client.post(
        "/api/v1/adr/analyze?wait=true",
        json={"drug": "atorvastatin", "reactions": ["myalgia"]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["drug_normalized"] == "atorvastatin"
    assert body["drug_field_used"] == "medicinalproduct"
    assert body["ps_only"] is False
    assert body["data_source"] == "openfda_live"
    assert body["suspect_binding"] == "report_contains_suspect_approximation"
    assert body["suspect_roles"] == ["PS", "SS"]
    assert body["overview"]["total_reports"] == 100
    assert len(body["signals"]) >= 1
    row = next(r for r in body["signals"] if r["reaction"] == "myalgia")
    assert row["ror"] == pytest.approx(T1_ROR, rel=1e-6)
    assert row["is_signal"] is True
    assert "markdown" in body["artifacts"]


def test_signals_uses_exact_frozen_snapshot_metadata(tmp_path):
    snapshot = FrozenFAERSSnapshot.from_path(DATA / "faers_report_binding.json")
    with _client(
        openfda=MetforminOpenFDA(),
        tmp_path=tmp_path,
        faers_snapshot=snapshot,
    ) as test_client:
        response = test_client.get(
            "/api/v1/adr/signals", params={"drug": "metformin", "reaction": "nausea"}
        )
    assert response.status_code == 200
    body = response.json()
    assert body["drug_field_used"] == "frozen_normalized"
    assert body["ps_only"] is True
    assert body["data_source"] == "frozen_faers"
    assert body["suspect_binding"] == "same_drug_object"
    assert body["suspect_roles"] == ["PS"]
    assert body["snapshot_id"] == "synthetic-binding-v1"
    assert body["snapshot_source"] == "synthetic regression fixture"
    assert len(body["snapshot_sha256"]) == 64
    assert body["snapshot_extracted_at"] == "2026-07-20T00:00:00Z"
    assert body["snapshot_deduplication"] == "latest_case_version"
    assert body["statistics_version"] == "gps-v2"
    assert body["rows"][0]["expected_count"] == pytest.approx(1.0 / 3.0)
    assert body["rows"][0]["haldane_anscombe_applied"] is True


def test_service_loads_snapshot_bound_gps_prior_artifact(tmp_path):
    fingerprint = "b" * 64
    fit_id = gps_prior_fit_id(
        data_fingerprint=fingerprint,
        alpha1=0.3,
        beta1=0.2,
        alpha2=2.5,
        beta2=3.0,
        weight=0.4,
    )
    fit = MGPSFitResult(
        prior=MGPSPrior(
            0.3,
            0.2,
            2.5,
            3.0,
            0.4,
            fitted=True,
            fit_id=fit_id,
        ),
        negative_log_likelihood=10.0,
        converged=True,
        iterations=20,
        observations=100,
        data_fingerprint=fingerprint,
        message="converged",
        successful_starts=3,
        near_optimal_starts=3,
        parameter_agreement_starts=3,
    )
    prior_path = write_gps_fit_artifact(
        fit,
        tmp_path / "gps-prior.json",
        snapshot_id="synthetic-binding-v1",
        snapshot_sha256=FrozenFAERSSnapshot.from_path(
            DATA / "faers_report_binding.json"
        ).provenance.sha256,
        scope_fingerprint=gps_scope_fingerprint(
            date_from="2020-01-01", date_to="2020-12-31"
        ),
    )
    settings = Settings(
        deepseek_api_key=SecretStr(""),
        faers_snapshot_path=DATA / "faers_report_binding.json",
        faers_study_date_from="2020-01-01",
        faers_study_date_to="2020-12-31",
        gps_prior_artifact_path=prior_path,
    )
    service = ServiceContext(
        settings,
        openfda=StubOpenFDA(),
        llm=None,
        evidence=EviMedEvidenceClient("", ""),
        jobs_dir=tmp_path / "jobs",
    )
    with TestClient(create_app(service=service, enable_ws=False)):
        assert service.gps_prior == fit.prior
        assert service.study_date_from.isoformat() == "2020-01-01"
        assert service.study_date_to.isoformat() == "2020-12-31"


def test_service_accepts_live_scope_controls_without_snapshot(tmp_path):
    settings = Settings(
        deepseek_api_key=SecretStr(""),
        faers_drug_aliases="lipitor,atorvastatin calcium",
        faers_suspect_roles="PS,SS",
        faers_administration_routes="048",
        faers_study_date_from="2020-01-01",
        faers_study_date_to="2020-12-31",
        faers_background_date_from="2019-01-01",
        faers_background_date_to="2021-12-31",
    )
    service = ServiceContext(
        settings,
        openfda=StubOpenFDA(),
        llm=None,
        evidence=EviMedEvidenceClient("", ""),
        jobs_dir=tmp_path,
    )
    with TestClient(create_app(service=service, enable_ws=False)):
        assert service.drug_aliases == ("lipitor", "atorvastatin calcium")
        assert service.suspect_roles == frozenset({"PS", "SS"})
        assert service.drug_routes == ("048",)
        assert service.study_date_from.isoformat() == "2020-01-01"
        assert service.background_date_from.isoformat() == "2019-01-01"


def test_analyze_wait_no_data_is_404(tmp_path):
    with _client(openfda=EmptyOpenFDA(), tmp_path=tmp_path) as client:
        response = client.post(
            "/api/v1/adr/analyze?wait=true", json={"drug": "atorvastatin", "reactions": ["myalgia"]}
        )
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == 404 and "未检索到" in body["msg"]


def test_analyze_wait_unresolvable_adr_is_400(client):
    response = client.post(
        "/api/v1/adr/analyze?wait=true",
        json={"drug": "atorvastatin", "reactions": ["某种不存在的不良反应xyz"]},
    )
    assert response.status_code == 400
    assert response.json()["code"] == 400


# -- async job flow ------------------------------------------------------------------


def test_async_job_flow_end_to_end(client):
    response = client.post(
        "/api/v1/adr/analyze", json={"drug": "atorvastatin", "reactions": ["myalgia"]}
    )
    assert response.status_code == 202
    job_id = response.json()["jobId"]

    deadline = time.time() + 60
    status_body = None
    while time.time() < deadline:
        poll = client.get(f"/api/v1/adr/jobs/{job_id}")
        assert poll.status_code == 200
        status_body = poll.json()
        if status_body["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.3)
    assert status_body is not None and status_body["status"] == "succeeded"
    assert status_body["progress"] == 100
    assert status_body["error"] is None
    assert status_body["result"]["drug"] == "atorvastatin"
    assert status_body["result"]["totalReports"] == 100
    assert status_body["result"]["signalsFound"] >= 1
    assert "markdown" in status_body["result"]["artifacts"]

    report = client.get(f"/api/v1/adr/jobs/{job_id}/report")
    assert report.status_code == 200
    assert report.headers["content-type"].startswith("text/markdown")
    assert "atorvastatin — FAERS 药物安全性分析报告" in report.text
    assert "10.444" in report.text  # T1 ROR rendered to 3 decimals

    docx = client.get(f"/api/v1/adr/jobs/{job_id}/report.docx")
    assert docx.status_code == 200
    assert docx.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert len(docx.content) > 5000


def test_unknown_job_is_404(client):
    response = client.get("/api/v1/adr/jobs/doesnotexist")
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == 404 and "不存在" in body["msg"]
    report = client.get("/api/v1/adr/jobs/doesnotexist/report")
    assert report.status_code == 404
    assert report.json()["code"] == 404


def test_failed_job_surfaces_safe_error(tmp_path):
    with _client(openfda=EmptyOpenFDA(), tmp_path=tmp_path) as client:
        response = client.post(
            "/api/v1/adr/analyze", json={"drug": "atorvastatin", "reactions": ["myalgia"]}
        )
        job_id = response.json()["jobId"]
        deadline = time.time() + 30
        body = None
        while time.time() < deadline:
            body = client.get(f"/api/v1/adr/jobs/{job_id}").json()
            if body["status"] == "failed":
                break
            time.sleep(0.2)
        report = client.get(f"/api/v1/adr/jobs/{job_id}/report")
    assert body["status"] == "failed"
    assert "未检索到" in body["error"]
    # no traceback or internal detail in the error field
    assert "Traceback" not in body["error"]
    assert report.status_code == 409
    assert report.json()["code"] == 409


# -- lightweight signals endpoint ----------------------------------------------------


def test_signals_endpoint_returns_ror(client):
    response = client.get("/api/v1/adr/signals", params={"drug": "atorvastatin", "reaction": "myalgia"})
    assert response.status_code == 200
    body = response.json()
    assert body["drug_normalized"] == "atorvastatin"
    assert len(body["rows"]) == 1
    row = body["rows"][0]
    assert row["ror"] == pytest.approx(T1_ROR, rel=1e-6)
    assert row["is_signal"] is True
    assert "signal_joint[myalgia]" in body["query_urls"]


def test_signals_endpoint_multiple_reactions(client):
    response = client.get(
        "/api/v1/adr/signals", params={"drug": "atorvastatin", "reaction": "myalgia,肌病"}
    )
    assert response.status_code == 200
    assert {r["reaction"] for r in response.json()["rows"]} == {"myalgia", "myopathy"}


def test_signals_endpoint_treats_empty_joint_count_as_zero(tmp_path):
    with _client(openfda=EmptyJointOpenFDA(), tmp_path=tmp_path) as test_client:
        response = test_client.get(
            "/api/v1/adr/signals",
            params={"drug": "atorvastatin", "reaction": "myalgia"},
        )
    assert response.status_code == 200
    row = response.json()["rows"][0]
    assert row["a"] == 0
    assert row["haldane_anscombe_applied"] is True


def test_signals_endpoint_missing_params_is_422(client):
    assert client.get("/api/v1/adr/signals").status_code == 422
    assert client.get("/api/v1/adr/signals", params={"drug": "x"}).status_code == 422


def test_signals_endpoint_no_data_is_404(tmp_path):
    with _client(openfda=EmptyOpenFDA(), tmp_path=tmp_path) as client:
        response = client.get(
            "/api/v1/adr/signals", params={"drug": "atorvastatin", "reaction": "myalgia"}
        )
    assert response.status_code == 404


def test_signals_endpoint_unresolvable_reaction_is_400(client):
    response = client.get(
        "/api/v1/adr/signals",
        params={"drug": "atorvastatin", "reaction": "某种不存在的不良反应xyz"},
    )
    assert response.status_code == 400
