"""Authenticated REST surface for typed MetaAgent project actions."""
from __future__ import annotations

import hmac
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from new_meta.core.project import Project
from new_meta.core.release_contract import ReleaseStatus, load_release_decision
from new_meta.schemas.phase_result import (
    ArtifactRef,
    ExecutionStatus,
    NextAction,
    PhaseIssue,
    PhaseName,
    PhaseResult,
)


_BEARER = HTTPBearer(auto_error=False, scheme_name="BearerAuth")


class ResultRoBAdjudicationRequest(BaseModel):
    project_dir: str = Field(min_length=1)
    expected_revision: int = Field(ge=0)
    reason: str = Field(min_length=1)
    assessment: dict


class ResultRoBAdjudicationResponse(BaseModel):
    ok: bool
    project_dir: str
    current_revision: int
    assessment: dict
    readiness: dict
    cleared_checkpoints: list[str]


class MethodExecutionRequest(BaseModel):
    project_dir: str = Field(min_length=1)
    result_ids: list[str] = Field(min_length=1)
    options: dict = Field(default_factory=dict)


class AnalysisSetAdjudicationRequest(BaseModel):
    project_dir: str = Field(min_length=1)
    candidate_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_revision: int = Field(ge=0)
    reason: str = Field(min_length=1)


class MethodCertaintyAdjudicationRequest(BaseModel):
    project_dir: str = Field(min_length=1)
    expected_revision: int = Field(ge=0)
    reason: str = Field(min_length=1)
    domain_overrides: dict = Field(min_length=2)


def api_cors_origins() -> list[str]:
    """Return an explicit CORS allowlist; an unset value means no CORS."""
    return [
        origin.strip()
        for origin in os.getenv("METAAGENT_CORS_ALLOWED_ORIGINS", "").split(",")
        if origin.strip() and origin.strip() != "*"
    ]


def require_api_token(
    credentials: HTTPAuthorizationCredentials | None = Security(_BEARER),
) -> str:
    configured = os.getenv("METAAGENT_API_TOKEN", "")
    if not configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MetaAgent API is disabled until METAAGENT_API_TOKEN is configured",
        )
    supplied = credentials.credentials if credentials is not None else ""
    if credentials is None or credentials.scheme.lower() != "bearer" or not hmac.compare_digest(supplied, configured):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Valid Bearer token required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return "api_client"


def create_api_router(output_root: str | Path) -> APIRouter:
    root = Path(output_root).resolve()
    router = APIRouter(prefix="/api/v1", tags=["MetaAgent v1"])

    @router.get(
        "/projects/status",
        response_model=PhaseResult,
        dependencies=[],
    )
    def project_status(
        project_dir: str = Query(min_length=1),
        identity: str = Security(require_api_token),
    ) -> PhaseResult:
        project_path = _resolve_project_path(project_dir, root)
        project = Project("API status", resume_dir=project_path)
        return _release_phase_result(project)

    @router.post(
        "/projects/result-rob-adjudications",
        response_model=ResultRoBAdjudicationResponse,
    )
    def adjudicate_result_rob(
        request: ResultRoBAdjudicationRequest,
        identity: str = Security(require_api_token),
    ) -> ResultRoBAdjudicationResponse:
        from new_meta.core.result_rob import save_result_rob_adjudication
        from new_meta.schemas.risk_of_bias import ResultRoBAssessment, RoBAssessmentStatus

        project_path = _resolve_project_path(request.project_dir, root)
        project = Project("API result RoB adjudication", resume_dir=project_path)
        queued = project.load_json("rob_result_assessments.json", subdir="risk_of_bias") or []
        queued_ids = {
            str(item.get("result_id") or "")
            for item in queued
            if isinstance(item, dict)
        }
        assessment_data = dict(request.assessment)
        result_id = str(assessment_data.get("result_id") or "")
        if result_id not in queued_ids:
            raise HTTPException(status_code=422, detail="result_id is not in the RoB review queue")
        assessment_data.update({
            "assessment_status": RoBAssessmentStatus.ADJUDICATED.value,
            "adjudicated_by": identity,
            "assessment_origin": "human_adjudication",
            "requires_adjudication": False,
        })
        assessment = ResultRoBAssessment.model_validate(assessment_data)
        manifest = save_result_rob_adjudication(
            project,
            assessment,
            expected_revision=request.expected_revision,
            reason=request.reason,
        )
        return ResultRoBAdjudicationResponse(
            ok=True,
            project_dir=str(project.base_dir),
            current_revision=int(manifest["current_revision"]),
            assessment=assessment.model_dump(mode="json"),
            readiness=project.load_json("rob_result_readiness.json", subdir="risk_of_bias") or {},
            cleared_checkpoints=project.clear_downstream("rob"),
        )

    @router.post("/projects/method-executions")
    def execute_method_plan(
        request: MethodExecutionRequest,
        identity: str = Security(require_api_token),
    ) -> dict:
        from new_meta.core.method_executor import MethodExecutionBlocked, MethodExecutor
        from new_meta.schemas.method_policy import MethodPlan

        project_path = _resolve_project_path(request.project_dir, root)
        project = Project("API method execution", resume_dir=project_path)
        raw_plan = project.load_json("method_plan.json", subdir="analysis")
        if not raw_plan:
            raise HTTPException(status_code=409, detail="compiled method_plan.json is required")
        try:
            result = MethodExecutor().execute_project(
                MethodPlan.model_validate(raw_plan),
                project=project,
                result_ids=request.result_ids,
                options=request.options,
            )
        except MethodExecutionBlocked as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return result.model_dump(mode="json")

    @router.post("/projects/analysis-set-adjudications")
    def adjudicate_analysis_set(
        request: AnalysisSetAdjudicationRequest,
        identity: str = Security(require_api_token),
    ) -> dict:
        from new_meta.core.analysis_set import (
            AnalysisSetConflictError,
            save_analysis_set_adjudication,
        )

        project_path = _resolve_project_path(request.project_dir, root)
        project = Project("API analysis-set adjudication", resume_dir=project_path)
        try:
            decision = save_analysis_set_adjudication(
                project,
                candidate_id=request.candidate_id,
                expected_revision=request.expected_revision,
                selected_by=identity,
                reason=request.reason,
            )
        except AnalysisSetConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "ok": True,
            "project_dir": str(project.base_dir),
            "current_revision": decision.revision,
            "decision": decision.model_dump(mode="json"),
        }

    @router.post("/projects/method-certainty-adjudications")
    def adjudicate_method_certainty(
        request: MethodCertaintyAdjudicationRequest,
        identity: str = Security(require_api_token),
    ) -> dict:
        from new_meta.core.method_certainty import (
            MethodCertaintyConflictError,
            save_method_certainty_adjudication,
        )

        project_path = _resolve_project_path(request.project_dir, root)
        project = Project("API method certainty adjudication", resume_dir=project_path)
        try:
            assessment = save_method_certainty_adjudication(
                project,
                expected_revision=request.expected_revision,
                adjudicated_by=identity,
                reason=request.reason,
                domain_overrides=request.domain_overrides,
            )
        except MethodCertaintyConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        cleared = project.clear_downstream("grade")
        project.save_checkpoint("grade")
        return {
            "ok": True,
            "project_dir": str(project.base_dir),
            "current_revision": assessment.revision,
            "assessment": assessment.model_dump(mode="json"),
            "cleared_checkpoints": cleared,
        }

    return router


def _resolve_project_path(project_dir: str, output_root: Path) -> Path:
    path = Path(project_dir)
    if not path.is_absolute():
        path = output_root / path
    resolved = path.resolve()
    if resolved != output_root and output_root not in resolved.parents:
        raise HTTPException(status_code=400, detail="project_dir must be inside the configured output root")
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=404, detail="project not found")
    return resolved


def _release_phase_result(project: Project) -> PhaseResult:
    decision = load_release_decision(project)
    if not decision:
        return PhaseResult(
            run_id=project.base_dir.name,
            phase=PhaseName.RELEASE,
            status=ExecutionStatus.NEEDS_INPUT,
            summary="No release decision has been generated for this project.",
            issues=[
                PhaseIssue(
                    code="missing_release_decision",
                    message="Build the artifact package to evaluate release gates.",
                    blocking=True,
                )
            ],
            next_actions=[
                NextAction(
                    action_id="build_artifact_package",
                    title="Build artifact package",
                    description="Run the downstream package phase before requesting release status.",
                )
            ],
        )
    raw_status = str(decision.get("status") or "").lower()
    blocked = raw_status == ReleaseStatus.BLOCKED.value
    issues = [
        PhaseIssue(
            code=str(code),
            message=_release_issue_message(str(code), decision),
            blocking=True,
        )
        for code in decision.get("blocker_codes") or []
    ]
    for code in decision.get("warning_codes") or []:
        issues.append(
            PhaseIssue(
                code=str(code),
                message=f"Release warning requires review: {code}",
                blocking=False,
            )
        )
    artifacts = [
        ArtifactRef(
            artifact_id=f"release_artifact_{index}",
            kind=str(item.get("kind") or "artifact"),
            path=str(item.get("path")),
        )
        for index, item in enumerate(decision.get("artifacts") or [], start=1)
        if isinstance(item, dict) and str(item.get("path") or "").strip()
    ]
    return PhaseResult(
        run_id=project.base_dir.name,
        phase=PhaseName.RELEASE,
        status=ExecutionStatus.BLOCKED if blocked else ExecutionStatus.SUCCEEDED,
        summary=str(decision.get("summary") or "Release decision available."),
        checkpoint="release",
        artifacts=artifacts,
        issues=issues,
        next_actions=[
            NextAction(
                action_id=f"release_action_{index}",
                title="Release next action",
                description=str(action),
            )
            for index, action in enumerate(decision.get("next_actions") or [], start=1)
            if str(action).strip()
        ],
        data={"release_decision": decision},
    )


def _release_issue_message(code: str, decision: dict) -> str:
    for gate in decision.get("failed_gates") or []:
        if str(gate.get("id") or gate.get("name") or "") == code:
            return str(gate.get("detail") or gate.get("message") or f"Release gate failed: {code}")
    return f"Release gate failed: {code}"
