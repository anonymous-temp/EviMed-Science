"""Allowlisted deterministic dispatch for compiled method plans."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from new_meta.schemas.method_policy import MethodExecutionResult, MethodPlan, ReviewFamily


class MethodExecutionBlocked(RuntimeError):
    pass


class MethodExecutionNeedsInput(RuntimeError):
    def __init__(self, message: str, *, payload: dict[str, Any]):
        self.payload = payload
        super().__init__(message)


class MethodExecutor:
    """Execute only registered deterministic engine functions, never arbitrary paths."""

    _ENTRYPOINTS: dict[str, str] = {
        "new_meta.engines.prevalence:run_prevalence": "prevalence",
        "new_meta.engines.dta:run_diagnostic_accuracy": "dta",
        "new_meta.engines.adjusted_effects:run_adjusted_effects": "adjusted_effects",
        "new_meta.engines.prediction_performance:run_prediction_performance": "prediction_performance",
        "new_meta.engines.complex_rct:run_complex_rct": "complex_rct",
        "new_meta.engines.nma:run_network_meta": "network_meta",
        "new_meta.engines.dose_response:run_dose_response": "dose_response",
        "new_meta.engines.ipd:run_ipd_meta": "ipd_meta",
    }

    def resolve_entrypoint(self, entrypoint: str) -> Callable:
        kind = self._ENTRYPOINTS.get(str(entrypoint))
        if kind == "prevalence":
            from new_meta.engines.prevalence import run_prevalence

            return run_prevalence
        if kind == "dta":
            from new_meta.engines.dta import run_diagnostic_accuracy

            return run_diagnostic_accuracy
        if kind == "adjusted_effects":
            from new_meta.engines.adjusted_effects import run_adjusted_effects

            return run_adjusted_effects
        if kind == "prediction_performance":
            from new_meta.engines.prediction_performance import run_prediction_performance

            return run_prediction_performance
        if kind == "complex_rct":
            from new_meta.engines.complex_rct import run_complex_rct

            return run_complex_rct
        if kind == "network_meta":
            from new_meta.engines.nma import run_network_meta

            return run_network_meta
        if kind == "dose_response":
            from new_meta.engines.dose_response import run_dose_response

            return run_dose_response
        if kind == "ipd_meta":
            from new_meta.engines.ipd import run_ipd_meta

            return run_ipd_meta
        raise MethodExecutionBlocked(f"engine entrypoint is not allowlisted: {entrypoint}")

    def execute(
        self,
        plan: MethodPlan,
        *,
        records: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        output_path: str | Path | None = None,
    ) -> MethodExecutionResult:
        if not plan.execution_allowed:
            reasons = "; ".join(plan.blocking_reasons) or "method plan execution is blocked"
            raise MethodExecutionBlocked(f"{plan.family.value} execution is blocked: {reasons}")
        supplied_options = dict(options or {})
        if (
            plan.capability_id == "network_meta.aggregate"
            and not supplied_options.get("transitivity_assessment")
        ):
            raise MethodExecutionNeedsInput(
                "Network meta-analysis requires an explicit transitivity assessment before pooling.",
                payload={
                    "decision_type": "transitivity_assessment",
                    "question": (
                        "Are the distributions of the prespecified effect modifiers sufficiently "
                        "comparable across the direct treatment comparisons?"
                    ),
                    "recommended_option_id": "confirm_adequate",
                    "required_fields": ["effect_modifiers", "rationale"],
                    "options": [
                        {
                            "option_id": "confirm_adequate",
                            "label": "Confirm transitivity",
                            "description": (
                                "Proceed only after recording the compared effect modifiers and "
                                "a rationale that their distributions are sufficiently comparable."
                            ),
                        },
                        {
                            "option_id": "revise_network",
                            "label": "Revise the network",
                            "description": (
                                "Restrict, stratify, or redefine the network when effect-modifier "
                                "imbalance makes indirect comparisons invalid."
                            ),
                        },
                    ],
                },
            )
        if plan.capability_id == "diagnostic_accuracy.reitsma_reml" and supplied_options:
            raise MethodExecutionBlocked(
                "runtime options are not permitted for the production Reitsma REML capability; "
                "its estimator, continuity correction, and threshold policy are validation-locked"
            )
        if plan.capability_id == "incidence.poisson.glmm":
            from new_meta.engines.incidence import run_incidence

            engine = run_incidence
        else:
            engine = self.resolve_entrypoint(plan.engine_entrypoint)
        if plan.family is ReviewFamily.IPD_META:
            outcome_type = {
                "dichotomous": "binary",
                "binary": "binary",
                "continuous": "continuous",
                "time_to_event": "time_to_event",
            }.get(plan.outcome_type)
            if not outcome_type:
                raise MethodExecutionBlocked(
                    f"unsupported compiled IPD outcome type: {plan.outcome_type}"
                )
            if supplied_options.get("outcome_type") not in {None, outcome_type}:
                raise MethodExecutionBlocked(
                    "runtime IPD outcome type cannot override the compiled method plan"
                )
            if supplied_options.get("effect_measure") not in {None, plan.effect_measure}:
                raise MethodExecutionBlocked(
                    "runtime IPD effect measure cannot override the compiled method plan"
                )
            supplied_options["outcome_type"] = outcome_type
            supplied_options["effect_measure"] = plan.effect_measure
        engine_result = engine(records, **supplied_options)
        if not hasattr(engine_result, "model_dump"):
            raise TypeError("method engine must return a typed Pydantic result")
        payload = engine_result.model_dump(mode="json")
        result = MethodExecutionResult(
            family=plan.family,
            policy_version=plan.policy_version,
            plan_fingerprint=plan.plan_fingerprint,
            estimator=str(payload.get("estimator") or plan.primary_estimator),
            payload=payload,
            diagnostics=payload.get("diagnostics") or {},
        )
        if output_path is not None:
            self._persist(result, output_path)
        return result

    def execute_project(
        self,
        plan: MethodPlan,
        *,
        project,
        result_ids: list[str],
        options: dict[str, Any] | None = None,
        auto_select_ambiguous: bool = False,
    ) -> MethodExecutionResult:
        from new_meta.core.evidence_ledger import EvidenceLedger
        from new_meta.schemas.evidence_ledger import (
            DiagnosticAccuracyData,
            ComparativeEffectData,
            DoseResponseData,
            EntityKind,
            EvidenceState,
            EffectEstimate,
            IncidenceRateData,
            IPDStudyData,
            PredictionPerformanceData,
            ResultEntity,
            SingleArmProportionData,
        )
        from new_meta.schemas.method_policy import ReviewFamily

        identity = project.load_json("review_identity.json", subdir="evidence") or {}
        review_id = str(identity.get("review_id") or "")
        if not review_id or review_id != plan.review_id:
            raise MethodExecutionBlocked("method plan review_id does not match the evidence ledger")
        requested = list(dict.fromkeys(str(item) for item in result_ids if str(item).strip()))
        if not requested:
            raise MethodExecutionBlocked("at least one result_id is required")
        ledger = EvidenceLedger(
            project.get_path("ledger.jsonl", subdir="evidence"),
            review_id=review_id,
        )
        verification = ledger.assert_valid()
        current = {
            payload["entity_id"]: ResultEntity.model_validate(payload)
            for payload in ledger.current_entities(kind=EntityKind.RESULT)
        }
        missing = [result_id for result_id in requested if result_id not in current]
        if missing:
            raise MethodExecutionBlocked(
                "result_id(s) not found in evidence ledger: " + ", ".join(missing)
            )
        entities = [current[result_id] for result_id in requested]
        inadmissible = [
            item.entity_id
            for item in entities
            if item.evidence_state not in {EvidenceState.VERIFIED, EvidenceState.ADJUDICATED}
        ]
        if inadmissible:
            raise MethodExecutionBlocked(
                "result_id(s) are not verified/adjudicated: " + ", ".join(inadmissible)
            )
        from new_meta.core.analysis_set import (
            AnalysisSetAdjudicationRequired,
            resolve_project_analysis_set,
        )

        try:
            analysis_set = resolve_project_analysis_set(
                project,
                plan,
                auto_select_ambiguous=auto_select_ambiguous,
            )
        except AnalysisSetAdjudicationRequired as exc:
            if plan.family in {
                ReviewFamily.INTERVENTION_NRSI,
                ReviewFamily.PROGNOSTIC_FACTOR,
            } and any(
                not isinstance(entity.estimate, EffectEstimate)
                or not entity.estimate.adjusted
                or not entity.estimate.adjusted_covariates
                for entity in entities
            ):
                raise MethodExecutionBlocked(
                    "NRSI/prognostic synthesis requires source-verified adjusted estimates "
                    "with a reported adjustment set"
                ) from exc
            raise MethodExecutionBlocked(str(exc)) from exc
        if requested != analysis_set.result_ids:
            raise MethodExecutionBlocked(
                "requested result_ids do not match the current automatic/adjudicated analysis set"
            )
        if plan.family is ReviewFamily.PROGNOSTIC_FACTOR and not analysis_set.timepoint:
            raise MethodExecutionBlocked(
                "released prognostic synthesis requires one explicitly recorded time horizon"
            )

        records: list[dict[str, Any]] = []
        for entity in entities:
            if plan.family is ReviewFamily.PREVALENCE_INCIDENCE:
                if plan.effect_measure.upper() == "IR":
                    if not isinstance(entity.raw_data, IncidenceRateData):
                        raise MethodExecutionBlocked(
                            f"result {entity.entity_id} is not typed incidence-rate data"
                        )
                    records.append({
                        "study_id": entity.study_id,
                        "events": entity.raw_data.events,
                        "person_time": entity.raw_data.person_time,
                        "time_unit": entity.raw_data.time_unit,
                    })
                else:
                    if not isinstance(entity.raw_data, SingleArmProportionData):
                        raise MethodExecutionBlocked(
                            f"result {entity.entity_id} is not typed single-arm proportion data"
                        )
                    records.append({
                        "study_id": entity.study_id,
                        "events": entity.raw_data.events,
                        "total": entity.raw_data.total,
                    })
            elif plan.family is ReviewFamily.DIAGNOSTIC_ACCURACY:
                if not isinstance(entity.raw_data, DiagnosticAccuracyData):
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} is not typed diagnostic 2x2 data"
                    )
                records.append({
                    "study_id": entity.study_id,
                    "true_positive": entity.raw_data.true_positive,
                    "false_negative": entity.raw_data.false_negative,
                    "false_positive": entity.raw_data.false_positive,
                    "true_negative": entity.raw_data.true_negative,
                    "threshold": entity.raw_data.threshold,
                })
            elif plan.family in {
                ReviewFamily.INTERVENTION_NRSI,
                ReviewFamily.PROGNOSTIC_FACTOR,
            }:
                estimate = entity.estimate
                if not isinstance(estimate, EffectEstimate) or not estimate.adjusted:
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} must contain an adjusted reported effect"
                    )
                if not estimate.adjusted_covariates:
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} must report its adjustment covariates"
                    )
                records.append({
                    "result_id": entity.entity_id,
                    "study_id": entity.study_id,
                    **estimate.model_dump(mode="json"),
                })
            elif plan.family in {ReviewFamily.INTERVENTION_RCT, ReviewFamily.NETWORK_META}:
                if not isinstance(entity.raw_data, ComparativeEffectData):
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} lacks typed comparative-effect dependency metadata"
                    )
                estimate = entity.estimate
                if not isinstance(estimate, EffectEstimate):
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} lacks a reported comparative effect"
                    )
                records.append({
                    "result_id": entity.entity_id,
                    "study_id": entity.study_id,
                    **entity.raw_data.model_dump(mode="json", exclude={"data_type"}),
                    **estimate.model_dump(mode="json"),
                })
            elif plan.family is ReviewFamily.DOSE_RESPONSE:
                if not isinstance(entity.raw_data, DoseResponseData):
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} lacks typed dose-response category metadata"
                    )
                estimate = entity.estimate
                if not isinstance(estimate, EffectEstimate):
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} lacks a reported dose contrast"
                    )
                records.append({
                    "result_id": entity.entity_id,
                    "study_id": entity.study_id,
                    **entity.raw_data.model_dump(mode="json", exclude={"data_type"}),
                    **estimate.model_dump(mode="json"),
                })
            elif plan.family is ReviewFamily.IPD_META:
                if not isinstance(entity.raw_data, IPDStudyData):
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} is not typed participant-level study data"
                    )
                records.append({
                    "study_id": entity.study_id,
                    "design": entity.raw_data.design,
                    "participants": [
                        item.model_dump(mode="json") for item in entity.raw_data.participants
                    ],
                })
            elif plan.family is ReviewFamily.PREDICTION_MODEL:
                if not isinstance(entity.raw_data, PredictionPerformanceData):
                    raise MethodExecutionBlocked(
                        f"result {entity.entity_id} is not typed prediction-performance data"
                    )
                metric = entity.raw_data.metric.upper()
                records.append({
                    "study_id": entity.study_id,
                    "model_id": entity.raw_data.model_id,
                    "model_version": entity.raw_data.model_version,
                    "validation_type": entity.raw_data.validation_type,
                    "metric": entity.raw_data.metric,
                    "time_horizon": entity.raw_data.time_horizon,
                    "c_statistic": (
                        entity.raw_data.estimate if metric == "C_STATISTIC" else None
                    ),
                    "performance_estimate": (
                        entity.raw_data.estimate
                        if metric in {"OE_RATIO", "CALIBRATION_SLOPE"}
                        else None
                    ),
                    "calibration_slope": (
                        entity.raw_data.estimate
                        if metric == "CALIBRATION_SLOPE"
                        else None
                    ),
                    "standard_error": entity.raw_data.standard_error,
                    "ci_lower": entity.raw_data.ci_lower,
                    "ci_upper": entity.raw_data.ci_upper,
                    "sample_size": entity.raw_data.sample_size,
                    "events": entity.raw_data.events,
                    "observed_events": entity.raw_data.events,
                    "expected_events": entity.raw_data.expected_events,
                })
            else:
                raise MethodExecutionBlocked(
                    f"ledger materializer is not implemented for {plan.family.value}"
                )
        result = self.execute(plan, records=records, options=options)
        result = result.model_copy(update={
            "input_result_ids": requested,
            "input_ledger_head_hash": verification.head_hash,
        })
        project.save_json(
            "method_input_audit.json",
            {
                "schema_version": 1,
                "family": plan.family.value,
                "policy_version": plan.policy_version,
                "plan_fingerprint": plan.plan_fingerprint,
                "analysis_set_revision": analysis_set.revision,
                "analysis_set_candidate_id": analysis_set.candidate_id,
                "analysis_set_status": analysis_set.status,
                "ledger_head_hash": verification.head_hash,
                "inputs": [
                    {
                        "result_id": entity.entity_id,
                        "entity_version": ledger.entity_version(entity.entity_id),
                        "study_id": entity.study_id,
                        "report_id": entity.report_id,
                        "outcome_id": entity.outcome_id,
                        "timepoint": entity.timepoint,
                        "subgroup": entity.subgroup,
                        "effect_measure": entity.effect_measure,
                        "evidence_state": entity.evidence_state.value,
                        "raw_data": (
                            entity.raw_data.model_dump(mode="json")
                            if entity.raw_data is not None
                            else None
                        ),
                        "estimate": (
                            entity.estimate.model_dump(mode="json")
                            if entity.estimate is not None
                            else None
                        ),
                        "derivation": dict(entity.derivation or {}),
                        "source_locators": [
                            locator.model_dump(mode="json") for locator in entity.source_locators
                        ],
                    }
                    for entity in entities
                ],
            },
            subdir="analysis",
        )
        self._persist(result, project.get_path("method_result.json", subdir="analysis"))
        return result

    def eligible_project_result_ids(
        self,
        plan: MethodPlan,
        *,
        project,
        auto_select_ambiguous: bool = False,
    ) -> list[str]:
        """Return only verified/adjudicated typed results admissible for this plan."""
        from new_meta.core.analysis_set import resolve_project_analysis_set
        from new_meta.core.analysis_set import AnalysisSetAdjudicationRequired

        try:
            return resolve_project_analysis_set(
                project,
                plan,
                auto_select_ambiguous=auto_select_ambiguous,
            ).result_ids
        except AnalysisSetAdjudicationRequired as exc:
            if not exc.candidates.candidates:
                return []
            raise

    @staticmethod
    def _persist(result: MethodExecutionResult, output_path: str | Path) -> None:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(path)
