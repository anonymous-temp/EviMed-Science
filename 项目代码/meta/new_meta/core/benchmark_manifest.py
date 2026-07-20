"""Published benchmark manifests and recall checks for regression testing."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class BenchmarkTrial(BaseModel):
    """One trial expected by a published benchmark meta-analysis."""

    trial_id: str
    trial_name: str
    registration_id: str = ""
    aliases: list[str] = []
    publication_pmids: list[str] = []
    publication_dois: list[str] = []
    expected_events_intervention: int | None = None
    expected_total_intervention: int | None = None
    expected_events_control: int | None = None
    expected_total_control: int | None = None
    expected_primary_timepoint: str = ""
    accepted_timepoints: list[str] = []
    timepoint_kind: str = "time_window"
    requires_timepoint_adjudication: bool = False
    timepoint_notes: str = ""
    required_for_search_recall: bool = True
    notes: str = ""


class BenchmarkManifest(BaseModel):
    """Machine-readable expectations for one published benchmark."""

    benchmark_id: str
    title: str
    reference: dict[str, Any] = {}
    topic: str
    expected_trials: list[BenchmarkTrial]
    expected_primary_result: dict[str, Any] = {}
    recall_thresholds: dict[str, float] = Field(default_factory=lambda: {"search": 1.0})
    adjacent_nonbenchmark_records: list[dict[str, Any]] = []

    @classmethod
    def load(cls, path: str | Path) -> "BenchmarkManifest":
        return cls.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))

    def required_trials(self, scope: str = "search") -> list[BenchmarkTrial]:
        if scope == "search":
            return [trial for trial in self.expected_trials if trial.required_for_search_recall]
        return list(self.expected_trials)


class BenchmarkRecallResult(BaseModel):
    """Recall evaluation for observed records against a benchmark manifest."""

    benchmark_id: str
    scope: str
    total_required: int
    matched: int
    recall: float
    threshold: float
    passed: bool
    matches: dict[str, list[dict[str, Any]]]
    missing: list[dict[str, Any]]


class BenchmarkPrimaryComparison(BaseModel):
    """Primary-analysis comparison against benchmark trial/event anchors."""

    total_expected_trials: int
    matched_trials: int
    recall: float
    passed: bool
    matched: dict[str, dict[str, Any]]
    missing: list[dict[str, Any]]
    unexpected_rows: list[dict[str, Any]]
    observed_events_intervention: int
    observed_total_intervention: int
    observed_events_control: int
    observed_total_control: int
    expected_events_intervention: int
    expected_total_intervention: int
    expected_events_control: int
    expected_total_control: int
    observed_total_participants: int
    expected_total_participants: int
    participant_difference: int
    differences: dict[str, int]
    trial_recall_passed: bool
    unexpected_rows_passed: bool
    event_totals_passed: bool
    patient_totals_passed: bool
    timepoint_adjudication_passed: bool = True
    timepoint_mismatches: list[dict[str, Any]] = []
    failure_reasons: list[str]


class BenchmarkAnchorSummary(BaseModel):
    """Published benchmark anchor values used for project comparison."""

    n_trials: int = 0
    n_participants: int = 0
    effect_measure: str = ""
    model_preference: str = ""
    effect: float | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None
    aggregate_events_intervention: int = 0
    aggregate_total_intervention: int = 0
    aggregate_events_control: int = 0
    aggregate_total_control: int = 0
    expected_trial_ids: list[str] = []


class BenchmarkPooledEffectComparison(BaseModel):
    """Compare observed pooled primary effect against the published anchor."""

    expected_effect_measure: str = ""
    observed_effect_measure: str = ""
    expected_model_preference: str = ""
    observed_model_preference: str = ""
    expected_n_trials: int = 0
    observed_n_studies: int = 0
    expected_effect: float | None = None
    observed_effect: float | None = None
    expected_ci_lower: float | None = None
    observed_ci_lower: float | None = None
    expected_ci_upper: float | None = None
    observed_ci_upper: float | None = None
    effect_difference: float | None = None
    ci_lower_difference: float | None = None
    ci_upper_difference: float | None = None
    effect_tolerance: float = 0.02
    ci_tolerance: float = 0.03
    effect_measure_passed: bool = False
    model_preference_passed: bool | None = None
    n_studies_passed: bool = False
    effect_passed: bool = False
    ci_passed: bool = False
    passed: bool = False
    failure_reasons: list[str] = []
    compatibility_notes: list[str] = []
    compatibility_notes: list[str] = []


class BenchmarkManuscriptGate(BaseModel):
    """Check whether benchmark manuscript output is safe for the run state."""

    report_type: str = ""
    validation_passed: bool | None = None
    validation_issue_kinds: list[str] = []
    blocked_run: bool = False
    draft_present: bool = False
    publication_style_sections_present: bool = False
    forbidden_sections: list[str] = []
    unsupported_conclusion_present: bool = False
    unsupported_conclusion_phrases: list[str] = []
    expected_issue_codes: list[str] = []
    missing_issue_codes: list[str] = []
    passed: bool = True
    failure_reasons: list[str] = []


class BenchmarkProjectReport(BaseModel):
    """Benchmark comparison across project stages."""

    benchmark_id: str
    project_dir: str
    summary_card: dict[str, Any] | None = None
    anchor_summary: BenchmarkAnchorSummary | None = None
    search_recall: BenchmarkRecallResult | None = None
    primary_publication_recall: BenchmarkRecallResult | None = None
    full_text_recall: BenchmarkRecallResult | None = None
    primary_full_text_recall: BenchmarkRecallResult | None = None
    primary_analysis: BenchmarkPrimaryComparison | None = None
    pooled_effect: BenchmarkPooledEffectComparison | None = None
    manuscript_gate: BenchmarkManuscriptGate | None = None


class BenchmarkRegistryAugmentationAttempt(BaseModel):
    """One manifest-driven registry lookup attempted during benchmark evaluation."""

    trial_id: str
    trial_name: str
    nct_id: str
    status: str
    added: bool = False
    matched_existing: bool = False
    error: str = ""
    record_title: str = ""
    source: str = ""
    cache_path: str = ""


class BenchmarkRegistryAugmentationResult(BaseModel):
    """Audit record for registry augmentation driven by a benchmark manifest."""

    benchmark_id: str
    scope: str
    total_input_records: int
    total_output_records: int
    added: int
    recall_before: BenchmarkRecallResult
    recall_after: BenchmarkRecallResult
    attempts: list[BenchmarkRegistryAugmentationAttempt]
    records_added: list[dict[str, Any]]


def evaluate_benchmark_recall(
    manifest: BenchmarkManifest,
    records: list[dict[str, Any]],
    *,
    scope: str = "search",
) -> BenchmarkRecallResult:
    """Evaluate whether retrieved/screened records recall expected benchmark trials."""
    required = manifest.required_trials(scope)
    matches: dict[str, list[dict[str, Any]]] = {}
    missing: list[dict[str, Any]] = []
    if scope == "primary_publication":
        matcher = record_matches_primary_publication
    elif scope == "primary_full_text":
        matcher = lambda record, trial: (
            record_matches_primary_publication(record, trial)
            and _record_has_full_text_source(record)
        )
    else:
        matcher = record_matches_trial
    for trial in required:
        trial_matches = [
            _record_summary(record)
            for record in records
            if matcher(record, trial)
        ]
        if trial_matches:
            matches[trial.trial_id] = trial_matches
        else:
            missing.append({
                "trial_id": trial.trial_id,
                "trial_name": trial.trial_name,
                "registration_id": trial.registration_id,
                "aliases": trial.aliases,
                "publication_pmids": trial.publication_pmids,
                "publication_dois": trial.publication_dois,
            })
    total = len(required)
    matched = len(matches)
    recall = matched / total if total else 1.0
    threshold = float(manifest.recall_thresholds.get(scope, 1.0))
    return BenchmarkRecallResult(
        benchmark_id=manifest.benchmark_id,
        scope=scope,
        total_required=total,
        matched=matched,
        recall=recall,
        threshold=threshold,
        passed=recall >= threshold,
        matches=matches,
        missing=missing,
    )


def augment_records_with_manifest_registry(
    manifest: BenchmarkManifest,
    records: list[dict[str, Any]],
    *,
    cache_dir: str | Path | None = None,
    scope: str = "search",
    only_missing: bool = True,
    timeout: int | None = None,
) -> tuple[list[dict[str, Any]], BenchmarkRegistryAugmentationResult]:
    """Try to close benchmark recall gaps by fetching known NCT registrations.

    This is a regression harness, not ordinary user-facing retrieval. It uses
    only the external registry identifier in the benchmark manifest; it never
    copies benchmark event counts or extracted outcome values into records.
    """
    from new_meta.tools import clinicaltrials

    augmented = [dict(record) for record in records]
    recall_before = evaluate_benchmark_recall(manifest, augmented, scope=scope)
    missing_ids = {item["trial_id"] for item in recall_before.missing}
    candidate_trials = manifest.required_trials(scope)
    if only_missing:
        candidate_trials = [trial for trial in candidate_trials if trial.trial_id in missing_ids]

    attempts: list[BenchmarkRegistryAugmentationAttempt] = []
    records_added: list[dict[str, Any]] = []
    for trial in candidate_trials:
        nct_id = str(trial.registration_id or "").strip()
        if not nct_id:
            attempts.append(BenchmarkRegistryAugmentationAttempt(
                trial_id=trial.trial_id,
                trial_name=trial.trial_name,
                nct_id="",
                status="skipped",
                error="missing_registration_id",
            ))
            continue

        if any(record_matches_trial(record, trial) for record in augmented):
            attempts.append(BenchmarkRegistryAugmentationAttempt(
                trial_id=trial.trial_id,
                trial_name=trial.trial_name,
                nct_id=nct_id,
                status="already_present",
                matched_existing=True,
            ))
            continue

        try:
            if timeout is None:
                record, status = clinicaltrials.fetch_study_cached(nct_id, cache_dir=cache_dir)
            else:
                record, status = clinicaltrials.fetch_study_cached(
                    nct_id,
                    cache_dir=cache_dir,
                    timeout=timeout,
                )
        except Exception as exc:  # Defensive: benchmark reporting must not abort the whole run.
            record = None
            status = {"status": "failed", "error": str(exc)}

        status_name = str(status.get("status") or ("ok" if record else "failed"))
        error = str(status.get("error") or "")
        cache_path = str(status.get("cache_path") or "")
        added = False
        record_title = ""
        source = ""
        if record:
            record_title = str(record.get("title") or "")
            source = str(record.get("source") or record.get("source_type") or "")
            if record_matches_trial(record, trial):
                augmented.append(record)
                records_added.append(_record_summary(record))
                added = True
            else:
                status_name = "unmatched"
                error = error or "registry_record_did_not_match_manifest_trial"
        attempts.append(BenchmarkRegistryAugmentationAttempt(
            trial_id=trial.trial_id,
            trial_name=trial.trial_name,
            nct_id=nct_id,
            status=status_name,
            added=added,
            error=error,
            record_title=record_title,
            source=source,
            cache_path=cache_path,
        ))

    recall_after = evaluate_benchmark_recall(manifest, augmented, scope=scope)
    return augmented, BenchmarkRegistryAugmentationResult(
        benchmark_id=manifest.benchmark_id,
        scope=scope,
        total_input_records=len(records),
        total_output_records=len(augmented),
        added=len(records_added),
        recall_before=recall_before,
        recall_after=recall_after,
        attempts=attempts,
        records_added=records_added,
    )


def evaluate_project_against_benchmark(
    manifest: BenchmarkManifest,
    project_dir: str | Path,
) -> BenchmarkProjectReport:
    """Evaluate a persisted MetaAgent project against a published benchmark."""
    project_dir = Path(project_dir)
    search = None
    primary_publication = None
    search_path = project_dir / "search_results.json"
    if search_path.exists():
        search_records = json.loads(search_path.read_text(encoding="utf-8"))
        primary_source_records = _benchmark_source_records(
            project_dir,
            manifest,
            full_text_only=False,
        )
        search = evaluate_benchmark_recall(
            manifest,
            search_records,
            scope="search",
        )
        primary_publication = evaluate_benchmark_recall(
            manifest,
            [*search_records, *primary_source_records],
            scope="primary_publication",
        )

    full_text = None
    primary_full_text = None
    ft_path = project_dir / "screening" / "full_text_screening.json"
    if ft_path.exists():
        ft_records = [
            item.get("paper", item)
            for item in json.loads(ft_path.read_text(encoding="utf-8"))
        ]
        ft_records = [
            *ft_records,
            *_benchmark_source_records(project_dir, manifest, full_text_only=True),
        ]
        full_text = evaluate_benchmark_recall(manifest, ft_records, scope="full_text")
        primary_full_text = evaluate_benchmark_recall(manifest, ft_records, scope="primary_full_text")

    primary = None
    audit_path = project_dir / "analysis" / "effect_selection_audit.json"
    if audit_path.exists():
        audit_rows = json.loads(audit_path.read_text(encoding="utf-8"))
        extraction_records = _extraction_record_map(project_dir)
        selected_rows = [row for row in audit_rows if row.get("in_final_primary_analysis")]
        primary = compare_primary_analysis(manifest, selected_rows, extraction_records)

    pooled_effect = None
    meta_results_path = project_dir / "analysis" / "meta_results.json"
    if meta_results_path.exists():
        pooled_effect = compare_pooled_effect(
            manifest,
            json.loads(meta_results_path.read_text(encoding="utf-8")),
        )

    manuscript_gate = _evaluate_manuscript_gate(project_dir)

    report = BenchmarkProjectReport(
        benchmark_id=manifest.benchmark_id,
        project_dir=str(project_dir),
        anchor_summary=benchmark_anchor_summary(manifest),
        search_recall=search,
        primary_publication_recall=primary_publication,
        full_text_recall=full_text,
        primary_full_text_recall=primary_full_text,
        primary_analysis=primary,
        pooled_effect=pooled_effect,
        manuscript_gate=manuscript_gate,
    )
    report.summary_card = build_benchmark_summary_card(report)
    return report


def write_project_benchmark_report(
    report: BenchmarkProjectReport,
    project_dir: str | Path | None = None,
) -> dict[str, Path]:
    """Persist a benchmark report in a project for packaging and UI review."""
    base_dir = Path(project_dir or report.project_dir)
    benchmark_dir = base_dir / "benchmark"
    benchmark_dir.mkdir(parents=True, exist_ok=True)
    summary_card = report.summary_card or build_benchmark_summary_card(report)
    report_path = benchmark_dir / "benchmark_report.json"
    summary_path = benchmark_dir / "benchmark_summary_card.json"
    report_path.write_text(
        json.dumps(report.model_dump(), ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    summary_path.write_text(
        json.dumps(summary_card, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    _clear_stale_warnings_after_passed_benchmark(base_dir, summary_card)
    return {
        "report": report_path,
        "summary_card": summary_path,
    }


def _clear_stale_warnings_after_passed_benchmark(base_dir: Path, summary_card: dict[str, Any]) -> int:
    """Remove source-recall warnings contradicted by a fully passing benchmark."""
    if not summary_card.get("passed") or summary_card.get("failing_gates"):
        return 0
    warnings_path = base_dir / "pipeline_warnings.json"
    if not warnings_path.exists():
        return 0
    try:
        warnings = json.loads(warnings_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(warnings, list):
        return 0
    stale_codes = {"clinicaltrials_fallback_failed"}
    kept = [
        warning for warning in warnings
        if not (isinstance(warning, dict) and warning.get("code") in stale_codes)
    ]
    removed = len(warnings) - len(kept)
    if removed:
        warnings_path.write_text(
            json.dumps(kept, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
    return removed


def build_benchmark_summary_card(report: BenchmarkProjectReport) -> dict[str, Any]:
    """Build a compact UI-facing benchmark comparison summary.

    The full project report remains machine-auditable. This card is the
    high-signal view a user needs: published anchor, observed estimate, failing
    gates, and concrete next actions.
    """
    gates = [
        _recall_gate("search_recall", "Search recall", report.search_recall),
        _recall_gate("primary_publication_recall", "Primary publication recall", report.primary_publication_recall),
        _recall_gate("full_text_recall", "Full-text recall", report.full_text_recall),
        _recall_gate("primary_full_text_recall", "Primary full-text recall", report.primary_full_text_recall),
        _primary_analysis_gate(report.primary_analysis),
        _pooled_effect_gate(report.pooled_effect),
        _manuscript_gate(report.manuscript_gate),
    ]
    gates = [gate for gate in gates if gate is not None]
    failing = [gate for gate in gates if gate.get("passed") is False]
    missing_primary_full_texts = []
    if report.primary_full_text_recall:
        missing_primary_full_texts = report.primary_full_text_recall.missing
    status = _benchmark_summary_status(gates, failing)
    return {
        "benchmark_id": report.benchmark_id,
        "project_dir": report.project_dir,
        "status": status,
        "passed": status == "passed",
        "published_anchor": report.anchor_summary.model_dump() if report.anchor_summary else {},
        "observed_primary": _observed_primary_summary(report),
        "gates": gates,
        "failing_gates": failing,
        "missing_primary_full_texts": missing_primary_full_texts,
        "next_actions": _benchmark_next_actions(failing),
    }


def _benchmark_summary_status(gates: list[dict[str, Any]], failing: list[dict[str, Any]]) -> str:
    if not gates:
        return "incomplete"
    if not failing:
        return "passed"
    blocked_gates = {"full_text_recall", "primary_full_text_recall", "manuscript_gate"}
    if any(gate.get("gate") in blocked_gates for gate in failing):
        return "blocked"
    return "failed"


def _recall_gate(gate: str, label: str, result: BenchmarkRecallResult | None) -> dict[str, Any] | None:
    if result is None:
        return None
    return {
        "gate": gate,
        "label": label,
        "passed": result.passed,
        "matched": result.matched,
        "total": result.total_required,
        "recall": result.recall,
        "threshold": result.threshold,
        "missing": result.missing,
        "failure_reasons": [] if result.passed else [f"{gate}_below_threshold"],
    }


def _primary_analysis_gate(result: BenchmarkPrimaryComparison | None) -> dict[str, Any] | None:
    if result is None:
        return None
    return {
        "gate": "primary_analysis",
        "label": "Primary analysis rows",
        "passed": result.passed,
        "matched": result.matched_trials,
        "total": result.total_expected_trials,
        "participant_difference": result.participant_difference,
        "differences": result.differences,
        "missing": result.missing,
        "unexpected_rows": result.unexpected_rows,
        "failure_reasons": result.failure_reasons,
    }


def _pooled_effect_gate(result: BenchmarkPooledEffectComparison | None) -> dict[str, Any] | None:
    if result is None:
        return None
    return {
        "gate": "pooled_effect",
        "label": "Published pooled effect",
        "passed": result.passed,
        "expected": {
            "effect_measure": result.expected_effect_measure,
            "model_preference": result.expected_model_preference,
            "n_trials": result.expected_n_trials,
            "effect": result.expected_effect,
            "ci_lower": result.expected_ci_lower,
            "ci_upper": result.expected_ci_upper,
        },
        "observed": {
            "effect_measure": result.observed_effect_measure,
            "model_preference": result.observed_model_preference,
            "n_studies": result.observed_n_studies,
            "effect": result.observed_effect,
            "ci_lower": result.observed_ci_lower,
            "ci_upper": result.observed_ci_upper,
        },
        "differences": {
            "effect": result.effect_difference,
            "ci_lower": result.ci_lower_difference,
            "ci_upper": result.ci_upper_difference,
        },
        "failure_reasons": result.failure_reasons,
        "compatibility_notes": result.compatibility_notes,
    }


def _manuscript_gate(result: BenchmarkManuscriptGate | None) -> dict[str, Any] | None:
    if result is None:
        return None
    return {
        "gate": "manuscript_gate",
        "label": "Manuscript safety gate",
        "passed": result.passed,
        "report_type": result.report_type,
        "blocked_run": result.blocked_run,
        "validation_passed": result.validation_passed,
        "validation_issue_kinds": result.validation_issue_kinds,
        "forbidden_sections": result.forbidden_sections,
        "missing_issue_codes": result.missing_issue_codes,
        "failure_reasons": result.failure_reasons,
    }


def _observed_primary_summary(report: BenchmarkProjectReport) -> dict[str, Any]:
    pooled = report.pooled_effect
    primary = report.primary_analysis
    return {
        "effect_measure": pooled.observed_effect_measure if pooled else "",
        "model_preference": pooled.observed_model_preference if pooled else "",
        "n_studies": pooled.observed_n_studies if pooled else 0,
        "effect": pooled.observed_effect if pooled else None,
        "ci_lower": pooled.observed_ci_lower if pooled else None,
        "ci_upper": pooled.observed_ci_upper if pooled else None,
        "total_participants": primary.observed_total_participants if primary else 0,
        "participant_difference": primary.participant_difference if primary else None,
    }


def _benchmark_next_actions(failing: list[dict[str, Any]]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    for gate in failing:
        gate_name = str(gate.get("gate") or "")
        if gate_name == "search_recall":
            actions.append({
                "type": "improve_search",
                "message": "Broaden retrieval or run registry augmentation until all expected benchmark trials are recalled.",
            })
        elif gate_name == "primary_publication_recall":
            actions.append({
                "type": "retrieve_primary_publications",
                "message": "Retrieve the expected primary publications; secondary/design papers cannot satisfy this benchmark gate.",
            })
        elif gate_name in {"full_text_recall", "primary_full_text_recall"}:
            actions.append({
                "type": "upload_full_texts",
                "message": "Upload source PDF/HTML for the missing expected publications before accepting a publication-style manuscript.",
            })
        elif gate_name == "primary_analysis":
            actions.append({
                "type": "review_primary_rows",
                "message": "Review selected primary-effect rows, arm-level counts, and timepoint adjudication against the published benchmark.",
            })
        elif gate_name == "pooled_effect":
            actions.append({
                "type": "review_effect_model",
                "message": "Check effect measure, selected studies, and pooling inputs against the published anchor.",
            })
        elif gate_name == "manuscript_gate":
            actions.append({
                "type": "resolve_manuscript_gate",
                "message": "Resolve evidence-readiness or validation blockers before generating a publication-style report.",
            })
    deduped: list[dict[str, str]] = []
    seen = set()
    for action in actions:
        if action["type"] in seen:
            continue
        seen.add(action["type"])
        deduped.append(action)
    return deduped


def benchmark_anchor_summary(manifest: BenchmarkManifest) -> BenchmarkAnchorSummary:
    """Return compact published anchor values for reporting system-vs-paper gaps."""
    primary = manifest.expected_primary_result or {}
    if primary.get("fixed_effect"):
        model_preference = "fixed"
        fixed = primary.get("fixed_effect") or {}
    else:
        model_preference = "random" if primary.get("random_effects") else ""
        fixed = primary.get("random_effects") or {}
    expected = _expected_primary_counts(manifest)
    return BenchmarkAnchorSummary(
        n_trials=_int_or_zero(primary.get("n_trials")) or len(manifest.expected_trials),
        n_participants=_int_or_zero(primary.get("n_participants")) or _expected_participant_total(manifest, expected),
        effect_measure=str(primary.get("effect_measure") or ""),
        model_preference=model_preference,
        effect=fixed.get("effect"),
        ci_lower=fixed.get("ci_lower"),
        ci_upper=fixed.get("ci_upper"),
        aggregate_events_intervention=_int_or_zero(primary.get("aggregate_events_intervention")) or expected["events_intervention"],
        aggregate_total_intervention=_int_or_zero(primary.get("aggregate_total_intervention")) or expected["total_intervention"],
        aggregate_events_control=_int_or_zero(primary.get("aggregate_events_control")) or expected["events_control"],
        aggregate_total_control=_int_or_zero(primary.get("aggregate_total_control")) or expected["total_control"],
        expected_trial_ids=[trial.trial_id for trial in manifest.expected_trials],
    )


def compare_pooled_effect(
    manifest: BenchmarkManifest,
    meta_results: dict[str, Any],
    *,
    effect_tolerance: float = 0.02,
    ci_tolerance: float = 0.03,
) -> BenchmarkPooledEffectComparison:
    """Compare a project's primary pooled estimate with the published anchor."""
    anchor = benchmark_anchor_summary(manifest)
    primary = meta_results.get("primary_outcome") if isinstance(meta_results, dict) else None
    primary = primary if isinstance(primary, dict) else {}

    expected_effect = _float_or_none(anchor.effect)
    expected_ci_lower = _float_or_none(anchor.ci_lower)
    expected_ci_upper = _float_or_none(anchor.ci_upper)
    observed_effect = _float_or_none(primary.get("pooled_effect"))
    observed_ci_lower = _float_or_none(primary.get("ci_lower"))
    observed_ci_upper = _float_or_none(primary.get("ci_upper"))
    expected_measure = str(anchor.effect_measure or "").strip().upper()
    observed_measure = str(primary.get("effect_measure") or "").strip().upper()
    expected_model = str(anchor.model_preference or "").strip().lower()
    observed_model = str(primary.get("model") or primary.get("model_preference") or "").strip().lower()
    tau_squared = _float_or_none(primary.get("tau_squared"))
    expected_n = anchor.n_trials
    observed_n = _int_or_zero(primary.get("n_studies"))

    failure_reasons: list[str] = []
    compatibility_notes: list[str] = []
    if not primary:
        failure_reasons.append("missing_meta_results_primary")
    if expected_effect is None or expected_ci_lower is None or expected_ci_upper is None:
        failure_reasons.append("missing_published_effect_anchor")

    effect_measure_passed = bool(expected_measure and observed_measure and expected_measure == observed_measure)
    if not effect_measure_passed:
        failure_reasons.append("effect_measure_mismatch")

    model_preference_passed: bool | None = None
    if expected_model and observed_model:
        equivalent_zero_tau_model = (
            expected_model == "fixed"
            and observed_model == "random"
            and tau_squared is not None
            and abs(tau_squared) <= 1e-12
        )
        model_preference_passed = expected_model == observed_model or equivalent_zero_tau_model
        if equivalent_zero_tau_model and expected_model != observed_model:
            compatibility_notes.append("random_model_equivalent_to_fixed_tau_zero")
        if not model_preference_passed:
            failure_reasons.append("model_preference_mismatch")

    n_studies_passed = bool(expected_n and observed_n == expected_n)
    if not n_studies_passed:
        failure_reasons.append("n_studies_mismatch")

    effect_difference = _difference(observed_effect, expected_effect)
    effect_passed = effect_difference is not None and abs(effect_difference) <= effect_tolerance
    if not effect_passed:
        failure_reasons.append("pooled_effect_mismatch")

    ci_lower_difference = _difference(observed_ci_lower, expected_ci_lower)
    ci_upper_difference = _difference(observed_ci_upper, expected_ci_upper)
    ci_passed = (
        ci_lower_difference is not None
        and ci_upper_difference is not None
        and abs(ci_lower_difference) <= ci_tolerance
        and abs(ci_upper_difference) <= ci_tolerance
    )
    if not ci_passed:
        failure_reasons.append("pooled_ci_mismatch")

    failure_reasons = list(dict.fromkeys(failure_reasons))
    passed = (
        not failure_reasons
        and effect_measure_passed
        and (model_preference_passed is not False)
        and n_studies_passed
        and effect_passed
        and ci_passed
    )
    return BenchmarkPooledEffectComparison(
        expected_effect_measure=expected_measure,
        observed_effect_measure=observed_measure,
        expected_model_preference=expected_model,
        observed_model_preference=observed_model,
        expected_n_trials=expected_n,
        observed_n_studies=observed_n,
        expected_effect=expected_effect,
        observed_effect=observed_effect,
        expected_ci_lower=expected_ci_lower,
        observed_ci_lower=observed_ci_lower,
        expected_ci_upper=expected_ci_upper,
        observed_ci_upper=observed_ci_upper,
        effect_difference=effect_difference,
        ci_lower_difference=ci_lower_difference,
        ci_upper_difference=ci_upper_difference,
        effect_tolerance=effect_tolerance,
        ci_tolerance=ci_tolerance,
        effect_measure_passed=effect_measure_passed,
        model_preference_passed=model_preference_passed,
        n_studies_passed=n_studies_passed,
        effect_passed=effect_passed,
        ci_passed=ci_passed,
        passed=passed,
        failure_reasons=failure_reasons,
        compatibility_notes=compatibility_notes,
    )


def _evaluate_manuscript_gate(project_dir: Path) -> BenchmarkManuscriptGate | None:
    facts_path = project_dir / "manuscript" / "manuscript_facts.json"
    validation_path = project_dir / "manuscript" / "manuscript_validation.json"
    draft_path = project_dir / "manuscript" / "draft.md"
    if not facts_path.exists() and not validation_path.exists() and not draft_path.exists():
        return None

    facts = json.loads(facts_path.read_text(encoding="utf-8")) if facts_path.exists() else {}
    validation = json.loads(validation_path.read_text(encoding="utf-8")) if validation_path.exists() else {}
    report_type = str(facts.get("report_type") or (validation.get("facts_summary") or {}).get("report_type") or "")
    validation_passed = validation.get("passed")
    validation_issue_kinds = sorted({
        str(issue.get("kind") or issue.get("type") or "")
        for issue in validation.get("issues", []) or []
        if str(issue.get("kind") or issue.get("type") or "")
    })
    blocked_run = report_type in {"evidence_gap", "failed", "failed_systematic_review"}
    validation_failed = validation_passed is False and not blocked_run
    draft = draft_path.read_text(encoding="utf-8") if draft_path.exists() else ""
    forbidden_sections = _publication_style_sections(draft) if blocked_run else []
    unsupported_phrases = _blocked_report_conclusion_phrases(draft) if blocked_run else []
    expected_issue_codes = _expected_blocked_report_codes(facts, validation) if blocked_run else []
    missing_issue_codes = _missing_codes_from_draft(draft, expected_issue_codes) if blocked_run else []
    failure_reasons = []
    if blocked_run and not draft_path.exists():
        failure_reasons.append("missing_blocked_run_draft")
    if forbidden_sections:
        failure_reasons.append("blocked_publication_sections")
    if unsupported_phrases:
        failure_reasons.append("blocked_unsupported_conclusion_language")
    if missing_issue_codes:
        failure_reasons.append("blocked_missing_issue_codes")
    if validation_failed:
        failure_reasons.append("manuscript_validation_failed")
    return BenchmarkManuscriptGate(
        report_type=report_type,
        validation_passed=validation_passed,
        validation_issue_kinds=validation_issue_kinds,
        blocked_run=blocked_run,
        draft_present=draft_path.exists(),
        publication_style_sections_present=bool(forbidden_sections),
        forbidden_sections=forbidden_sections,
        unsupported_conclusion_present=bool(unsupported_phrases),
        unsupported_conclusion_phrases=unsupported_phrases,
        expected_issue_codes=expected_issue_codes,
        missing_issue_codes=missing_issue_codes,
        passed=not failure_reasons,
        failure_reasons=failure_reasons,
    )


def _publication_style_sections(markdown: str) -> list[str]:
    forbidden = []
    for heading in ("Abstract", "摘要", "Methods", "方法", "Results", "结果"):
        if re.search(rf"(?im)^##\s+{re.escape(heading)}\b", markdown or ""):
            forbidden.append(heading)
    return forbidden


def _blocked_report_conclusion_phrases(markdown: str) -> list[str]:
    text = markdown or ""
    patterns = {
        "publication-ready": r"\bpublication[- ]ready\b",
        "concludes effectiveness": r"\b(conclude|concludes|concluded)\b.{0,80}\b(effective|efficacy|benefit|beneficial)\b",
        "significant effect claim": r"\bsignificant(?:ly)?\b.{0,80}\b(reduced|increased|improved|benefit|effect)\b",
        "demonstrated efficacy": r"\b(demonstrated|showed|shows)\b.{0,80}\b(efficacy|effectiveness|benefit)\b",
        "疗效结论": r"(显著|明确|证明|显示).{0,30}(降低|改善|有效|获益|疗效)",
        "证据结论": r"(可以|能够|能).{0,20}(降低|改善|提高).{0,20}(死亡|风险|结局)",
    }
    hits = []
    for label, pattern in patterns.items():
        for match in re.finditer(pattern, text, flags=re.IGNORECASE | re.DOTALL):
            if label == "publication-ready" and _match_is_negated_blocked_claim(text, match.start()):
                continue
            hits.append(label)
            break
    return hits


def _match_is_negated_blocked_claim(text: str, start: int) -> bool:
    window = text[max(0, start - 100):start].lower()
    return any(marker in window for marker in (
        "not ",
        "not a ",
        "rather than",
        "blocked",
        "must not",
        "cannot",
        "is not",
        "are not",
        "unresolved evidence blockers",
    ))


def _expected_blocked_report_codes(facts: dict[str, Any], validation: dict[str, Any]) -> list[str]:
    readiness = facts.get("evidence_readiness") or {}
    codes: list[str] = []
    codes.extend(str(code) for code in readiness.get("blocker_codes") or [] if code)
    codes.extend(str(item.get("code")) for item in readiness.get("blockers") or [] if item.get("code"))
    if not codes:
        codes.extend(
            str(issue.get("kind"))
            for issue in validation.get("issues") or []
            if issue.get("kind") and issue.get("severity") in {"error", "warning"}
        )
    return list(dict.fromkeys(code for code in codes if code and code != "None"))


def _missing_codes_from_draft(markdown: str, codes: list[str]) -> list[str]:
    return [code for code in codes if code not in (markdown or "")]


def compare_primary_analysis(
    manifest: BenchmarkManifest,
    selected_rows: list[dict[str, Any]],
    extraction_records: dict[str, dict[str, Any]] | None = None,
) -> BenchmarkPrimaryComparison:
    """Compare selected primary-effect rows with benchmark trial/event anchors."""
    extraction_records = extraction_records or {}
    matched: dict[str, dict[str, Any]] = {}
    unexpected_rows: list[dict[str, Any]] = []
    for row in selected_rows:
        record = dict(extraction_records.get(str(row.get("study_id") or ""), {}))
        study_id = str(row.get("study_id") or "")
        record.update({
            "pmid": record.get("pmid") or ("" if _looks_like_doi(study_id) else study_id),
            "title": record.get("title") or row.get("study_label") or "",
            "doi": record.get("doi") or (study_id if _looks_like_doi(study_id) else ""),
            "source": record.get("source") or "effect_selection_audit",
        })
        trial = next((trial for trial in manifest.expected_trials if record_matches_trial(record, trial)), None)
        row_summary = _primary_row_summary(row, record)
        if trial is None:
            unexpected_rows.append(row_summary)
        elif trial.trial_id not in matched:
            _add_expected_primary_counts(row_summary, trial)
            matched[trial.trial_id] = row_summary

    missing = [
        {
            "trial_id": trial.trial_id,
            "trial_name": trial.trial_name,
            "registration_id": trial.registration_id,
            "expected_events_intervention": trial.expected_events_intervention,
            "expected_total_intervention": trial.expected_total_intervention,
            "expected_events_control": trial.expected_events_control,
            "expected_total_control": trial.expected_total_control,
        }
        for trial in manifest.expected_trials
        if trial.trial_id not in matched
    ]

    timepoint_mismatches = _primary_timepoint_mismatches(manifest, matched)
    observed = _sum_primary_counts(selected_rows)
    expected = _expected_primary_counts(manifest)
    differences = {
        key: observed[key] - expected[key]
        for key in observed
    }
    observed_total_participants = observed["total_intervention"] + observed["total_control"]
    expected_total_participants = _expected_participant_total(manifest, expected)
    participant_difference = observed_total_participants - expected_total_participants
    total = len(manifest.expected_trials)
    matched_count = len(matched)
    recall = matched_count / total if total else 1.0
    trial_recall_passed = matched_count == total
    unexpected_rows_passed = not unexpected_rows
    event_totals_passed = all(value == 0 for value in differences.values())
    patient_totals_passed = participant_difference == 0
    timepoint_adjudication_passed = not timepoint_mismatches
    failure_reasons = []
    if not trial_recall_passed:
        failure_reasons.append("missing_expected_trials")
    if not unexpected_rows_passed:
        failure_reasons.append("unexpected_primary_rows")
    if not event_totals_passed:
        failure_reasons.append("event_or_arm_total_mismatch")
    if not patient_totals_passed:
        failure_reasons.append("patient_total_mismatch")
    if not timepoint_adjudication_passed:
        failure_reasons.append("timepoint_adjudication_mismatch")
    passed = (
        trial_recall_passed
        and unexpected_rows_passed
        and event_totals_passed
        and patient_totals_passed
        and timepoint_adjudication_passed
    )
    return BenchmarkPrimaryComparison(
        total_expected_trials=total,
        matched_trials=matched_count,
        recall=recall,
        passed=passed,
        matched=matched,
        missing=missing,
        unexpected_rows=unexpected_rows,
        observed_events_intervention=observed["events_intervention"],
        observed_total_intervention=observed["total_intervention"],
        observed_events_control=observed["events_control"],
        observed_total_control=observed["total_control"],
        expected_events_intervention=expected["events_intervention"],
        expected_total_intervention=expected["total_intervention"],
        expected_events_control=expected["events_control"],
        expected_total_control=expected["total_control"],
        observed_total_participants=observed_total_participants,
        expected_total_participants=expected_total_participants,
        participant_difference=participant_difference,
        differences=differences,
        trial_recall_passed=trial_recall_passed,
        unexpected_rows_passed=unexpected_rows_passed,
        event_totals_passed=event_totals_passed,
        patient_totals_passed=patient_totals_passed,
        timepoint_adjudication_passed=timepoint_adjudication_passed,
        timepoint_mismatches=timepoint_mismatches,
        failure_reasons=failure_reasons,
    )


def record_matches_trial(record: dict[str, Any], trial: BenchmarkTrial) -> bool:
    """Return True when a search/screening record appears to represent a trial."""
    pmid = str(record.get("pmid") or "").strip()
    if pmid and pmid in {str(item) for item in trial.publication_pmids}:
        return True
    doi = _normalise_doi(record.get("doi"))
    if doi and doi in {_normalise_doi(item) for item in trial.publication_dois}:
        return True

    identity_haystack = _normalise_text(" ".join(_record_identity_text_parts(record)))
    registration = _normalise_text(trial.registration_id)
    if registration and registration in identity_haystack:
        return True

    title_haystack = _normalise_text(str(record.get("title") or ""))
    for identifier in [trial.trial_name, *trial.aliases]:
        if _alias_matches_title(identifier, title_haystack):
            return True
    return False


def record_matches_primary_publication(record: dict[str, Any], trial: BenchmarkTrial) -> bool:
    """Return True only for expected primary publication PMID/DOI matches."""
    expected_pmids = {str(item).strip() for item in trial.publication_pmids if str(item).strip()}
    expected_dois = {_normalise_doi(item) for item in trial.publication_dois if _normalise_doi(item)}
    if not expected_pmids and not expected_dois:
        return record_matches_trial(record, trial)

    pmid = str(record.get("pmid") or "").strip()
    if pmid and pmid in expected_pmids:
        return True
    doi = _normalise_doi(record.get("doi"))
    return bool(doi and doi in expected_dois)


def _extraction_record_map(project_dir: Path) -> dict[str, dict[str, Any]]:
    path = project_dir / "extraction" / "all_extractions.json"
    if not path.exists():
        return {}
    records = {}
    for item in json.loads(path.read_text(encoding="utf-8")):
        c = item.get("characteristics", {})
        sid = str(c.get("pmid") or c.get("study_id") or c.get("doi") or "")
        if not sid:
            continue
        records[sid] = {
            "pmid": c.get("pmid") or "",
            "doi": c.get("doi") or "",
            "title": c.get("title") or "",
            "source": c.get("source_type") or c.get("metadata_source") or "extraction",
        }
    return records


def _primary_row_summary(row: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    return {
        "row_id": row.get("row_id") or "",
        "study_id": row.get("study_id") or "",
        "pmid": record.get("pmid") or "",
        "doi": record.get("doi") or "",
        "title": record.get("title") or row.get("study_label") or "",
        "outcome_name": row.get("outcome_name") or "",
        "subgroup": row.get("subgroup") or "",
        "events_intervention": _int_or_zero(row.get("events_intervention")),
        "total_intervention": _int_or_zero(row.get("total_intervention")),
        "events_control": _int_or_zero(row.get("events_control")),
        "total_control": _int_or_zero(row.get("total_control")),
        "effect": row.get("effect"),
        "source_location": row.get("source_location") or "",
        "source_section": row.get("source_section") or "",
        "source_quote": row.get("source_quote") or "",
        "source_quote_verified": row.get("source_quote_verified"),
        "extraction_confidence": row.get("extraction_confidence"),
        "timepoint": row.get("timepoint") or "",
        "accepted_timepoint": row.get("accepted_timepoint") or "",
        "timepoint_adjudication": row.get("timepoint_adjudication") or "",
        "timepoint_adjudication_note": row.get("timepoint_adjudication_note") or "",
        "manual_adjudication": row.get("manual_adjudication"),
    }


def _add_expected_primary_counts(row: dict[str, Any], trial: BenchmarkTrial) -> None:
    expected_fields = {
        "events_intervention": _int_or_zero(trial.expected_events_intervention),
        "total_intervention": _int_or_zero(trial.expected_total_intervention),
        "events_control": _int_or_zero(trial.expected_events_control),
        "total_control": _int_or_zero(trial.expected_total_control),
    }
    row.update({
        "expected_events_intervention": expected_fields["events_intervention"],
        "expected_total_intervention": expected_fields["total_intervention"],
        "expected_events_control": expected_fields["events_control"],
        "expected_total_control": expected_fields["total_control"],
    })
    mismatches: dict[str, dict[str, int]] = {}
    for field, expected in expected_fields.items():
        observed = _int_or_zero(row.get(field))
        if observed != expected:
            mismatches[field] = {
                "observed": observed,
                "expected": expected,
            }
    row["count_mismatches"] = mismatches


def _primary_timepoint_mismatches(
    manifest: BenchmarkManifest,
    matched_rows: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    mismatches: list[dict[str, Any]] = []
    for trial in manifest.expected_trials:
        row = matched_rows.get(trial.trial_id)
        if not row:
            continue
        expected = (trial.expected_primary_timepoint or "").strip()
        accepted = [item for item in trial.accepted_timepoints if str(item or "").strip()]
        if not expected and not accepted and not trial.requires_timepoint_adjudication:
            continue

        source_text = _primary_row_timepoint_text(row)
        if trial.timepoint_kind == "time_to_event" and _row_supports_time_to_event_primary(row):
            continue
        direct_expected = bool(expected and _text_mentions_timepoint(source_text, expected))
        accepted_matches = [
            item for item in accepted
            if _text_mentions_timepoint(source_text, item)
        ]
        has_adjudication_note = _row_has_timepoint_adjudication(row)

        if direct_expected:
            continue
        if accepted_matches:
            if trial.requires_timepoint_adjudication and not has_adjudication_note:
                mismatches.append({
                    "trial_id": trial.trial_id,
                    "trial_name": trial.trial_name,
                    "row_id": row.get("row_id") or "",
                    "reason": "missing_timepoint_adjudication",
                    "expected_primary_timepoint": expected,
                    "accepted_timepoints": accepted_matches,
                    "timepoint_notes": trial.timepoint_notes,
                })
            continue
        mismatches.append({
            "trial_id": trial.trial_id,
            "trial_name": trial.trial_name,
            "row_id": row.get("row_id") or "",
            "reason": "primary_timepoint_not_matched",
            "expected_primary_timepoint": expected,
            "accepted_timepoints": accepted,
            "timepoint_notes": trial.timepoint_notes,
        })
    return mismatches


def _primary_row_timepoint_text(row: dict[str, Any]) -> str:
    return " ".join(
        str(row.get(key) or "")
        for key in (
            "timepoint",
            "accepted_timepoint",
            "source_location",
            "source_section",
            "source_quote",
            "timepoint_adjudication",
            "timepoint_adjudication_note",
        )
    ).lower()


def _row_has_timepoint_adjudication(row: dict[str, Any]) -> bool:
    if row.get("manual_adjudication") is True:
        return True
    for key in ("accepted_timepoint", "timepoint_adjudication", "timepoint_adjudication_note"):
        value = str(row.get(key) or "").strip().lower()
        if value and value not in {"none", "false", "no", "n/a", "na"}:
            return True
    return False


def _row_supports_time_to_event_primary(row: dict[str, Any]) -> bool:
    text = " ".join(
        str(row.get(key) or "")
        for key in ("source_quote", "source_location", "source_section", "timepoint", "accepted_timepoint")
    ).lower()
    if "primary outcome" not in text and "primary endpoint" not in text:
        return False
    if not (
        "hazard ratio" in text
        or re.search(r"\bhr\b", text)
        or row.get("effect") is not None
    ):
        return False
    return row.get("source_quote_verified") is not False


def _text_mentions_timepoint(text: str, timepoint: str) -> bool:
    text_norm = _normalise_text(text)
    timepoint_norm = _normalise_text(timepoint)
    if not text_norm or not timepoint_norm:
        return False
    if timepoint_norm in text_norm:
        return True
    days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", timepoint.lower()))
    if days:
        day_present = any(
            re.search(rf"\b{re.escape(day)}\s*[- ]?\s*day", text, flags=re.IGNORECASE)
            or re.search(rf"\bday\s*{re.escape(day)}\b", text, flags=re.IGNORECASE)
            for day in days
        )
        if not day_present:
            return False
        clinical_tokens = [
            token for token in timepoint_norm.split()
            if token not in {"day", "days", "all", "cause", "primary", "outcome", "at", "or"}
            and not token.isdigit()
        ]
        return not clinical_tokens or any(token in text_norm for token in clinical_tokens)
    tokens = [token for token in timepoint_norm.split() if len(token) > 2]
    return bool(tokens) and all(token in text_norm for token in tokens)


def _sum_primary_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "events_intervention": sum(_int_or_zero(row.get("events_intervention")) for row in rows),
        "total_intervention": sum(_int_or_zero(row.get("total_intervention")) for row in rows),
        "events_control": sum(_int_or_zero(row.get("events_control")) for row in rows),
        "total_control": sum(_int_or_zero(row.get("total_control")) for row in rows),
    }


def _expected_primary_counts(manifest: BenchmarkManifest) -> dict[str, int]:
    return {
        "events_intervention": sum(_int_or_zero(trial.expected_events_intervention) for trial in manifest.expected_trials),
        "total_intervention": sum(_int_or_zero(trial.expected_total_intervention) for trial in manifest.expected_trials),
        "events_control": sum(_int_or_zero(trial.expected_events_control) for trial in manifest.expected_trials),
        "total_control": sum(_int_or_zero(trial.expected_total_control) for trial in manifest.expected_trials),
    }


def _expected_participant_total(manifest: BenchmarkManifest, expected_counts: dict[str, int]) -> int:
    anchor = manifest.expected_primary_result or {}
    anchor_n = _int_or_zero(anchor.get("n_participants"))
    if anchor_n:
        return anchor_n
    return expected_counts["total_intervention"] + expected_counts["total_control"]


def _int_or_zero(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _float_or_none(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _difference(observed: float | None, expected: float | None) -> float | None:
    if observed is None or expected is None:
        return None
    return observed - expected


def _record_identity_text_parts(record: dict[str, Any]) -> list[str]:
    """Fields that identify what the record is, excluding abstract mentions."""
    parts = []
    for key in (
        "title",
        "journal",
        "doi",
        "pmid",
        "trial_registration",
        "registration_id",
        "clinicaltrials_id",
        "nct_id",
    ):
        value = record.get(key)
        if value:
            parts.append(str(value))
    for key in ("metadata", "openalex", "extra"):
        value = record.get(key)
        if isinstance(value, dict):
            parts.extend(str(v) for v in value.values() if v)
    return parts


_BENCHMARK_PRIMARY_SOURCE_KINDS = {
    "primary_source",
    "primary_full_text",
    "primary_publication_full_text",
    "full_text",
    "trial_results",
    "registry_result",
    "clinical_trial_registry",
}

_BENCHMARK_FULL_TEXT_SOURCE_KINDS = {
    "primary_source",
    "primary_full_text",
    "primary_publication_full_text",
    "full_text",
    "trial_results",
    "registry_result",
    "clinical_trial_registry",
}


def _benchmark_source_records(
    project_dir: Path,
    manifest: BenchmarkManifest,
    *,
    full_text_only: bool,
) -> list[dict[str, Any]]:
    """Return explicit user/benchmark-supplied primary source records.

    Generic benchmark snippets, figure transcriptions, screenshots, and other
    review-only sources must not satisfy publication/full-text recall gates.
    Only sources deliberately marked as primary source/full-text material can
    supplement these gates.
    """
    source_manifest_path = project_dir / "benchmark" / "benchmark_source_manifest.json"
    if not source_manifest_path.exists():
        return []
    try:
        source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    sources = source_manifest.get("sources") if isinstance(source_manifest, dict) else []
    if not isinstance(sources, list):
        return []

    trials_by_id = {trial.trial_id: trial for trial in manifest.expected_trials}
    records: list[dict[str, Any]] = []
    allowed_kinds = _BENCHMARK_FULL_TEXT_SOURCE_KINDS if full_text_only else _BENCHMARK_PRIMARY_SOURCE_KINDS
    for source in sources:
        if not isinstance(source, dict):
            continue
        kind = str(source.get("source_kind") or "").strip().lower()
        if kind not in allowed_kinds:
            continue
        if str(source.get("status") or "").lower() == "missing_file":
            continue
        parse_status = str(source.get("parse_status") or "").lower()
        text_chars = _int_or_zero(source.get("text_chars"))
        if full_text_only and (parse_status not in {"ok", "empty_text"} or text_chars <= 0):
            continue
        trial = trials_by_id.get(str(source.get("trial_id") or ""))
        if trial is None:
            continue
        records.append({
            "pmid": trial.publication_pmids[0] if trial.publication_pmids else "",
            "doi": trial.publication_dois[0] if trial.publication_dois else "",
            "title": source.get("trial_name") or trial.trial_name,
            "trial_registration": trial.registration_id,
            "registration_id": trial.registration_id,
            "source": "benchmark_source",
            "metadata_source": "benchmark_source_manifest",
            "source_kind": kind,
            "text_availability": "full_text" if text_chars > 0 else "",
            "fulltext_source": "benchmark_source" if text_chars > 0 else "",
            "fulltext_path": source.get("local_path") or source.get("parsed_path") or "",
            "benchmark_source_filename": source.get("filename") or "",
        })
    return records


def _alias_matches_title(alias: str, title_haystack: str) -> bool:
    needle = _normalise_text(alias)
    if len(needle) < 4 or not title_haystack:
        return False
    tokens = needle.split()
    if len(tokens) == 1:
        raw = (alias or "").strip().lower()
        if raw in {"recovery"}:
            return False
        if "-" not in raw and not any(ch.isdigit() for ch in raw) and len(raw) < 8:
            return False
    if needle in title_haystack:
        return True
    if len(tokens) >= 4:
        title_tokens = set(title_haystack.split())
        return all(token in title_tokens for token in tokens if len(token) > 2)
    return False


def _record_summary(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "pmid": record.get("pmid") or "",
        "doi": record.get("doi") or "",
        "title": record.get("title") or "",
        "source": record.get("source") or record.get("metadata_source") or "",
        "text_availability": record.get("text_availability") or "",
        "fulltext_source": record.get("fulltext_source") or "",
    }


def _record_has_full_text_source(record: dict[str, Any]) -> bool:
    availability = str(record.get("text_availability") or "").lower()
    if availability == "abstract_only":
        return False
    if availability == "metadata_only":
        return False
    if record.get("pdf_path") or record.get("fulltext_path"):
        return True
    source = str(record.get("fulltext_source") or "").lower()
    if source in {"europe_pmc_fulltext", "europe_pmc_html", "pdf", "user_upload", "benchmark_source"}:
        return True
    return availability == "full_text"


def _normalise_doi(value: Any) -> str:
    text = str(value or "").strip().lower()
    return re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text)


def _looks_like_doi(value: Any) -> bool:
    return str(value or "").lower().startswith("10.")


def _normalise_text(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value or "").lower())).strip()


def main(argv: list[str] | None = None) -> int:
    """CLI helper: evaluate a records JSON file against a benchmark manifest."""
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate benchmark recall for a records artifact or project directory.")
    parser.add_argument("manifest", help="Path to benchmark manifest JSON")
    parser.add_argument("target", help="Path to observed records JSON, or a project directory with --project")
    parser.add_argument("--scope", default="search", help="Recall threshold scope to use")
    parser.add_argument("--project", action="store_true", help="Evaluate a full persisted project directory")
    parser.add_argument("--augment-registry", action="store_true", help="Try manifest NCT registry fetches before recall evaluation")
    parser.add_argument("--cache-dir", help="Directory for ClinicalTrials.gov cache when using --augment-registry")
    parser.add_argument("--write-augmented", action="store_true", help="Write augmented records/audit next to the target artifact")
    parser.add_argument("--write-report", action="store_true", help="Write project benchmark report files under benchmark/")
    parser.add_argument("--no-fail", action="store_true", help="Always exit 0 after printing the result")
    args = parser.parse_args(argv)

    manifest = BenchmarkManifest.load(args.manifest)
    if args.project:
        result = evaluate_project_against_benchmark(manifest, args.target)
        if args.write_report:
            write_project_benchmark_report(result, args.target)
        if args.augment_registry:
            project_dir = Path(args.target)
            search_path = project_dir / "search_results.json"
            if search_path.exists():
                records = json.loads(search_path.read_text(encoding="utf-8"))
                cache_dir = args.cache_dir or project_dir / "papers" / "clinicaltrials_cache"
                augmented, augmentation = augment_records_with_manifest_registry(
                    manifest,
                    records,
                    cache_dir=cache_dir,
                    scope=args.scope,
                )
                if args.write_augmented:
                    (project_dir / "benchmark_registry_augmentation.json").write_text(
                        augmentation.model_dump_json(indent=2),
                        encoding="utf-8",
                    )
                    (project_dir / "search_results.registry_augmented.json").write_text(
                        json.dumps(augmented, ensure_ascii=False, indent=2, default=str),
                        encoding="utf-8",
                    )
                print(json.dumps({
                    "project_report": result.model_dump(),
                    "registry_augmentation": augmentation.model_dump(),
                }, ensure_ascii=False, indent=2, default=str))
                passed = augmentation.recall_after.passed
                return 0 if args.no_fail or passed else 1
        passed = (
            (result.search_recall is None or result.search_recall.passed)
            and (result.primary_publication_recall is None or result.primary_publication_recall.passed)
            and (result.full_text_recall is None or result.full_text_recall.passed)
            and (result.primary_full_text_recall is None or result.primary_full_text_recall.passed)
            and (result.primary_analysis is None or result.primary_analysis.passed)
            and (result.pooled_effect is None or result.pooled_effect.passed)
            and (result.manuscript_gate is None or result.manuscript_gate.passed)
        )
    else:
        records = json.loads(Path(args.target).read_text(encoding="utf-8"))
        if args.augment_registry:
            augmented, result = augment_records_with_manifest_registry(
                manifest,
                records,
                cache_dir=args.cache_dir,
                scope=args.scope,
            )
            if args.write_augmented:
                target_path = Path(args.target)
                target_path.with_suffix(target_path.suffix + ".registry_augmented.json").write_text(
                    json.dumps(augmented, ensure_ascii=False, indent=2, default=str),
                    encoding="utf-8",
                )
                target_path.with_suffix(target_path.suffix + ".registry_augmentation.json").write_text(
                    result.model_dump_json(indent=2),
                    encoding="utf-8",
                )
            passed = result.recall_after.passed
        else:
            result = evaluate_benchmark_recall(manifest, records, scope=args.scope)
            passed = result.passed
    print(result.model_dump_json(indent=2))
    return 0 if args.no_fail or passed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
