"""Shared service context: long-lived clients + job execution helpers.

One ServiceContext lives on ``app.state`` for the process lifetime; the
openFDA client (with its cache) and the LLM client are created once and
reused across jobs, then closed on shutdown.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import quote

from safety_agent.analysis.models import AnalysisResult
from safety_agent.analysis.pipeline import AnalysisPipeline
from safety_agent.analysis.runner import write_artifacts
from safety_agent.core.config import PROJECT_ROOT, Settings
from safety_agent.core.exceptions import (
    NoDataError,
    NoResults,
    NormalizationError,
    SafetyAgentError,
)
from safety_agent.core.logging import get_logger
from safety_agent.evidence.evimed import EviMedEvidenceClient
from safety_agent.drug_classes import ClassAnalysisEngine, ClassAnalysisResult
from safety_agent.faers import DrugScope, FrozenFAERSSnapshot, load_faers_snapshot
from safety_agent.llm.client import DeepSeekClient
from safety_agent.llm.fallbacks import DeepSeekNameTranslator
from safety_agent.normalize.adr import normalize_adr_async
from safety_agent.normalize.drugs import normalize_drug
from safety_agent.openfda.client import OpenFDAClient
from safety_agent.openfda.queries import (
    DRUG_FIELD_MEDICINALPRODUCT,
    DRUG_FIELD_OPENFDA_GENERIC,
    drug_clause,
    date_range_clause,
    reaction_clause,
    route_clause,
    suspect_only_clause,
)
from safety_agent.signals import (
    DEFAULT_MGPS_PRIOR,
    ContingencyTable2x2,
    SignalMetrics,
    analyze,
    build_table_from_counts,
    evaluate,
    gps_scope_fingerprint,
    load_gps_prior_artifact,
)

from .jobs import Job, JobStore

logger = get_logger(__name__)


@dataclass(frozen=True)
class SignalComputationResult:
    drug_normalized: str
    rows: list[dict]
    query_urls: dict[str, str]
    drug_field_used: str
    data_source: str
    suspect_binding: str
    suspect_roles: list[str]
    snapshot_id: str | None
    snapshot_source: str | None = None
    snapshot_sha256: str | None = None
    snapshot_extracted_at: str | None = None
    snapshot_deduplication: str | None = None
    study_date_from: str | None = None
    study_date_to: str | None = None
    administration_routes: list[str] | None = None
    background_date_from: str | None = None
    background_date_to: str | None = None
    statistics_version: str = "gps-v2"
    gps_prior_fitted: bool = False
    gps_prior_id: str | None = None


def _scoped_drug_search(
    drug_name: str,
    drug_field: str,
    ps_only: bool,
    *,
    aliases: tuple[str, ...] = (),
    routes: tuple[str, ...] = (),
    date_from: date | str | None = None,
    date_to: date | str | None = None,
) -> str:
    """Drug clause + suspect filter (same construction as the pipeline)."""
    names = (drug_name, *aliases) if drug_field == DRUG_FIELD_MEDICINALPRODUCT else (drug_name,)
    clauses = [drug_clause(name, field=drug_field) for name in dict.fromkeys(names)]
    base = clauses[0] if len(clauses) == 1 else "(" + " OR ".join(clauses) + ")"
    if ps_only:
        base = f"({base}) AND ({suspect_only_clause()})"
    if routes:
        route_search = " OR ".join(route_clause(route) for route in routes)
        base = f"({base}) AND ({route_search})"
    if date_from is not None or date_to is not None:
        base = f"({base}) AND ({date_range_clause(date_from, date_to)})"
    return base


class ServiceContext:
    """Owns the shared clients and the job store."""

    def __init__(
        self,
        settings: Settings,
        *,
        openfda: "object | None" = None,
        llm: "object | None" = None,
        evidence: "object | None" = None,
        faers_snapshot: FrozenFAERSSnapshot | None = None,
        jobs_dir: Path | None = None,
        max_concurrent_jobs: int | None = None,
        drug_aliases: tuple[str, ...] | None = None,
        suspect_roles: frozenset[str] | None = None,
        drug_routes: tuple[str, ...] | None = None,
        study_date_from: date | str | None = None,
        study_date_to: date | str | None = None,
        background_date_from: date | str | None = None,
        background_date_to: date | str | None = None,
    ) -> None:
        self.settings = settings
        self.openfda = openfda if openfda is not None else OpenFDAClient.from_settings(settings)
        if llm is not None:
            self.llm = llm
        elif settings.deepseek_api_key.get_secret_value():
            self.llm = DeepSeekClient.from_settings(settings)
        else:
            self.llm = None
            logger.warning("DEEPSEEK_API_KEY empty; LLM steps will degrade")
        # CJK translation seam for the normalize layer (None when no LLM).
        self.name_translator = (
            DeepSeekNameTranslator(self.llm) if self.llm is not None else None
        )
        self.evidence = (
            evidence if evidence is not None else EviMedEvidenceClient.from_settings(settings)
        )
        snapshot_path = settings.resolved_faers_snapshot_path
        self.faers_snapshot = (
            faers_snapshot
            if faers_snapshot is not None
            else load_faers_snapshot(snapshot_path)
            if snapshot_path is not None
            else None
        )
        aliases = settings.parsed_faers_drug_aliases if drug_aliases is None else drug_aliases
        roles = settings.parsed_faers_suspect_roles if suspect_roles is None else suspect_roles
        routes = settings.parsed_faers_administration_routes if drug_routes is None else drug_routes
        validated_scope = DrugScope(
            names=("scope-validation", *aliases),
            role_codes=roles,
            routes=routes,
            date_from=settings.faers_study_date_from if study_date_from is None else study_date_from,
            date_to=settings.faers_study_date_to if study_date_to is None else study_date_to,
            background_date_from=(
                settings.faers_background_date_from
                if background_date_from is None
                else background_date_from
            ),
            background_date_to=(
                settings.faers_background_date_to
                if background_date_to is None
                else background_date_to
            ),
        )
        self.drug_aliases = tuple(
            name for name in validated_scope.names if name != "scope-validation"
        )
        self.suspect_roles = validated_scope.role_codes
        self.drug_routes = validated_scope.routes
        self.study_date_from = validated_scope.date_from
        self.study_date_to = validated_scope.date_to
        self.background_date_from = validated_scope.background_date_from
        self.background_date_to = validated_scope.background_date_to
        self.gps_scope_fingerprint = (
            gps_scope_fingerprint(
                date_from=(
                    self.study_date_from.isoformat()
                    if self.study_date_from is not None
                    else None
                ),
                date_to=(
                    self.study_date_to.isoformat()
                    if self.study_date_to is not None
                    else None
                ),
                role_codes=tuple(self.suspect_roles),
                deduplication=self.faers_snapshot.provenance.deduplication,
                routes=self.drug_routes,
                background_date_from=(
                    self.background_date_from.isoformat()
                    if self.background_date_from is not None
                    and self.background_date_from != self.study_date_from
                    else None
                ),
                background_date_to=(
                    self.background_date_to.isoformat()
                    if self.background_date_to is not None
                    and self.background_date_to != self.study_date_to
                    else None
                ),
            )
            if self.faers_snapshot is not None
            else None
        )
        prior_path = settings.resolved_gps_prior_artifact_path
        if prior_path is not None and self.faers_snapshot is None:
            raise ValueError("GPS prior artifacts require a configured frozen FAERS snapshot")
        self.gps_prior = (
            load_gps_prior_artifact(
                prior_path,
                expected_snapshot_id=self.faers_snapshot.provenance.snapshot_id,
                expected_snapshot_sha256=self.faers_snapshot.provenance.sha256,
                expected_scope_fingerprint=self.gps_scope_fingerprint,
            )
            if prior_path is not None and self.faers_snapshot is not None
            else DEFAULT_MGPS_PRIOR
        )
        self.jobs = JobStore(jobs_dir or (PROJECT_ROOT / "jobs"))
        self._sem = asyncio.Semaphore(max_concurrent_jobs or settings.max_concurrent_sessions)

    async def aclose(self) -> None:
        await self.openfda.aclose()
        if self.llm is not None:
            await self.llm.aclose()
        await self.evidence.aclose()

    # -- full analysis jobs -------------------------------------------------

    def make_pipeline(
        self, on_stage=None, *, timeout_seconds: float = 300.0
    ) -> AnalysisPipeline:
        return AnalysisPipeline(
            openfda=self.openfda,
            llm=self.llm,
            evidence=self.evidence,
            on_stage=on_stage,
            timeout_seconds=timeout_seconds,
            openfda_base_url=self.settings.openfda_base_url,
            name_fallback=self.name_translator,
            adr_fallback=self.name_translator,
            faers_snapshot=self.faers_snapshot,
            drug_aliases=self.drug_aliases,
            suspect_roles=self.suspect_roles,
            drug_routes=self.drug_routes,
            study_date_from=self.study_date_from,
            study_date_to=self.study_date_to,
            background_date_from=self.background_date_from,
            background_date_to=self.background_date_to,
            gps_prior=self.gps_prior,
        )

    async def run_job(self, job: Job) -> None:
        """Execute one job end-to-end, updating progress as stages advance."""
        job.status = "running"

        def on_stage(stage: str, status: str, detail: dict) -> None:
            self.jobs.update_stage(job, stage, status)

        async with self._sem:
            try:
                pipeline = self.make_pipeline(on_stage=on_stage)
                result = await pipeline.run(
                    job.drug, job.reactions, language=job.language
                )
                job.result = result
                job.stage = "write"
                job.progress = 95
                # Artifact export (docx/pdf conversion) is sync CPU/subprocess
                # work; keep the event loop responsive.
                job.artifacts = await asyncio.to_thread(
                    write_artifacts, result, self.jobs.job_dir(job)
                )
                job.status = "succeeded"
                job.progress = 100
                job.stage = "finished"
            except asyncio.CancelledError:
                job.status = "failed"
                job.error = "job cancelled"
                raise
            except Exception as exc:  # typed errors carry a safe .message
                job.status = "failed"
                job.error = getattr(exc, "message", None) or "analysis failed"
                job.exception = exc
                logger.warning("job %s failed: %s", job.id, exc)

    async def run_sync(
        self, drug: str, reactions: list[str], language: str
    ) -> tuple[AnalysisResult, dict[str, Path | None]]:
        """Synchronous (?wait=true) analysis: result + artifacts."""
        job = self.jobs.create(drug, reactions, language, None)
        await self.run_job(job)
        if job.status != "succeeded" or job.result is None:
            if job.exception is not None:
                raise job.exception
            raise SafetyAgentError(job.error or "analysis failed")
        return job.result, job.artifacts

    async def compute_class_analysis(
        self,
        class_id: str,
        reactions: list[str],
        role_codes: list[str],
    ) -> ClassAnalysisResult:
        """Run exact report-level class methods against the configured snapshot."""
        if self.faers_snapshot is None:
            raise SafetyAgentError(
                "drug-class analysis requires a configured frozen report-level FAERS snapshot"
            )
        engine = ClassAnalysisEngine(self.faers_snapshot, prior=self.gps_prior)
        async with self._sem:
            return await asyncio.wait_for(
                asyncio.to_thread(
                    engine.run,
                    class_id,
                    reactions,
                    role_codes=frozenset(role_codes),
                    date_from=self.study_date_from,
                    date_to=self.study_date_to,
                ),
                timeout=300,
            )

    # -- lightweight signal endpoint ------------------------------------------

    async def compute_signals(
        self,
        drug: str,
        reactions: list[str],
        *,
        drug_field: str = DRUG_FIELD_OPENFDA_GENERIC,
        ps_only: bool = True,
    ) -> SignalComputationResult:
        """Normalize + 2x2 + metrics only (no overview, no LLM).

        Returns normalized drug, rows, query refs, field, data source,
        binding mode, role codes, and optional snapshot id.
        """
        drug_norm = await normalize_drug(
            drug, client=self.openfda, llm_fallback=self.name_translator
        )
        if not drug_norm.normalized:
            raise NormalizationError(f"药品名无法归一化: {drug}")
        normalized: list[str] = []
        for query in reactions:
            result = await normalize_adr_async(query, llm_fallback=self.name_translator)
            if result.normalized is None:
                raise NormalizationError(
                    f"ADR 词无法归一化: {query}",
                    detail=f"candidates: {[c.term for c in result.candidates]}",
                )
            normalized.append(result.normalized)
        if not normalized:
            raise NormalizationError("reaction 参数不能为空")

        if self.faers_snapshot is not None:
            scope = DrugScope(
                names=(drug_norm.normalized, *self.drug_aliases),
                role_codes=self.suspect_roles,
                routes=self.drug_routes,
                date_from=self.study_date_from,
                date_to=self.study_date_to,
                background_date_from=self.background_date_from,
                background_date_to=self.background_date_to,
            )

            async def exact_row(reaction: str) -> dict:
                counts = await asyncio.to_thread(
                    self.faers_snapshot.contingency, scope, reaction
                )
                table = build_table_from_counts(
                    counts.joint,
                    counts.drug_total,
                    counts.event_total,
                    counts.grand_total,
                )
                metrics = analyze(table, prior=self.gps_prior)
                decision = evaluate(metrics)
                return _signal_dict(reaction, table, metrics, decision.is_signal)

            rows = await asyncio.gather(*(exact_row(reaction) for reaction in normalized))
            if not rows or all(row["a"] + row["b"] == 0 for row in rows):
                raise NoDataError(f"冻结 FAERS 快照中未检索到 {drug_norm.normalized} 的目标报告")
            return SignalComputationResult(
                drug_normalized=drug_norm.normalized,
                rows=rows,
                query_urls={},
                drug_field_used="frozen_normalized",
                data_source="frozen_faers",
                suspect_binding="same_drug_object",
                suspect_roles=sorted(scope.role_codes),
                administration_routes=list(scope.routes),
                snapshot_id=self.faers_snapshot.provenance.snapshot_id,
                gps_prior_fitted=self.gps_prior.fitted,
                gps_prior_id=self.gps_prior.fit_id,
                snapshot_source=self.faers_snapshot.provenance.source,
                snapshot_sha256=self.faers_snapshot.provenance.sha256,
                snapshot_extracted_at=self.faers_snapshot.provenance.extracted_at,
                snapshot_deduplication=self.faers_snapshot.provenance.deduplication,
                study_date_from=(
                    scope.date_from.isoformat() if scope.date_from is not None else None
                ),
                study_date_to=(
                    scope.date_to.isoformat() if scope.date_to is not None else None
                ),
                background_date_from=(
                    scope.background_date_from.isoformat()
                    if scope.background_date_from is not None
                    else None
                ),
                background_date_to=(
                    scope.background_date_to.isoformat()
                    if scope.background_date_to is not None
                    else None
                ),
            )

        drug_search = _scoped_drug_search(
            drug_norm.normalized,
            drug_field,
            ps_only,
            aliases=self.drug_aliases,
            routes=self.drug_routes,
            date_from=self.study_date_from,
            date_to=self.study_date_to,
        )
        background_search = (
            date_range_clause(self.background_date_from, self.background_date_to)
            if self.background_date_from is not None or self.background_date_to is not None
            else None
        )
        try:
            drug_total, grand_total = await asyncio.gather(
                self.openfda.count_total(drug_search),
                self.openfda.count_total(background_search),
            )
        except NoResults:
            drug_total = 0
            grand_total = await self.openfda.count_total(background_search)
        if drug_total == 0 and drug_field == DRUG_FIELD_OPENFDA_GENERIC:
            # same documented fallback as the full pipeline
            logger.warning(
                "no reports via openfda_generic for %r; falling back to medicinalproduct",
                drug_norm.normalized,
            )
            drug_field = DRUG_FIELD_MEDICINALPRODUCT
            drug_search = _scoped_drug_search(
                drug_norm.normalized,
                drug_field,
                ps_only,
                aliases=self.drug_aliases,
                routes=self.drug_routes,
                date_from=self.study_date_from,
                date_to=self.study_date_to,
            )
            try:
                drug_total = await self.openfda.count_total(drug_search)
            except NoResults:
                drug_total = 0
        if drug_total == 0:
            raise NoDataError(f"FAERS 中未检索到 {drug_norm.normalized} 的任何报告")

        async def one(reaction: str) -> dict:
            clause = reaction_clause(reaction)
            async with self._sem:
                joint, event_total = await asyncio.gather(
                    _count_or_zero(
                        self.openfda, f"({drug_search}) AND ({clause})"
                    ),
                    _count_or_zero(
                        self.openfda,
                        f"({clause}) AND ({background_search})"
                        if background_search is not None
                        else clause,
                    ),
                )
            table = build_table_from_counts(joint, drug_total, event_total, grand_total)
            metrics = analyze(table, prior=self.gps_prior)
            decision = evaluate(metrics)
            return _signal_dict(reaction, table, metrics, decision.is_signal)

        rows = list(await asyncio.gather(*(one(r) for r in normalized)))
        base = self.settings.openfda_base_url.rstrip("/")
        urls = {
            "drug_total": f"{base}/drug/event.json?limit=1&search=" + quote(drug_search),
            "grand_total": f"{base}/drug/event.json?limit=1",
        }
        for reaction in normalized:
            urls[f"signal_joint[{reaction}]"] = (
                f"{base}/drug/event.json?limit=1&search="
                + quote(f"({drug_search}) AND ({reaction_clause(reaction)})")
            )
        return SignalComputationResult(
            drug_normalized=drug_norm.normalized,
            rows=rows,
            query_urls=urls,
            drug_field_used=drug_field,
            data_source="openfda_live",
            suspect_binding=(
                "report_contains_suspect_approximation" if ps_only else "target_name_only"
            ),
            suspect_roles=["PS", "SS"] if ps_only else ["PS", "SS", "C", "I"],
            administration_routes=list(self.drug_routes),
            snapshot_id=None,
            study_date_from=(
                self.study_date_from.isoformat() if self.study_date_from is not None else None
            ),
            study_date_to=(
                self.study_date_to.isoformat() if self.study_date_to is not None else None
            ),
            background_date_from=(
                self.background_date_from.isoformat()
                if self.background_date_from is not None
                else self.study_date_from.isoformat()
                if self.study_date_from is not None
                else None
            ),
            background_date_to=(
                self.background_date_to.isoformat()
                if self.background_date_to is not None
                else self.study_date_to.isoformat()
                if self.study_date_to is not None
                else None
            ),
            gps_prior_fitted=False,
            gps_prior_id=None,
        )


def _signal_dict(
    reaction: str,
    table: ContingencyTable2x2,
    metrics: SignalMetrics,
    is_signal: bool,
) -> dict:
    """Shared API serialization for live and frozen signal providers."""
    return {
        "reaction": reaction,
        "a": table.a,
        "b": table.b,
        "c": table.c,
        "d": table.d,
        "n": table.n,
        "ror": metrics.ror.value,
        "ror_ci95_lower": metrics.ror.ci95_lower,
        "ror_ci95_upper": metrics.ror.ci95_upper,
        "prr": metrics.prr.value,
        "prr_ci95_lower": metrics.prr.ci95_lower,
        "prr_ci95_upper": metrics.prr.ci95_upper,
        "chi2": metrics.chi2.value,
        "ic": metrics.ic.value,
        "ic025": metrics.ic.ic025,
        "ebgm": metrics.ebgm.value,
        "eb05": metrics.ebgm.eb05,
        "expected_count": metrics.ebgm.expected,
        "haldane_anscombe_applied": metrics.haldane_anscombe_applied,
        "gps_prior_id": metrics.ebgm.prior.fit_id,
        "is_signal": is_signal,
    }


async def _count_or_zero(client: object, search: str) -> int:
    """Map a valid empty openFDA count query to zero."""
    try:
        return await client.count_total(search)  # type: ignore[attr-defined]
    except NoResults:
        return 0
