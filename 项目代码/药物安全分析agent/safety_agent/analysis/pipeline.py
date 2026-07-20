"""The six-stage analysis pipeline.

    normalize -> overview -> signals -> label cross-check (+ evidence)
    -> LLM interpretation -> assemble

Failure policy (explicit, never silent):
- drug name unresolvable        -> NormalizationError (maps to HTTP 400);
- zero FAERS reports for drug   -> NoDataError (clear "no data" outcome);
- target ADR unresolvable       -> NormalizationError with candidates;
- openFDA outage mid-run        -> typed OpenFDAError propagates;
- LLM label check / interpret   -> degraded report (statistics + methodology
                                   note), never a failed run;
- evidence layer unconfigured   -> skipped with a visible note;
- the whole run is bounded by ``timeout_seconds``.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any
from urllib.parse import quote

from safety_agent.analysis.interpret import interpret_results
from safety_agent.analysis.models import (
    AnalysisResult,
    NormalizedReaction,
    SignalRow,
)
from safety_agent.analysis.overview import OverviewBuilder
from safety_agent.core.exceptions import (
    EvidenceSearchError,
    LLMError,
    NoDataError,
    NoResults,
    NormalizationError,
)
from safety_agent.core.logging import get_logger
from safety_agent.evidence.label_check import check_label_coverage
from safety_agent.evidence.models import EvidenceLayerResult
from safety_agent.faers import DrugScope, FrozenFAERSSnapshot
from safety_agent.normalize.adr import normalize_adr_async
from safety_agent.normalize.drugs import normalize_drug
from safety_agent.openfda.queries import (
    DRUG_FIELD_MEDICINALPRODUCT,
    DRUG_FIELD_OPENFDA_GENERIC,
    FIELD_REACTION_EXACT,
    date_range_clause,
    drug_clause,
    reaction_clause,
    route_clause,
    suspect_only_clause,
)
from safety_agent.signals import (
    DEFAULT_MGPS_PRIOR,
    MGPSPrior,
    analyze,
    build_table_from_counts,
    evaluate,
)

logger = get_logger(__name__)

#: (stage, status, detail) -> None or awaitable; status: started|finished|degraded
StageCallback = Callable[[str, str, dict[str, Any]], "Awaitable[None] | None"]

DEFAULT_TIMEOUT_SECONDS = 300.0


class AnalysisPipeline:
    """Orchestrates one full drug-safety analysis run."""

    def __init__(
        self,
        *,
        openfda: "object",
        llm: "object | None" = None,
        evidence: "object | None" = None,
        on_stage: StageCallback | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        top_pt_count: int = 10,
        signal_concurrency: int = 8,
        openfda_base_url: str = "https://api.fda.gov",
        name_fallback: "object | None" = None,
        adr_fallback: "object | None" = None,
        drug_field: str = DRUG_FIELD_OPENFDA_GENERIC,
        ps_only: bool = True,
        faers_snapshot: FrozenFAERSSnapshot | None = None,
        drug_aliases: tuple[str, ...] = (),
        suspect_roles: frozenset[str] = frozenset({"PS"}),
        drug_routes: tuple[str, ...] = (),
        study_date_from: date | str | None = None,
        study_date_to: date | str | None = None,
        background_date_from: date | str | None = None,
        background_date_to: date | str | None = None,
        gps_prior: MGPSPrior = DEFAULT_MGPS_PRIOR,
    ) -> None:
        self._openfda = openfda
        self._llm = llm
        self._evidence = evidence
        self._on_stage = on_stage
        self._timeout = timeout_seconds
        self._top_pt_count = top_pt_count
        self._sem = asyncio.Semaphore(signal_concurrency)
        self._base_url = openfda_base_url.rstrip("/")
        # LLM translation seams for CJK inputs (DrugNameLLMFallback /
        # AdrTermLLMFallback protocols; None keeps rules-only behavior).
        self._name_fallback = name_fallback
        self._adr_fallback = adr_fallback
        # Pharmacovigilance query conventions (READUS-PV aligned):
        # standardized generic-name field + suspect-only approximation.
        # drugcharacterization:1 covers PS+SS — see queries.py notes.
        self._drug_field = drug_field
        self._ps_only = ps_only
        self._faers_snapshot = faers_snapshot
        self._drug_aliases = drug_aliases
        validated_scope = DrugScope(
            names=("scope-validation",),
            role_codes=suspect_roles,
            routes=drug_routes,
            date_from=study_date_from,
            date_to=study_date_to,
            background_date_from=background_date_from,
            background_date_to=background_date_to,
        )
        self._suspect_roles = validated_scope.role_codes
        self._drug_routes = validated_scope.routes
        self._study_date_from = validated_scope.date_from
        self._study_date_to = validated_scope.date_to
        self._background_date_from = validated_scope.background_date_from
        self._background_date_to = validated_scope.background_date_to
        self._gps_prior = gps_prior

    async def run(
        self,
        drug: str,
        reactions: list[str] | None = None,
        *,
        language: str = "zh",
    ) -> AnalysisResult:
        return await asyncio.wait_for(
            self._run(drug, reactions or [], language=language),
            timeout=self._timeout,
        )

    # -- stages -------------------------------------------------------------

    async def _run(
        self, drug: str, reaction_queries: list[str], *, language: str
    ) -> AnalysisResult:
        notes: list[str] = []

        # 1) normalize
        await self._emit("normalize", "started")
        drug_norm = await normalize_drug(
            drug, client=self._openfda, llm_fallback=self._name_fallback
        )
        if not drug_norm.normalized:
            raise NormalizationError(
                f"药品名无法归一化: {drug}",
                detail=f"candidates: {[c.term for c in drug_norm.candidates]}",
            )
        normalized_reactions: list[NormalizedReaction] = []
        for query in reaction_queries:
            result = await normalize_adr_async(query, llm_fallback=self._adr_fallback)
            if result.normalized is None:
                raise NormalizationError(
                    f"ADR 词无法归一化: {query}",
                    detail=f"candidates: {[c.term for c in result.candidates]}",
                )
            normalized_reactions.append(
                NormalizedReaction(
                    query=query,
                    normalized=result.normalized,
                    method=result.method,
                    confidence=result.confidence,
                )
            )
        await self._emit("normalize", "finished", normalized=drug_norm.normalized)

        # 2) case overview (also proves data availability). When the
        # standardized generic-name field yields nothing, fall back to the
        # raw medicinalproduct field and say so — never silently.
        await self._emit("overview", "started")
        snapshot_scope: DrugScope | None = None
        if self._faers_snapshot is not None:
            snapshot_scope = DrugScope(
                names=(drug_norm.normalized, *self._drug_aliases),
                role_codes=self._suspect_roles,
                routes=self._drug_routes,
                date_from=self._study_date_from,
                date_to=self._study_date_to,
                background_date_from=self._background_date_from,
                background_date_to=self._background_date_to,
            )
            overview = await asyncio.to_thread(
                self._faers_snapshot.overview, snapshot_scope
            )
            drug_field_used = "frozen_normalized"
            drug_search = drug_clause(drug_norm.normalized, field=self._drug_field)
            notes.append(
                "信号统计使用冻结 FAERS 逐报告快照;药名与 ROLE_COD 在同一药品对象上精确匹配。"
            )
        else:
            drug_field_used = self._drug_field
            drug_search = self._scoped_drug_search(drug_norm.normalized, drug_field_used)
            builder = OverviewBuilder(self._openfda)
            overview = None
            try:
                overview = await builder.build(
                    drug_search,
                    drug_norm.normalized,
                    drug_aliases=self._drug_aliases,
                )
            except NoResults:
                overview = None
            if (overview is None or overview.total_reports == 0) and (
                drug_field_used == DRUG_FIELD_OPENFDA_GENERIC
            ):
                logger.warning(
                    "no reports via openfda_generic for %r; falling back to medicinalproduct",
                    drug_norm.normalized,
                )
                notes.append(
                    "openfda.generic_name 字段未检索到报告,已回退为 medicinalproduct 原始药名字段。"
                )
                drug_field_used = DRUG_FIELD_MEDICINALPRODUCT
                drug_search = self._scoped_drug_search(drug_norm.normalized, drug_field_used)
                try:
                    overview = await builder.build(
                        drug_search,
                        drug_norm.normalized,
                        drug_aliases=self._drug_aliases,
                    )
                except NoResults:
                    overview = None
            if self._ps_only:
                notes.append(
                    "openFDA live 聚合仅表示报告同时含目标药和 suspect 药,无法保证二者属于同一 drug 对象;"
                    "该口径为报告级近似,不是 PS-only。"
                )
            if self._drug_routes:
                notes.append(
                    "openFDA live 聚合仅表示报告同时含目标药、指定角色和给药途径,"
                    "无法保证三者属于同一 drug 对象。"
                )
        if overview is None or overview.total_reports == 0:
            raise NoDataError(f"FAERS 中未检索到 {drug_norm.normalized} 的任何报告")
        await self._emit("overview", "finished", total=overview.total_reports)

        # 3) signals for user-specified + top PTs
        await self._emit("signals", "started")
        if snapshot_scope is not None:
            signals = await self._snapshot_signals(snapshot_scope, normalized_reactions)
        else:
            signals = await self._signals(
                drug_search, overview.total_reports, normalized_reactions
            )
        await self._emit("signals", "finished", rows=len(signals))

        # 4) label cross-check (LLM flash) + optional EviMed evidence
        await self._emit("evidence", "started")
        user_pts = [r.normalized for r in normalized_reactions if r.normalized]
        label_report = None
        if self._llm is not None and user_pts:
            label_report = await check_label_coverage(
                self._openfda, self._llm, drug_norm.normalized, user_pts
            )
            if label_report.status != "ok":
                notes.append(f"说明书对照:{label_report.note or label_report.status}")
        elif self._llm is None:
            notes.append("说明书对照:LLM 未配置,未执行。")
        evidence_result = await self._evidence_layer(drug_norm.normalized, user_pts, notes)
        await self._emit("evidence", "finished")

        # 5) LLM interpretation (Pro) — degradable
        await self._emit("interpret", "started")
        interpretation = None
        llm_status: str = "ok"
        if self._llm is None:
            llm_status = "not_configured"
            notes.append("LLM 未配置(DEEPSEEK_API_KEY 为空),报告仅含统计结果与方法学声明。")
            await self._emit("interpret", "degraded", reason="llm_not_configured")
        else:
            focus = _focus_reactions(signals, user_pts)
            try:
                interpretation = await interpret_results(
                    self._llm,
                    drug=drug_norm.normalized,
                    overview=overview,
                    signals=signals,
                    label_check=label_report,
                    focus_reactions=focus,
                )
                await self._emit("interpret", "finished")
            except LLMError as exc:
                llm_status = "degraded"
                notes.append(f"LLM 解读失败({exc.message}),报告降级为仅统计结果。")
                logger.warning("interpretation degraded: %s", exc)
                await self._emit("interpret", "degraded", reason=exc.message)

        # 6) assemble
        query_urls = (
            self._label_query_url(drug_norm.normalized)
            if snapshot_scope is not None
            else self._query_urls(drug_search, drug_norm.normalized, user_pts)
        )
        provenance = self._faers_snapshot.provenance if self._faers_snapshot else None
        return AnalysisResult(
            drug_query=drug,
            drug_normalized=drug_norm.normalized,
            drug_candidates=[c.term for c in drug_norm.candidates],
            reactions=normalized_reactions,
            language=language,
            overview=overview,
            signals=signals,
            label_check=label_report,
            evidence=evidence_result,
            interpretation=interpretation,
            llm_status=llm_status,  # type: ignore[arg-type]
            degradation_notes=notes,
            query_urls=query_urls,
            drug_field=self._drug_field,
            # Deprecated compatibility flag: True only when the target drug
            # itself is bound to raw ROLE_COD=PS in a frozen snapshot.
            ps_only=(
                snapshot_scope is not None and self._suspect_roles == frozenset({"PS"})
            ),
            drug_field_used=drug_field_used,
            data_source="frozen_faers" if snapshot_scope is not None else "openfda_live",
            suspect_binding=(
                "same_drug_object"
                if snapshot_scope is not None
                else "report_contains_suspect_approximation"
                if self._ps_only
                else "target_name_only"
            ),
            suspect_roles=(
                sorted(self._suspect_roles)
                if snapshot_scope is not None
                else ["PS", "SS"]
                if self._ps_only
                else ["PS", "SS", "C", "I"]
            ),
            administration_routes=list(self._drug_routes),
            study_date_from=(
                snapshot_scope.date_from.isoformat()
                if snapshot_scope is not None and snapshot_scope.date_from
                else _iso_date(self._study_date_from)
            ),
            study_date_to=(
                snapshot_scope.date_to.isoformat()
                if snapshot_scope is not None and snapshot_scope.date_to
                else _iso_date(self._study_date_to)
            ),
            background_date_from=(
                snapshot_scope.background_date_from.isoformat()
                if snapshot_scope is not None and snapshot_scope.background_date_from
                else _iso_date(self._background_date_from or self._study_date_from)
            ),
            background_date_to=(
                snapshot_scope.background_date_to.isoformat()
                if snapshot_scope is not None and snapshot_scope.background_date_to
                else _iso_date(self._background_date_to or self._study_date_to)
            ),
            snapshot_id=provenance.snapshot_id if provenance else None,
            snapshot_source=provenance.source if provenance else None,
            snapshot_sha256=provenance.sha256 if provenance else None,
            snapshot_extracted_at=provenance.extracted_at if provenance else None,
            snapshot_deduplication=provenance.deduplication if provenance else None,
            gps_prior_fitted=self._gps_prior.fitted,
            gps_prior_id=self._gps_prior.fit_id,
        )

    def _scoped_drug_search(self, drug_name: str, field: str) -> str:
        """Drug clause in the configured name field, suspect-scoped.

        The suspect filter ANDs into every drug-side query (drug marginal,
        joint counts, all overview aggregations) so the 2x2 cells b/c/d
        derived from them stay marginally consistent; the reaction
        marginal and the grand total deliberately stay unfiltered.
        """
        names = (
            (drug_name, *self._drug_aliases)
            if field == DRUG_FIELD_MEDICINALPRODUCT
            else (drug_name,)
        )
        clauses = [drug_clause(name, field=field) for name in dict.fromkeys(names)]
        base = clauses[0] if len(clauses) == 1 else "(" + " OR ".join(clauses) + ")"
        if self._ps_only:
            base = f"({base}) AND ({suspect_only_clause()})"
        if self._drug_routes:
            routes = " OR ".join(route_clause(route) for route in self._drug_routes)
            base = f"({base}) AND ({routes})"
        if self._study_date_from is not None or self._study_date_to is not None:
            base = (
                f"({base}) AND "
                f"({date_range_clause(self._study_date_from, self._study_date_to)})"
            )
        return base

    def _background_search(self) -> str | None:
        date_from = self._background_date_from or self._study_date_from
        date_to = self._background_date_to or self._study_date_to
        if date_from is None and date_to is None:
            return None
        return date_range_clause(date_from, date_to)

    # -- signal computation ---------------------------------------------------

    async def _signals(
        self,
        drug_search: str,
        drug_total: int,
        normalized_reactions: list[NormalizedReaction],
    ) -> list[SignalRow]:
        background_search = self._background_search()
        grand_total = await self._count(background_search)
        user_pts = [r.normalized for r in normalized_reactions if r.normalized]
        top_pts = await self._top_pts(drug_search, user_pts)
        targets: list[tuple[str, str]] = [(pt, "user-specified") for pt in user_pts]
        targets += [(pt, "top-pt") for pt in top_pts]

        async def one(reaction: str, source: str) -> SignalRow:
            clause = reaction_clause(reaction)
            async with self._sem:
                joint, event_total = await asyncio.gather(
                    self._count(f"({drug_search}) AND ({clause})"),
                    self._count(
                        f"({clause}) AND ({background_search})"
                        if background_search
                        else clause
                    ),
                )
            table = build_table_from_counts(joint, drug_total, event_total, grand_total)
            metrics = analyze(table, prior=self._gps_prior)
            decision = evaluate(metrics)
            return SignalRow(
                reaction=reaction,
                source=source,  # type: ignore[arg-type]
                a=table.a,
                b=table.b,
                c=table.c,
                d=table.d,
                n=table.n,
                haldane_anscombe_applied=metrics.haldane_anscombe_applied,
                ror=metrics.ror.value,
                ror_ci95_lower=metrics.ror.ci95_lower,
                ror_ci95_upper=metrics.ror.ci95_upper,
                prr=metrics.prr.value,
                prr_ci95_lower=metrics.prr.ci95_lower,
                prr_ci95_upper=metrics.prr.ci95_upper,
                chi2=metrics.chi2.value,
                ic=metrics.ic.value,
                ic025=metrics.ic.ic025,
                ebgm=metrics.ebgm.value,
                eb05=metrics.ebgm.eb05,
                is_signal=decision.is_signal,
                expected_count=metrics.ebgm.expected,
                gps_prior_id=self._gps_prior.fit_id,
            )

        rows = await asyncio.gather(*(one(pt, src) for pt, src in targets))
        # user-specified first, then top PTs; both ranked by case count
        return sorted(rows, key=lambda r: (r.source != "user-specified", -r.a))

    async def _snapshot_signals(
        self,
        scope: DrugScope,
        normalized_reactions: list[NormalizedReaction],
    ) -> list[SignalRow]:
        """Signal panel from one immutable report-level snapshot."""
        if self._faers_snapshot is None:  # defensive; caller establishes this invariant
            raise RuntimeError("frozen FAERS snapshot is not configured")
        user_pts = [reaction.normalized for reaction in normalized_reactions if reaction.normalized]
        excluded = {pt.casefold() for pt in user_pts}
        top_buckets = await asyncio.to_thread(
            self._faers_snapshot.top_reactions,
            scope,
            limit=self._top_pt_count + len(excluded),
        )
        top_pts = [
            bucket.term
            for bucket in top_buckets
            if bucket.term.casefold() not in excluded
        ][: self._top_pt_count]
        targets = [(pt, "user-specified") for pt in user_pts]
        targets += [(pt, "top-pt") for pt in top_pts]

        async def one(reaction: str, source: str) -> SignalRow:
            counts = await asyncio.to_thread(
                self._faers_snapshot.contingency, scope, reaction
            )
            table = build_table_from_counts(
                counts.joint,
                counts.drug_total,
                counts.event_total,
                counts.grand_total,
            )
            metrics = analyze(table, prior=self._gps_prior)
            decision = evaluate(metrics)
            return SignalRow(
                reaction=reaction,
                source=source,  # type: ignore[arg-type]
                a=table.a,
                b=table.b,
                c=table.c,
                d=table.d,
                n=table.n,
                haldane_anscombe_applied=metrics.haldane_anscombe_applied,
                ror=metrics.ror.value,
                ror_ci95_lower=metrics.ror.ci95_lower,
                ror_ci95_upper=metrics.ror.ci95_upper,
                prr=metrics.prr.value,
                prr_ci95_lower=metrics.prr.ci95_lower,
                prr_ci95_upper=metrics.prr.ci95_upper,
                chi2=metrics.chi2.value,
                ic=metrics.ic.value,
                ic025=metrics.ic.ic025,
                ebgm=metrics.ebgm.value,
                eb05=metrics.ebgm.eb05,
                is_signal=decision.is_signal,
                expected_count=metrics.ebgm.expected,
                gps_prior_id=self._gps_prior.fit_id,
            )

        rows = await asyncio.gather(*(one(reaction, source) for reaction, source in targets))
        return sorted(rows, key=lambda row: (row.source != "user-specified", -row.a))

    async def _top_pts(self, drug_search: str, exclude: list[str]) -> list[str]:
        excluded = {pt.lower() for pt in exclude}
        terms = await self._openfda.count_terms(
            FIELD_REACTION_EXACT, drug_search, limit=100
        )
        picked: list[str] = []
        for term in terms:
            pt = term.term.strip().lower()
            if pt and pt not in excluded:
                picked.append(pt)
                excluded.add(pt)
            if len(picked) >= self._top_pt_count:
                break
        return picked

    async def _count(self, search: str | None) -> int:
        try:
            return await self._openfda.count_total(search)
        except NoResults:
            return 0

    # -- evidence layer --------------------------------------------------------

    async def _evidence_layer(
        self, drug_name: str, user_pts: list[str], notes: list[str]
    ) -> EvidenceLayerResult:
        client = self._evidence
        if client is None or not getattr(client, "enabled", False):
            result = EvidenceLayerResult(
                enabled=False,
                note="未配置 EVIMED_EVIDENCE_SEARCH_URL/EVIMED_EVIDENCE_SEARCH_KEY,循证证据检索层未启用。",
            )
            notes.append(result.note)
            return result
        query = " ".join([drug_name, *user_pts[:3]]).strip()
        try:
            items = await client.search_guidelines(query, count=5)
        except EvidenceSearchError as exc:
            note = f"循证证据检索失败({exc.message}),已跳过该层。"
            logger.warning("evidence layer failed: %s", exc)
            notes.append(note)
            return EvidenceLayerResult(enabled=True, note=note)
        return EvidenceLayerResult(
            enabled=True, items=items, note=f"检索到 {len(items)} 条指南/证据记录。"
        )

    # -- traceability -----------------------------------------------------------

    def _query_urls(
        self,
        drug_search: str,
        drug_name: str,
        user_pts: list[str],
    ) -> dict[str, str]:
        def event_url(search: str | None) -> str:
            base = f"{self._base_url}/drug/event.json?limit=1"
            return base if not search else base + "&search=" + quote(search)

        urls: dict[str, str] = {
            "drug_total": event_url(drug_search),
            "grand_total": event_url(self._background_search()),
            "top_pt_counts": (
                f"{self._base_url}/drug/event.json?limit=100"
                f"&count={FIELD_REACTION_EXACT}&search=" + quote(drug_search)
            ),
            "label_search": (
                f"{self._base_url}/drug/label.json?limit=2&search="
                + quote(
                    f'(openfda.generic_name:"{drug_name}" OR openfda.brand_name:"{drug_name}")'
                )
            ),
        }
        for pt in user_pts:
            urls[f"signal_joint[{pt}]"] = event_url(
                f"({drug_search}) AND ({reaction_clause(pt)})"
            )
            event_search = reaction_clause(pt)
            background_search = self._background_search()
            if background_search:
                event_search = f"({event_search}) AND ({background_search})"
            urls[f"signal_event[{pt}]"] = event_url(event_search)
        return urls

    def _label_query_url(self, drug_name: str) -> dict[str, str]:
        return {
            "label_search": (
                f"{self._base_url}/drug/label.json?limit=2&search="
                + quote(
                    f'(openfda.generic_name:"{drug_name}" OR openfda.brand_name:"{drug_name}")'
                )
            )
        }

    async def _emit(self, stage: str, status: str, **detail: Any) -> None:
        if self._on_stage is None:
            return
        outcome = self._on_stage(stage, status, detail)
        if inspect.isawaitable(outcome):
            await outcome


def _focus_reactions(signals: list[SignalRow], user_pts: list[str]) -> list[str]:
    """ADRs the Pro model must cover: user-specified + strongest signals."""
    focus = list(user_pts)
    ranked = sorted(
        (r for r in signals if r.is_signal and r.reaction not in focus),
        key=lambda r: -r.ror,
    )
    focus.extend(r.reaction for r in ranked[:5])
    return focus


def _iso_date(value: date | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    compact = value.replace("-", "")
    if len(compact) == 8 and compact.isdigit():
        return f"{compact[:4]}-{compact[4:6]}-{compact[6:]}"
    return value
