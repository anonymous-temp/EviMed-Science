"""Compatibility migration from legacy extraction JSON into the evidence ledger."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field

from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.core.project import Project
from new_meta.schemas.evidence_ledger import (
    ActorType,
    ArmEntity,
    ContinuousData,
    ComparativeEffectData,
    CorrelationData,
    DiagnosticAccuracyData,
    DoseResponseData,
    DichotomousData,
    EffectEstimate,
    EvidenceActor,
    EvidenceState,
    LedgerEntity,
    OutcomeEntity,
    PredictionPerformanceData,
    ReportEntity,
    ResultEntity,
    IncidenceRateData,
    SingleArmProportionData,
    SourceLocator,
    StudyEntity,
    UnstructuredResultData,
)
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData
from new_meta.core.rct_design_reconciliation import (
    canonical_outcome_name,
    comparative_effect_from_outcome,
)


class DependencyMetadataIncomplete(ValueError):
    """A dependency-design result that cannot be pooled and must not be flattened.

    Cluster, crossover and multi-arm results carry within-study dependency, and
    pooling one as an ordinary two-arm aggregate overstates its precision -- the
    classic unit-of-analysis error. So the incomplete ones are neither pooled
    nor guessed at. They used to raise straight out of the migration, which
    ended the run: a single crossover paper whose extraction omitted
    `precision_basis` destroyed a completed nine-paper extraction after
    thirty-four minutes, and the traceback named the field rather than the
    study. The result is now dropped from the ledger and named in the report,
    so the analysis loses one result instead of all of them and the loss is
    something a reader can see.
    """

    def __init__(self, result_id: str, design: str, missing: list[str]):
        super().__init__(
            "%s has incomplete %s dependency metadata: %s" % (result_id, design, ", ".join(missing))
        )
        self.result_id = result_id
        self.design = design
        self.missing = list(missing)


class LedgerMigrationReport(BaseModel):
    schema_version: int = 1
    review_id: str
    ledger_path: str
    created_entities: int = 0
    superseded_entities: int = 0
    unchanged_entities: int = 0
    result_ids: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    skipped_results: list[dict] = Field(default_factory=list)


def migrate_extractions_to_ledger(
    project: Project,
    *,
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy],
    actor: EvidenceActor | None = None,
    change_reason: str = "legacy extraction changed after import",
) -> LedgerMigrationReport:
    """Idempotently project legacy extraction models into result-level entities."""
    review_id = ensure_project_review_id(project)
    ledger_path = project.get_path("ledger.jsonl", subdir="evidence")
    ledger = EvidenceLedger(ledger_path, review_id=review_id)
    actor = actor or EvidenceActor(
        actor_id="legacy_extraction_migration",
        actor_type=ActorType.IMPORT,
        code_version="evidence-ledger-v1",
    )
    report = LedgerMigrationReport(review_id=review_id, ledger_path=str(ledger_path))

    for study in extracted_studies:
        characteristics = study.characteristics
        study_key = _study_key(study)
        report_id = f"report:{study_key}"
        study_id = f"study:{study_key}"
        file_path = str(characteristics.pdf_path or "")
        file_sha256 = _file_sha256(file_path)
        report_entity = ReportEntity(
            entity_id=report_id,
            review_id=review_id,
            title=characteristics.title or study_key,
            doi=characteristics.doi,
            pmid=characteristics.pmid,
            publication_year=characteristics.year or None,
            file_sha256=file_sha256,
            evidence_state=EvidenceState.EXTRACTED,
            tags=[tag for tag in [characteristics.source_type, characteristics.metadata_source] if tag],
        )
        study_entity = StudyEntity(
            entity_id=study_id,
            review_id=review_id,
            title=characteristics.title or study_key,
            design=characteristics.study_design or "unverified",
            report_ids=[report_id],
            population_description=characteristics.population_description,
            setting=characteristics.country,
            evidence_state=EvidenceState.EXTRACTED,
        )
        _upsert(ledger, report_entity, actor, report, change_reason=change_reason)
        _upsert(ledger, study_entity, actor, report, change_reason=change_reason)

        intervention_arm_id = f"arm:{study_key}:intervention"
        control_arm_id = f"arm:{study_key}:control"
        intervention_arm = ArmEntity(
            entity_id=intervention_arm_id,
            review_id=review_id,
            study_id=study_id,
            name=characteristics.intervention_description or "Intervention",
            role="intervention",
            sample_size=characteristics.sample_size_intervention,
            intervention_description=characteristics.intervention_description,
            evidence_state=EvidenceState.EXTRACTED,
        )
        control_arm = ArmEntity(
            entity_id=control_arm_id,
            review_id=review_id,
            study_id=study_id,
            name=characteristics.control_description or "Comparator",
            role="comparator",
            sample_size=characteristics.sample_size_control,
            intervention_description=characteristics.control_description,
            evidence_state=EvidenceState.EXTRACTED,
        )
        _upsert(ledger, intervention_arm, actor, report, change_reason=change_reason)
        _upsert(ledger, control_arm, actor, report, change_reason=change_reason)

        for outcome_index, outcome in enumerate(study.outcomes):
            canonical_name = canonical_outcome_name(outcome, protocol)
            outcome_id = _outcome_id(outcome, protocol)
            outcome_entity = OutcomeEntity(
                entity_id=outcome_id,
                review_id=review_id,
                name=canonical_name or f"Outcome {outcome_index + 1}",
                outcome_type=outcome.outcome_type or "unverified",
                direction=_outcome_direction(outcome.outcome_name),
                evidence_state=EvidenceState.EXTRACTED,
            )
            _upsert(ledger, outcome_entity, actor, report, change_reason=change_reason)
            result_id = result_entity_id(study, outcome_index)
            try:
                raw_data, estimate = _result_data(
                    outcome,
                    protocol,
                    warnings=report.warnings,
                    result_id=result_id,
                )
            except DependencyMetadataIncomplete as incomplete:
                report.warnings.append(
                    "%s was dropped: a %s result cannot be pooled without %s, and pooling it as an "
                    "ordinary two-arm aggregate would overstate its precision."
                    % (result_id, incomplete.design, ", ".join(incomplete.missing))
                )
                report.skipped_results.append({
                    "resultId": result_id,
                    "studyId": study_id,
                    "design": incomplete.design,
                    "missing": incomplete.missing,
                    "outcome": canonical_name or outcome.outcome_name or "",
                })
                continue
            state = _result_state(outcome)
            result_arm_ids = [intervention_arm_id, control_arm_id]
            if outcome.treatment_arm and outcome.reference_arm:
                treatment_arm_id = f"arm:{study_key}:{_arm_key(outcome.treatment_arm)}"
                reference_arm_id = f"arm:{study_key}:{_arm_key(outcome.reference_arm)}"
                _upsert(
                    ledger,
                    ArmEntity(
                        entity_id=treatment_arm_id,
                        review_id=review_id,
                        study_id=study_id,
                        name=outcome.treatment_arm,
                        role="intervention",
                        sample_size=outcome.total_intervention,
                        intervention_description=outcome.treatment_arm,
                        evidence_state=EvidenceState.EXTRACTED,
                    ),
                    actor,
                    report,
                    change_reason=change_reason,
                )
                _upsert(
                    ledger,
                    ArmEntity(
                        entity_id=reference_arm_id,
                        review_id=review_id,
                        study_id=study_id,
                        name=outcome.reference_arm,
                        role="comparator",
                        sample_size=outcome.total_control,
                        intervention_description=outcome.reference_arm,
                        evidence_state=EvidenceState.EXTRACTED,
                    ),
                    actor,
                    report,
                    change_reason=change_reason,
                )
                result_arm_ids = [treatment_arm_id, reference_arm_id]
            locator = SourceLocator(
                document_id=report_id,
                file_path=file_path,
                file_sha256=file_sha256,
                page=outcome.source_page,
                section=str(outcome.source_section or ""),
                table=outcome.source_location,
                quote=outcome.source_quote,
                quote_verified=bool(outcome.source_quote_verified and outcome.source_quote.strip()),
            )
            result_entity = ResultEntity(
                entity_id=result_id,
                review_id=review_id,
                study_id=study_id,
                report_id=report_id,
                outcome_id=outcome_id,
                arm_ids=result_arm_ids,
                timepoint=str(outcome.accepted_timepoint or outcome.timepoint or ""),
                subgroup=str(outcome.subgroup or ""),
                analysis_population=(
                    "adjudicated_population"
                    if outcome.manual_adjudication or outcome.user_override_applied
                    else ""
                ),
                effect_measure=_effect_measure(outcome, protocol),
                raw_data=raw_data,
                estimate=estimate,
                source_locators=[locator],
                evidence_state=state,
                derivation={
                    "legacy_outcome_index": outcome_index,
                    "extraction_confidence": outcome.extraction_confidence or "",
                    "denominator_source": outcome.denominator_source,
                    "events_intervention": outcome.events_intervention,
                    "total_intervention": outcome.total_intervention,
                    "events_control": outcome.events_control,
                    "total_control": outcome.total_control,
                    "override_revision": outcome.override_revision,
                },
            )
            _upsert(ledger, result_entity, actor, report, change_reason=change_reason)
            report.result_ids.append(result_id)

    ledger.assert_valid()
    project.save_json("ledger_migration.json", report, subdir="evidence")
    return report


def _upsert(
    ledger: EvidenceLedger,
    entity: LedgerEntity,
    actor: EvidenceActor,
    report: LedgerMigrationReport,
    *,
    change_reason: str,
) -> None:
    version = ledger.entity_version(entity.entity_id)
    payload = entity.model_dump(mode="json")
    if version == 0:
        ledger.create(entity, actor=actor, reason="legacy extraction import")
        report.created_entities += 1
        return
    if ledger.current(entity.entity_id) == payload:
        report.unchanged_entities += 1
        return
    if actor.actor_type == ActorType.HUMAN and entity.evidence_state == EvidenceState.ADJUDICATED:
        ledger.adjudicate(
            entity,
            actor=actor,
            expected_version=version,
            reason=change_reason,
        )
    else:
        ledger.supersede(
            entity,
            actor=actor,
            expected_version=version,
            reason=change_reason,
        )
    report.superseded_entities += 1


def ensure_project_review_id(project: Project) -> str:
    payload = project.load_json("review_identity.json", subdir="evidence") or {}
    review_id = str(payload.get("review_id") or "").strip() if isinstance(payload, dict) else ""
    if not review_id:
        review_id = f"review:{uuid4()}"
        project.save_json(
            "review_identity.json",
            {"schema_version": 1, "review_id": review_id},
            subdir="evidence",
        )
    return review_id


def _study_key(study: ExtractedStudy) -> str:
    characteristics = study.characteristics
    raw = (
        characteristics.pmid
        or characteristics.doi
        or characteristics.study_id
        or characteristics.title
        or "study"
    )
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", str(raw).strip().lower()).strip("-")
    if normalized:
        return normalized[:96]
    return hashlib.sha256(str(raw).encode("utf-8")).hexdigest()[:16]


def result_entity_id(study: ExtractedStudy, outcome_index: int) -> str:
    """Return the stable canonical result identifier used across phases."""
    return f"result:{_study_key(study)}:{int(outcome_index)}"


def _outcome_id(outcome: OutcomeData, protocol: ResearchProtocol) -> str:
    name = canonical_outcome_name(outcome, protocol) or "unnamed-outcome"
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")[:64]
    digest = hashlib.sha256(
        f"{name}|{outcome.outcome_type}".encode("utf-8")
    ).hexdigest()[:10]
    return f"outcome:{normalized or 'unnamed'}:{digest}"


def _arm_key(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    digest = hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:8]
    return f"{normalized[:48] or 'arm'}-{digest}"


def _file_sha256(file_path: str) -> str:
    if not file_path:
        return ""
    path = Path(file_path)
    if not path.exists() or not path.is_file():
        return ""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _outcome_direction(name: str) -> str:
    lowered = str(name or "").lower()
    if any(term in lowered for term in ("mortality", "death", "harm", "adverse", "hospital")):
        return "lower_is_better"
    if any(term in lowered for term in ("response", "recovery", "survival", "quality of life")):
        return "higher_is_better"
    return "context_dependent"


def _effect_measure(outcome: OutcomeData, protocol: ResearchProtocol) -> str:
    if outcome.comparative_design:
        return str(protocol.effect_measure or outcome.reported_effect_measure or "UNSPECIFIED").upper()
    if outcome.prediction_performance_measure:
        return outcome.prediction_performance_measure.upper()
    if all(
        value is not None
        for value in (
            outcome.true_positive,
            outcome.false_negative,
            outcome.false_positive,
            outcome.true_negative,
        )
    ):
        return "SENS_SPEC"
    if outcome.hazard_ratio is not None:
        return "HR"
    if outcome.correlation_r is not None:
        return "COR"
    if outcome.events is not None and outcome.total_n is not None:
        return "PROP"
    if outcome.events is not None and outcome.person_time is not None:
        return "IR"
    return str(protocol.effect_measure or outcome.outcome_type or "UNSPECIFIED").upper()


def _result_state(outcome: OutcomeData) -> EvidenceState:
    quote_verified = bool(outcome.source_quote_verified and outcome.source_quote.strip())
    if quote_verified and (outcome.manual_adjudication or outcome.user_override_applied):
        return EvidenceState.ADJUDICATED
    if quote_verified:
        return EvidenceState.VERIFIED
    return EvidenceState.EXTRACTED


def _result_data(
    outcome: OutcomeData,
    protocol: ResearchProtocol,
    *,
    warnings: list[str] | None = None,
    result_id: str = "result",
) -> tuple[
    DichotomousData
    | ContinuousData
    | SingleArmProportionData
    | IncidenceRateData
    | DiagnosticAccuracyData
    | CorrelationData
    | ComparativeEffectData
    | DoseResponseData
    | PredictionPerformanceData
    | UnstructuredResultData
    | None,
    EffectEstimate | None,
]:
    if outcome.dose_response_design:
        if outcome.dose_value is None or outcome.reference_dose_value is None:
            raise ValueError("dose-response metadata requires dose and reference dose")
        if outcome.effect_size is None:
            raise ValueError("dose-response metadata requires a reported effect estimate")
        if outcome.reported_effect_standard_error is None and (
            outcome.ci_lower is None or outcome.ci_upper is None
        ):
            raise ValueError("dose-response effect requires a reported SE or confidence interval")
        measure = str(
            outcome.reported_effect_measure or protocol.effect_measure or "UNSPECIFIED"
        ).upper()
        return DoseResponseData(
            design=outcome.dose_response_design,
            dose=outcome.dose_value,
            reference_dose=outcome.reference_dose_value,
            dose_unit=outcome.dose_unit,
            contrast_id=outcome.contrast_id,
            covariance_with=outcome.covariance_with,
        ), EffectEstimate(
            measure=measure,
            estimate=outcome.effect_size,
            standard_error=outcome.reported_effect_standard_error,
            ci_lower=outcome.ci_lower,
            ci_upper=outcome.ci_upper,
            scale=outcome.reported_effect_scale or "original",
            adjusted=outcome.reported_effect_adjusted,
            adjusted_covariates=outcome.adjustment_covariates,
        )

    if outcome.comparative_design:
        required = {
            "treatment_arm": outcome.treatment_arm,
            "reference_arm": outcome.reference_arm,
            "contrast_id": outcome.contrast_id,
            "estimand_id": outcome.estimand_id,
            "precision_basis": outcome.precision_basis,
        }
        missing = sorted(
            field for field, value in required.items()
            if not str(value or "").strip()
        )
        design = re.sub(r"[^a-z0-9]+", "_", str(outcome.comparative_design).strip().lower()).strip("_")
        if missing and design in {"cluster_rct", "crossover_rct", "multi_arm_rct"}:
            raise DependencyMetadataIncomplete(result_id, design, missing)
        if missing:
            if warnings is not None:
                warnings.append(
                    f"{result_id} declared comparative_design={outcome.comparative_design!r} "
                    f"without {', '.join(missing)}; preserved as an ordinary aggregate result."
                )
        else:
            comparative_data = ComparativeEffectData(
                design=outcome.comparative_design,
                treatment=str(outcome.treatment_arm),
                comparator=str(outcome.reference_arm),
                contrast_id=outcome.contrast_id,
                estimand_id=outcome.estimand_id,
                precision_basis=outcome.precision_basis,
                covariance_with=outcome.covariance_with,
                paired_analysis=outcome.paired_analysis,
                intracluster_correlation=outcome.intracluster_correlation,
                mean_cluster_size=outcome.mean_cluster_size,
            )
            try:
                effect = comparative_effect_from_outcome(outcome, protocol)
            except ValueError as exc:
                if warnings is not None:
                    warnings.append(
                        f"{result_id} preserves comparative dependency metadata but has no "
                        f"computable {str(protocol.effect_measure or '').upper() or 'effect'} "
                        "estimate; the result is excluded from synthesis pending source data "
                        f"({exc})."
                    )
                return comparative_data, None
            return comparative_data, EffectEstimate(
                measure=str(effect["measure"]),
                estimate=float(effect["estimate"]),
                standard_error=effect["standard_error"],
                variance=effect["variance"],
                ci_lower=effect["ci_lower"],
                ci_upper=effect["ci_upper"],
                scale=str(effect["scale"]),
                adjusted=outcome.reported_effect_adjusted,
                adjusted_covariates=outcome.adjustment_covariates,
            )

    if outcome.prediction_performance_measure:
        return PredictionPerformanceData(
            model_id=outcome.prediction_model_id,
            model_version=outcome.prediction_model_version,
            validation_type=outcome.prediction_validation_type,
            metric=outcome.prediction_performance_measure.upper(),
            estimate=outcome.prediction_performance_estimate,
            standard_error=outcome.prediction_performance_se,
            ci_lower=outcome.prediction_performance_ci_lower,
            ci_upper=outcome.prediction_performance_ci_upper,
            sample_size=outcome.prediction_sample_size,
            events=outcome.prediction_events,
            expected_events=outcome.prediction_expected_events,
            time_horizon=str(outcome.accepted_timepoint or outcome.timepoint or ""),
        ), None

    diagnostic = (
        outcome.true_positive,
        outcome.false_negative,
        outcome.false_positive,
        outcome.true_negative,
    )
    if all(value is not None for value in diagnostic):
        return DiagnosticAccuracyData(
            true_positive=outcome.true_positive,
            false_negative=outcome.false_negative,
            false_positive=outcome.false_positive,
            true_negative=outcome.true_negative,
            threshold=outcome.diagnostic_threshold,
        ), None

    if outcome.events is not None and outcome.total_n is not None:
        return SingleArmProportionData(events=outcome.events, total=outcome.total_n), None

    if outcome.events is not None and outcome.person_time is not None:
        return IncidenceRateData(
            events=outcome.events,
            person_time=outcome.person_time,
            time_unit=outcome.person_time_unit or "person_years",
        ), None

    if outcome.correlation_r is not None and outcome.correlation_n is not None:
        return CorrelationData(
            correlation=outcome.correlation_r,
            total=outcome.correlation_n,
        ), None
    dichotomous = (
        outcome.events_intervention,
        outcome.total_intervention,
        outcome.events_control,
        outcome.total_control,
    )
    if all(value is not None for value in dichotomous):
        return DichotomousData(
            events_intervention=outcome.events_intervention,
            total_intervention=outcome.total_intervention,
            events_control=outcome.events_control,
            total_control=outcome.total_control,
        ), None

    continuous = (
        outcome.mean_intervention,
        outcome.sd_intervention,
        outcome.n_intervention,
        outcome.mean_control,
        outcome.sd_control,
        outcome.n_control,
    )
    if all(value is not None for value in continuous) and outcome.sd_intervention > 0 and outcome.sd_control > 0:
        return ContinuousData(
            mean_intervention=outcome.mean_intervention,
            sd_intervention=outcome.sd_intervention,
            total_intervention=outcome.n_intervention,
            mean_control=outcome.mean_control,
            sd_control=outcome.sd_control,
            total_control=outcome.n_control,
        ), None

    if outcome.hazard_ratio is not None and outcome.hr_ci_lower is not None and outcome.hr_ci_upper is not None:
        return None, EffectEstimate(
            measure="HR",
            estimate=outcome.hazard_ratio,
            standard_error=outcome.hr_se,
            ci_lower=outcome.hr_ci_lower,
            ci_upper=outcome.hr_ci_upper,
            scale="original",
        )
    if outcome.effect_size is not None and outcome.ci_lower is not None and outcome.ci_upper is not None:
        return None, EffectEstimate(
            measure=str(
                outcome.reported_effect_measure or protocol.effect_measure or "UNSPECIFIED"
            ).upper(),
            estimate=outcome.effect_size,
            standard_error=outcome.reported_effect_standard_error,
            ci_lower=outcome.ci_lower,
            ci_upper=outcome.ci_upper,
            scale=outcome.reported_effect_scale or "original",
            adjusted=outcome.reported_effect_adjusted,
            adjusted_covariates=outcome.adjustment_covariates,
        )

    legacy_fields: dict[str, Any] = {
        key: value
        for key, value in outcome.model_dump(mode="json").items()
        if value not in (None, "", [], {})
    }
    return UnstructuredResultData(fields=legacy_fields or {"outcome_name": outcome.outcome_name}), None
