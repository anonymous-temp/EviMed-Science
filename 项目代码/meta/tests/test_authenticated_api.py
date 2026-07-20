from uuid import uuid4

from fastapi.testclient import TestClient

from start import META_ROOT, app
from new_meta.api import api_cors_origins
from new_meta.core.project import Project
from new_meta.schemas.method_certainty import (
    CertaintyDomainRating,
    MethodCertaintyAssessment,
    MethodCertaintyDomain,
    MethodCertaintyOutcome,
    MethodCertaintyStatus,
)
from new_meta.schemas.method_policy import ReviewFamily


def _project() -> Project:
    root = META_ROOT / "output" / "pytest_api" / uuid4().hex
    project = Project("API project", output_dir=root)
    project.save_json(
        "release_decision.json",
        {
            "schema_version": 1,
            "status": "blocked",
            "summary": "Release requires result-level adjudication.",
            "blocker_codes": ["result_specific_rob_incomplete"],
            "next_actions": ["Complete the result-level RoB review queue."],
            "artifacts": [],
        },
        subdir="package",
    )
    return project


def test_api_is_closed_when_server_token_is_not_configured(monkeypatch) -> None:
    monkeypatch.delenv("METAAGENT_API_TOKEN", raising=False)
    response = TestClient(app).get(
        "/api/v1/projects/status",
        params={"project_dir": str(_project().base_dir)},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "MetaAgent API is disabled until METAAGENT_API_TOKEN is configured"


def test_project_api_requires_and_validates_bearer_token(monkeypatch) -> None:
    monkeypatch.setenv("METAAGENT_API_TOKEN", "secret-token")
    project = _project()
    client = TestClient(app)

    missing = client.get(
        "/api/v1/projects/status",
        params={"project_dir": str(project.base_dir)},
    )
    wrong = client.get(
        "/api/v1/projects/status",
        params={"project_dir": str(project.base_dir)},
        headers={"Authorization": "Bearer wrong"},
    )
    accepted = client.get(
        "/api/v1/projects/status",
        params={"project_dir": str(project.base_dir)},
        headers={"Authorization": "Bearer secret-token"},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "blocked"
    assert accepted.json()["phase"] == "release"
    assert accepted.json()["issues"][0]["code"] == "result_specific_rob_incomplete"


def test_api_cors_has_no_wildcard_default(monkeypatch) -> None:
    monkeypatch.delenv("METAAGENT_CORS_ALLOWED_ORIGINS", raising=False)
    assert api_cors_origins() == []

    monkeypatch.setenv(
        "METAAGENT_CORS_ALLOWED_ORIGINS",
        "https://review.example.org, https://admin.example.org",
    )
    assert api_cors_origins() == [
        "https://review.example.org",
        "https://admin.example.org",
    ]


def test_openapi_exposes_authenticated_typed_project_actions() -> None:
    schema = app.openapi()

    assert "/api/v1/projects/result-rob-adjudications" in schema["paths"]
    assert "/api/v1/projects/method-executions" in schema["paths"]
    assert "/api/v1/projects/analysis-set-adjudications" in schema["paths"]
    assert "/api/v1/projects/method-certainty-adjudications" in schema["paths"]
    assert "BearerAuth" in schema["components"]["securitySchemes"]


def test_method_certainty_adjudication_is_available_through_authenticated_api(monkeypatch) -> None:
    monkeypatch.setenv("METAAGENT_API_TOKEN", "secret-token")
    project = _project()
    project.save_json(
        "method_certainty.json",
        MethodCertaintyAssessment(
            status=MethodCertaintyStatus.NEEDS_INPUT,
            family=ReviewFamily.PREVALENCE_INCIDENCE,
            framework="GRADE-adapted certainty for prevalence estimates",
            framework_note="Context domains require human adjudication.",
            plan_fingerprint="fingerprint",
            input_result_ids=["result:s1:0"],
            outcomes=[
                MethodCertaintyOutcome(
                    outcome_id="pooled_prevalence",
                    outcome_label="Pooled prevalence",
                    domains=[
                        MethodCertaintyDomain(domain="risk_of_bias", rating="no_concern", rationale="Complete."),
                        MethodCertaintyDomain(domain="inconsistency", rating="no_concern", rationale="Narrow prediction interval."),
                        MethodCertaintyDomain(
                            domain="indirectness",
                            rating=CertaintyDomainRating.NOT_ASSESSED,
                            rationale="Human review required.",
                            requires_human_judgment=True,
                        ),
                        MethodCertaintyDomain(domain="imprecision", rating="no_concern", rationale="Narrow interval."),
                        MethodCertaintyDomain(
                            domain="publication_bias",
                            rating=CertaintyDomainRating.NOT_ASSESSED,
                            rationale="Human review required.",
                            requires_human_judgment=True,
                        ),
                    ],
                )
            ],
        ),
        subdir="analysis",
    )

    response = TestClient(app).post(
        "/api/v1/projects/method-certainty-adjudications",
        headers={"Authorization": "Bearer secret-token"},
        json={
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "reason": "Protocol applicability and reporting bias reviewed.",
            "domain_overrides": {
                "indirectness": {
                    "rating": "no_concern",
                    "rationale": "Population and setting match the protocol.",
                },
                "publication_bias": {
                    "rating": "serious",
                    "rationale": "Selective non-publication cannot be excluded.",
                },
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["assessment"]["status"] == "completed"
    assert response.json()["assessment"]["adjudicated_by"] == "api_client"
    assert response.json()["current_revision"] == 1


def test_result_rob_adjudication_is_available_through_authenticated_api(monkeypatch) -> None:
    monkeypatch.setenv("METAAGENT_API_TOKEN", "secret-token")
    project = _project()
    project.save_json(
        "rob_result_assessments.json",
        [
            {
                "assessment_id": "rob:result:s1:0:draft",
                "result_id": "result:s1:0",
                "study_id": "S1",
                "outcome_name": "mortality",
                "tool_used": "RoB 2",
                "tool_version": "RoB 2 v2 (2019)",
                "target_effect": "assignment",
                "assessment_status": "draft",
                "domains": [],
                "overall_judgment": "",
                "requires_adjudication": True,
            }
        ],
        subdir="risk_of_bias",
    )
    response = TestClient(app).post(
        "/api/v1/projects/result-rob-adjudications",
        headers={"Authorization": "Bearer secret-token"},
        json={
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "reason": "Source and protocol checked by the reviewer.",
            "assessment": {
                "assessment_id": "rob:result:s1:0:adjudicated",
                "result_id": "result:s1:0",
                "study_id": "S1",
                "outcome_name": "mortality",
                "tool_used": "RoB 2",
                "tool_version": "RoB 2 v2 (2019)",
                "target_effect": "assignment",
                "assessment_status": "adjudicated",
                "domains": [
                    {
                        "domain": "Randomization process",
                        "judgment": "Low risk",
                        "support": "Allocation concealment was adequate.",
                        "source_quote": "Opaque sealed envelopes concealed allocation.",
                        "source_page": 3,
                    }
                ],
                "overall_judgment": "Low risk",
                "requires_adjudication": False,
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["assessment"]["adjudicated_by"] == "api_client"
    assert response.json()["readiness"]["status"] == "ready"
