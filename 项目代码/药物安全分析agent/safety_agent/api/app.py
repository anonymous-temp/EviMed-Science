"""FastAPI application: REST endpoints + unified error wrapping.

Endpoints (see README for the full contract):
    GET  /health
    POST /api/v1/adr/analyze        (202 async, or ?wait=true for sync)
    GET  /api/v1/adr/jobs/{id}
    GET  /api/v1/adr/jobs/{id}/report[.docx|.pdf]
    GET  /api/v1/adr/signals

Error contract: every failure is answered as ``{"code": int, "msg": str}``
with a sanitized message — internal exception details go to the logs only,
never to the client.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse

from safety_agent.core.config import get_settings
from safety_agent.core.exceptions import (
    NoDataError,
    NoResults,
    NormalizationError,
    OpenFDAError,
    OpenFDARateLimited,
    OpenFDAUnavailable,
    SafetyAgentError,
)
from safety_agent.core.logging import get_logger
from safety_agent.report.markdown import render_markdown
from safety_agent.drug_classes import DrugClassRegistry
from safety_agent.report.class_markdown import render_class_markdown

from .schemas import (
    AnalyzeAccepted,
    AnalyzeRequest,
    ClassAnalyzeRequest,
    JobStatusResponse,
    SignalsResponse,
)
from .service import ServiceContext

logger = get_logger(__name__)

AGENT_TYPE = "drug-safety-analysis"

_DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def create_app(
    *,
    service: ServiceContext | None = None,
    enable_ws: bool = True,
) -> FastAPI:
    """Application factory. Tests pass a stubbed ``service`` and no WS."""
    app = FastAPI(title="EviMed Drug Safety Analysis Agent", version="0.6.0")
    app.state.service = service
    app.state.enable_ws = enable_ws

    # -- routes ----------------------------------------------------------

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": AGENT_TYPE}

    @app.post("/api/v1/adr/analyze", status_code=202, response_model=None)
    async def analyze(request: Request, body: AnalyzeRequest, wait: bool = Query(False)):
        svc = _service(request)
        if wait:
            result, artifacts = await svc.run_sync(body.drug, body.reactions, body.language)
            payload = result.model_dump(mode="json")
            payload["artifacts"] = {
                name: str(path) for name, path in artifacts.items() if path is not None
            }
            return JSONResponse(payload, status_code=200)
        job = svc.jobs.create(body.drug, body.reactions, body.language, body.indication)
        job.task = asyncio.create_task(svc.run_job(job))
        return AnalyzeAccepted(jobId=job.id)

    @app.get("/api/v1/adr/jobs/{job_id}", response_model=None)
    async def job_status(request: Request, job_id: str):
        svc = _service(request)
        job = svc.jobs.get(job_id)
        if job is None:
            return _error(404, f"job {job_id} 不存在或已过期")
        return JobStatusResponse(
            status=job.status,
            progress=job.progress,
            stage=job.stage,
            error=job.error,
            result=job.summary(),
        )

    @app.get("/api/v1/adr/jobs/{job_id}/report")
    async def job_report_markdown(request: Request, job_id: str):
        job = _finished_job(request, job_id)
        if job.result is None:
            return _error(500, "报告结果缺失")
        return PlainTextResponse(
            render_markdown(job.result), media_type="text/markdown; charset=utf-8"
        )

    @app.get("/api/v1/adr/jobs/{job_id}/report.docx")
    async def job_report_docx(request: Request, job_id: str):
        return _artifact_file(request, job_id, "docx", _DOCX_MEDIA, "safety-report.docx")

    @app.get("/api/v1/adr/jobs/{job_id}/report.pdf")
    async def job_report_pdf(request: Request, job_id: str):
        return _artifact_file(request, job_id, "pdf", "application/pdf", "safety-report.pdf")

    @app.get("/api/v1/adr/signals", response_model=None)
    async def signals(
        request: Request,
        drug: str = Query(..., min_length=1),
        reaction: str = Query(..., min_length=1),
    ):
        svc = _service(request)
        reactions = [item.strip() for item in reaction.split(",") if item.strip()]
        if not reactions:
            return _error(400, "reaction 参数不能为空")
        computation = await svc.compute_signals(drug, reactions)
        return SignalsResponse(
            drug=drug,
            drug_normalized=computation.drug_normalized,
            drug_field_used=computation.drug_field_used,
            ps_only=(
                computation.data_source == "frozen_faers"
                and computation.suspect_roles == ["PS"]
            ),
            data_source=computation.data_source,
            suspect_binding=computation.suspect_binding,
            suspect_roles=computation.suspect_roles,
            administration_routes=computation.administration_routes or [],
            snapshot_id=computation.snapshot_id,
            snapshot_source=computation.snapshot_source,
            snapshot_sha256=computation.snapshot_sha256,
            snapshot_extracted_at=computation.snapshot_extracted_at,
            snapshot_deduplication=computation.snapshot_deduplication,
            study_date_from=computation.study_date_from,
            study_date_to=computation.study_date_to,
            background_date_from=computation.background_date_from,
            background_date_to=computation.background_date_to,
            statistics_version=computation.statistics_version,
            gps_prior_fitted=computation.gps_prior_fitted,
            gps_prior_id=computation.gps_prior_id,
            rows=computation.rows,
            query_urls=computation.query_urls,
        )

    @app.get("/api/v1/adr/classes", response_model=None)
    async def drug_classes():
        registry = DrugClassRegistry.bundled()
        return {
            "classes": [
                {
                    "id": class_id,
                    "display_name": registry.get(class_id).display_name,
                    "version": registry.get(class_id).version,
                    "atc_codes": list(registry.get(class_id).atc_codes),
                    "members": [member.id for member in registry.get(class_id).members],
                }
                for class_id in registry.ids()
            ]
        }

    @app.post("/api/v1/adr/classes/analyze", response_model=None)
    async def analyze_drug_class(
        request: Request,
        body: ClassAnalyzeRequest,
        report: bool = Query(False),
    ):
        svc = _service(request)
        try:
            result = await svc.compute_class_analysis(
                body.class_id, body.reactions, body.role_codes
            )
        except KeyError as error:
            return _error(404, str(error))
        if report:
            return PlainTextResponse(
                render_class_markdown(result),
                media_type="text/markdown; charset=utf-8",
            )
        return result.model_dump(mode="json")

    # -- exception handlers (unified {code,msg}) ----------------------------

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        details = []
        for error in exc.errors()[:5]:
            location = ".".join(str(part) for part in error.get("loc", []))
            details.append(f"{location}: {error.get('msg', 'invalid')}")
        return _error(422, "请求参数校验失败 — " + "; ".join(details))

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "request failed"
        return _error(exc.status_code, detail)

    @app.exception_handler(NormalizationError)
    async def normalization_handler(request: Request, exc: NormalizationError):
        return _error(400, exc.message)

    @app.exception_handler(NoDataError)
    async def no_data_handler(request: Request, exc: NoDataError):
        return _error(404, exc.message)

    @app.exception_handler(NoResults)
    async def no_results_handler(request: Request, exc: NoResults):
        return _error(404, "openFDA 未检索到匹配记录")

    @app.exception_handler(OpenFDARateLimited)
    async def rate_limit_handler(request: Request, exc: OpenFDARateLimited):
        return _error(429, "openFDA 限流,请稍后重试")

    @app.exception_handler(OpenFDAUnavailable)
    async def openfda_down_handler(request: Request, exc: OpenFDAUnavailable):
        return _error(502, "openFDA 暂不可用,请稍后重试")

    @app.exception_handler(OpenFDAError)
    async def openfda_handler(request: Request, exc: OpenFDAError):
        return _error(502, exc.message)

    @app.exception_handler(SafetyAgentError)
    async def agent_error_handler(request: Request, exc: SafetyAgentError):
        logger.warning("request failed: %s", exc)
        return _error(500, exc.message)

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception):
        logger.error("unhandled error on %s: %s", request.url.path, exc, exc_info=True)
        return _error(500, "internal error")

    return app


# -- helpers -----------------------------------------------------------------


def _service(request: Request) -> ServiceContext:
    service = request.app.state.service
    if service is None:  # lifespan not run (e.g. bare TestClient)
        service = ServiceContext(get_settings())
        request.app.state.service = service
    return service


def _error(code: int, msg: str) -> JSONResponse:
    return JSONResponse({"code": code, "msg": msg}, status_code=code)


def _finished_job(request: Request, job_id: str):
    svc = _service(request)
    job = svc.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"job {job_id} 不存在或已过期")
    if job.status != "succeeded":
        raise HTTPException(
            status_code=409, detail=f"job {job_id} 未完成(当前状态:{job.status})"
        )
    return job


def _artifact_file(
    request: Request, job_id: str, kind: str, media_type: str, filename: str
):
    job = _finished_job(request, job_id)
    path = job.artifacts.get(kind)
    if path is None or not Path(path).is_file():
        return _error(404, f"job {job_id} 没有 {kind} 产物(可能已被降级跳过)")
    return FileResponse(path, media_type=media_type, filename=filename)
