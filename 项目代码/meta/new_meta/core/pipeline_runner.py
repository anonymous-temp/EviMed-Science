"""Shared pipeline runner seams for CLI and Web orchestration."""
from __future__ import annotations

import logging
from typing import Any

from new_meta.core.project import Project
from new_meta.core.provenance import annotate_source_provenance
from new_meta.core.run_mode import load_benchmark_reference_manifest


class PipelineRunner:
    """Small shared runner for deterministic downstream steps.

    This class intentionally starts with effect selection, the most dangerous
    CLI/Web drift point. Full phase orchestration can be migrated here step by
    step without changing the public CLI or Web APIs.
    """

    def __init__(self, project: Project, *, logger: logging.Logger | None = None):
        self.project = project
        self.logger = logger or logging.getLogger("metaagent.pipeline_runner")

    def _ensure_synthesis_route(self, protocol):
        from new_meta.core.method_planning import compile_project_method_plan
        from new_meta.core.synthesis_routing import load_synthesis_route

        try:
            return load_synthesis_route(self.project)
        except FileNotFoundError:
            compile_project_method_plan(self.project, protocol)
            return load_synthesis_route(self.project)

    def _ensure_pairwise_route(self, protocol):
        from new_meta.core.synthesis_routing import SynthesisRoute, SynthesisRouteError

        decision = self._ensure_synthesis_route(protocol)
        if decision.route is not SynthesisRoute.PAIRWISE_AGGREGATE:
            raise SynthesisRouteError(decision)
        return decision

    def assess_risk_and_select_primary_effects(
        self,
        *,
        protocol,
        extracted_studies: list,
        parsed_papers: dict,
        included_papers: list,
        required_study_ids: list[str] | None = None,
        rob_agent: Any | None = None,
    ) -> tuple[list, list, list[dict[str, Any]]]:
        """Run result-level RoB before the strict primary-effect selector.

        Entry points must use this contract rather than computing effects in
        parallel with risk-of-bias assessment. The selector deliberately receives
        the completed RoB results and the full-text screening records so its
        provenance and admissibility gates cannot be bypassed.
        """
        if rob_agent is None:
            from new_meta.agents.rob_agent import RoBAgent

            rob_agent = RoBAgent()

        rob_results = rob_agent.run(
            extracted_studies,
            parsed_papers,
            self.project,
            required_study_ids=required_study_ids,
        )
        self.project.save_checkpoint("rob")
        study_effects, selection_audit = self.compute_primary_effect_selection(
            protocol=protocol,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            included_papers=included_papers,
        )
        # Keep the orchestration contract explicit even when the selector is
        # replaced by a test double or a future method-family plugin.
        self.project.save_checkpoint("effect_sizes")
        return rob_results, study_effects, selection_audit

    def run_primary_effect_selection(
        self,
        *,
        protocol,
        extracted_studies: list,
        rob_results: list | None = None,
        included_papers: list | None = None,
    ):
        """Return the strict selector through the public typed execution contract."""
        from new_meta.schemas.phase_result import (
            ArtifactRef,
            ExecutionStatus,
            NextAction,
            PhaseName,
            PhaseIssue,
            PhaseResult,
        )

        route = self._ensure_synthesis_route(protocol)
        from new_meta.core.synthesis_routing import SynthesisRoute

        if route.route is not SynthesisRoute.PAIRWISE_AGGREGATE:
            issue_code = (
                "method_plugin_route_required"
                if route.route is SynthesisRoute.METHOD_PLUGIN
                else "synthesis_route_blocked"
            )
            return PhaseResult(
                run_id=self.project.base_dir.name,
                phase=PhaseName.EFFECT_SELECTION,
                status=ExecutionStatus.BLOCKED,
                summary=(
                    f"Pairwise effect selection is not valid for compiled route "
                    f"{route.route.value}."
                ),
                issues=[
                    PhaseIssue(
                        code=issue_code,
                        message=(
                            "; ".join(route.blocking_reasons)
                            or f"Use the {route.route.value} synthesis route."
                        ),
                        blocking=True,
                        context={"route": route.route.value, "capability_id": route.capability_id},
                    )
                ],
                next_actions=[
                    NextAction(
                        action_id=(
                            "execute_method_plugin"
                            if route.route is SynthesisRoute.METHOD_PLUGIN
                            else "resolve_method_capability"
                        ),
                        title=(
                            "Execute the compiled method plugin"
                            if route.route is SynthesisRoute.METHOD_PLUGIN
                            else "Resolve the blocked method capability"
                        ),
                    )
                ],
                error_code="wrong_synthesis_route",
            )

        effects, selection_audit = self.compute_primary_effect_selection(
            protocol=protocol,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            included_papers=included_papers,
        )
        excluded_rows = sum(
            1 for row in selection_audit if str(row.get("decision") or "") == "excluded"
        )
        return PhaseResult(
            run_id=self.project.base_dir.name,
            phase=PhaseName.EFFECT_SELECTION,
            status=ExecutionStatus.SUCCEEDED,
            summary=f"Selected {len(effects)} admissible primary effect(s).",
            checkpoint="effect_sizes",
            metrics={
                "selected_effects": len(effects),
                "audit_rows": len(selection_audit),
                "excluded_rows": excluded_rows,
            },
            artifacts=[
                ArtifactRef(
                    artifact_id="effect_selection_audit",
                    kind="audit",
                    path=str(self.project.get_path("effect_selection_audit.json", subdir="analysis")),
                    media_type="application/json",
                ),
                ArtifactRef(
                    artifact_id="effect_sizes",
                    kind="dataset",
                    path=str(self.project.get_path("effect_sizes.json", subdir="analysis")),
                    media_type="application/json",
                ),
            ],
            data={
                "effects": effects,
                "selection_audit": selection_audit,
            },
        )

    def run_compiled_method_synthesis(
        self,
        *,
        options: dict[str, Any] | None = None,
        auto_select_ambiguous: bool = False,
    ):
        """Execute the compiled non-pairwise method route from admissible ledger results."""
        from new_meta.core.analysis_set import AnalysisSetAdjudicationRequired
        from new_meta.core.method_executor import (
            MethodExecutionBlocked,
            MethodExecutionNeedsInput,
            MethodExecutor,
        )
        from new_meta.core.synthesis_routing import SynthesisRoute, load_synthesis_route
        from new_meta.schemas.method_policy import MethodPlan, ReviewFamily
        from new_meta.schemas.phase_result import (
            ArtifactRef,
            ExecutionStatus,
            NextAction,
            PhaseIssue,
            PhaseName,
            PhaseResult,
        )
        from new_meta.schemas.synthesis_result import SynthesisResultEnvelope

        route = load_synthesis_route(self.project)
        if route.route is not SynthesisRoute.METHOD_PLUGIN:
            return PhaseResult(
                run_id=self.project.base_dir.name,
                phase=PhaseName.SYNTHESIS,
                status=ExecutionStatus.BLOCKED,
                summary=f"Compiled synthesis route is {route.route.value}, not method_plugin.",
                issues=[
                    PhaseIssue(
                        code="wrong_synthesis_route",
                        message="Method-plugin execution is not valid for this compiled plan.",
                        blocking=True,
                    )
                ],
                next_actions=[
                    NextAction(
                        action_id="use_compiled_synthesis_route",
                        title="Use the compiled synthesis route",
                    )
                ],
                error_code="wrong_synthesis_route",
            )
        plan_payload = self.project.load_json("method_plan.json", subdir="analysis")
        if not plan_payload:
            raise FileNotFoundError("analysis/method_plan.json is required")
        plan = MethodPlan.model_validate(plan_payload)
        executor = MethodExecutor()
        try:
            result_ids = executor.eligible_project_result_ids(
                plan,
                project=self.project,
                auto_select_ambiguous=auto_select_ambiguous,
            )
        except AnalysisSetAdjudicationRequired as exc:
            if plan.family is ReviewFamily.IPD_META and not exc.candidates.candidates:
                return self._ipd_data_required()
            from new_meta.core.analysis_set import analysis_set_option_payload

            choice_payload = analysis_set_option_payload(self.project, exc.candidates)
            return PhaseResult(
                run_id=self.project.base_dir.name,
                phase=PhaseName.SYNTHESIS,
                status=ExecutionStatus.NEEDS_INPUT,
                summary=str(exc),
                issues=[
                    PhaseIssue(
                        code="analysis_set_adjudication_required",
                        message=str(exc),
                        blocking=True,
                        context={
                            "candidate_count": len(exc.candidates.candidates),
                            "candidates_artifact": str(
                                self.project.get_path(
                                    "analysis_set_candidates.json", subdir="analysis"
                                )
                            ),
                        },
                    )
                ],
                next_actions=[
                    NextAction(
                        action_id="adjudicate_analysis_set",
                        title="Select one outcome, timepoint, subgroup, and effect-measure stratum",
                        description=(
                            "Review the versioned candidates and record the clinical rationale "
                            "for the synthesis analysis set."
                        ),
                    )
                ],
                error_code="analysis_set_adjudication_required",
                data=choice_payload,
            )
        except MethodExecutionBlocked as exc:
            return self._method_synthesis_blocked(
                str(exc), code="method_inputs_invalid"
            )
        if not result_ids:
            if plan.family is ReviewFamily.IPD_META:
                return self._ipd_data_required()
            return PhaseResult(
                run_id=self.project.base_dir.name,
                phase=PhaseName.SYNTHESIS,
                status=ExecutionStatus.NEEDS_INPUT,
                summary="No verified or adjudicated typed results are available for synthesis.",
                issues=[
                    PhaseIssue(
                        code="verified_method_inputs_required",
                        message=(
                            "Review source locators and adjudicate the extracted result rows "
                            "before statistical execution."
                        ),
                        blocking=True,
                    )
                ],
                next_actions=[
                    NextAction(
                        action_id="adjudicate_extraction_results",
                        title="Adjudicate extracted result rows",
                    )
                ],
                error_code="verified_method_inputs_required",
            )
        try:
            execution = executor.execute_project(
                plan,
                project=self.project,
                result_ids=result_ids,
                options=options,
                auto_select_ambiguous=auto_select_ambiguous,
            )
        except MethodExecutionNeedsInput as exc:
            return PhaseResult(
                run_id=self.project.base_dir.name,
                phase=PhaseName.SYNTHESIS,
                status=ExecutionStatus.NEEDS_INPUT,
                summary=str(exc),
                issues=[
                    PhaseIssue(
                        code="transitivity_assessment_required",
                        message=str(exc),
                        blocking=True,
                    )
                ],
                next_actions=[
                    NextAction(
                        action_id="assess_transitivity",
                        title="Assess effect-modifier comparability",
                        description=(
                            "Record the prespecified effect modifiers and choose whether to "
                            "confirm transitivity or revise the treatment network."
                        ),
                    )
                ],
                error_code="transitivity_assessment_required",
                data=exc.payload,
            )
        except MethodExecutionBlocked as exc:
            return self._method_synthesis_blocked(str(exc), code="method_execution_blocked")
        envelope = SynthesisResultEnvelope.from_method_execution(execution)
        self.project.save_json("synthesis_result.json", envelope, subdir="analysis")
        self.project.save_checkpoint("meta_analysis")
        return PhaseResult(
            run_id=self.project.base_dir.name,
            phase=PhaseName.SYNTHESIS,
            status=ExecutionStatus.SUCCEEDED,
            summary=(
                f"Executed {envelope.estimator} for {envelope.n_studies} admissible result(s)."
            ),
            checkpoint="meta_analysis",
            metrics={
                "n_studies": envelope.n_studies,
                "input_results": len(envelope.input_result_ids),
                "converged": envelope.execution_converged,
            },
            artifacts=[
                ArtifactRef(
                    artifact_id="method_result",
                    kind="analysis",
                    path=str(self.project.get_path("method_result.json", subdir="analysis")),
                    media_type="application/json",
                ),
                ArtifactRef(
                    artifact_id="synthesis_result",
                    kind="analysis",
                    path=str(self.project.get_path("synthesis_result.json", subdir="analysis")),
                    media_type="application/json",
                ),
            ],
            data={"synthesis": envelope, "method_execution": execution},
        )

    def _ipd_data_required(self):
        from new_meta.schemas.phase_result import (
            ExecutionStatus,
            NextAction,
            PhaseIssue,
            PhaseName,
            PhaseResult,
        )

        return PhaseResult(
            run_id=self.project.base_dir.name,
            phase=PhaseName.SYNTHESIS,
            status=ExecutionStatus.NEEDS_INPUT,
            summary=(
                "No participant-level study datasets are available for the compiled "
                "IPD meta-analysis."
            ),
            issues=[
                PhaseIssue(
                    code="ipd_data_required",
                    message=(
                        "IPD analysis cannot be reconstructed from aggregate article results; "
                        "provide verified participant rows or change the analysis family."
                    ),
                    blocking=True,
                )
            ],
            next_actions=[
                NextAction(
                    action_id="resolve_ipd_data_availability",
                    title="Choose the available data source",
                )
            ],
            error_code="ipd_data_required",
            data={
                "decision_type": "ipd_data_availability",
                "question": (
                    "Are participant-level datasets available for at least three eligible "
                    "parallel randomized studies?"
                ),
                "recommended_option_id": "provide_ipd_dataset",
                "options": [
                    {
                        "option_id": "provide_ipd_dataset",
                        "label": "Provide IPD datasets",
                        "description": (
                            "Import participant rows and continue with the compiled two-stage "
                            "IPD analysis."
                        ),
                    },
                    {
                        "option_id": "switch_to_aggregate_data",
                        "label": "Use aggregate data",
                        "description": (
                            "Recompile the question for an aggregate-data method when "
                            "participant datasets are unavailable."
                        ),
                    },
                ],
            },
        )

    def _method_synthesis_blocked(self, message: str, *, code: str):
        from new_meta.schemas.phase_result import (
            ExecutionStatus,
            NextAction,
            PhaseIssue,
            PhaseName,
            PhaseResult,
        )

        return PhaseResult(
            run_id=self.project.base_dir.name,
            phase=PhaseName.SYNTHESIS,
            status=ExecutionStatus.BLOCKED,
            summary=message,
            issues=[PhaseIssue(code=code, message=message, blocking=True)],
            next_actions=[
                NextAction(
                    action_id="resolve_method_inputs",
                    title="Resolve method input blockers",
                )
            ],
            error_code=code,
        )

    def compute_primary_effect_selection(
        self,
        *,
        protocol,
        extracted_studies: list,
        rob_results: list | None = None,
        included_papers: list | None = None,
    ) -> tuple[list, list[dict[str, Any]]]:
        """Compute and persist primary effect rows with shared safety gates."""
        self._ensure_pairwise_route(protocol)
        from new_meta.core.effect_selection import (
            build_paper_source_lookup,
            build_rob_lookup,
            compute_study_effect,
            dedupe_primary_effect_candidates,
            effect_is_poolable,
            filter_benchmark_reference_primary_candidates,
            primary_candidate_rank,
            primary_candidate_block_reason,
            primary_population_rank,
            rob_for_study,
            source_record_for_study,
        )
        from new_meta.core.evidence_gate import outcome_matches
        from new_meta.engines import meta_engine as _meta_engine
        from new_meta.tools.utils import first_author_lastname as _first_author

        primary_candidates = []
        primary_selection_audit: list[dict[str, Any]] = []
        paper_source_lookup = build_paper_source_lookup(included_papers or [])
        from new_meta.core.result_rob import load_effective_rob_assessments

        effective_rob_results = load_effective_rob_assessments(
            self.project,
            rob_results or [],
        )
        rob_lookup = build_rob_lookup(effective_rob_results)
        benchmark_reference_manifest = load_benchmark_reference_manifest(self.project)
        from new_meta.core.extraction_ledger import result_entity_id

        for study in extracted_studies:
            study_candidates = []
            c = study.characteristics
            study_id = c.pmid or c.study_id or c.doi
            source_record = source_record_for_study(study, paper_source_lookup)
            for outcome_index, outcome in enumerate(study.outcomes):
                if not outcome_matches(outcome.outcome_name, protocol.pico.outcome_primary):
                    continue
                audit_row = {
                    "row_id": f"{study_id}:{outcome_index}",
                    "result_id": result_entity_id(study, outcome_index),
                    "study_id": study_id,
                    "study_label": f"{_first_author(c.authors)} {c.year}",
                    "outcome_index": outcome_index,
                    "outcome_name": outcome.outcome_name,
                    "subgroup": outcome.subgroup,
                    "source_location": outcome.source_location,
                    "source_section": outcome.source_section,
                    "source_page": outcome.source_page,
                    "source_quote": outcome.source_quote,
                    "source_quote_verified": outcome.source_quote_verified,
                    "extraction_confidence": outcome.extraction_confidence,
                    "text_availability": source_record.get("text_availability") or "",
                    "fulltext_source": source_record.get("fulltext_source") or "",
                    "pdf_path": source_record.get("pdf_path") or "",
                    "fulltext_path": source_record.get("fulltext_path") or "",
                    "timepoint": getattr(outcome, "timepoint", None),
                    "accepted_timepoint": getattr(outcome, "accepted_timepoint", None),
                    "timepoint_adjudication": getattr(outcome, "timepoint_adjudication", None),
                    "timepoint_adjudication_note": getattr(outcome, "timepoint_adjudication_note", None),
                    "manual_adjudication": getattr(outcome, "manual_adjudication", None),
                    "user_override_applied": getattr(outcome, "user_override_applied", None),
                    "events_intervention": outcome.events_intervention,
                    "total_intervention": outcome.total_intervention,
                    "events_control": outcome.events_control,
                    "total_control": outcome.total_control,
                    "decision": "candidate",
                    "reason": "",
                    "population_rank": None,
                    "outcome_rank": None,
                    "effect": None,
                    "se": None,
                    "in_final_primary_analysis": False,
                }
                annotate_source_provenance(audit_row)
                population_rank = primary_population_rank(outcome, study, protocol)
                audit_row["population_rank"] = population_rank
                if not population_rank:
                    audit_row["decision"] = "excluded"
                    audit_row["reason"] = "population_mismatch_or_nonprotocol_subgroup"
                    primary_selection_audit.append(audit_row)
                    continue
                effect = compute_study_effect(study, outcome, protocol, self.logger)
                if effect:
                    rob = rob_for_study(study, effect, rob_lookup, outcome=outcome)
                    audit_row["risk_of_bias_judgment"] = getattr(rob, "overall_judgment", "") if rob else ""
                    audit_row["risk_of_bias_is_synthetic"] = bool(getattr(rob, "is_synthetic", False)) if rob else False
                    audit_row["risk_of_bias_result_id"] = getattr(rob, "result_id", "") if rob else ""
                    audit_row["risk_of_bias_scope"] = (
                        "result" if getattr(rob, "is_result_specific", False) else "study_legacy"
                    ) if rob else "missing"
                    block_reason = primary_candidate_block_reason(
                        audit_row,
                        outcome,
                        rob,
                        benchmark_reference_manifest=benchmark_reference_manifest,
                    )
                    if block_reason:
                        audit_row["decision"] = "excluded"
                        audit_row["reason"] = block_reason
                        primary_selection_audit.append(audit_row)
                        continue
                    rank = primary_candidate_rank(outcome, study, protocol)
                    audit_row["outcome_rank"] = list(rank)
                    audit_row["effect"] = _meta_engine._to_original(effect.yi, protocol.effect_measure, effect.vi)
                    audit_row["se"] = effect.se
                    study_candidates.append((rank, study, outcome, effect, audit_row["row_id"]))
                else:
                    audit_row["decision"] = "excluded"
                    audit_row["reason"] = "insufficient_data_to_compute_effect_size"
                primary_selection_audit.append(audit_row)
            if study_candidates:
                study_candidates.sort(key=lambda item: item[0], reverse=True)
                _, selected_study, selected_outcome, selected_effect, selected_row_id = study_candidates[0]
                if len(study_candidates) > 1:
                    selected_ids = {selected_row_id}
                    candidate_ids = {item[4] for item in study_candidates}
                    for row in primary_selection_audit:
                        if row["row_id"] in candidate_ids and row["row_id"] not in selected_ids:
                            row["decision"] = "excluded"
                            row["reason"] = "lower_ranked_duplicate_primary_outcome_row"
                for row in primary_selection_audit:
                    if row["row_id"] == selected_row_id:
                        row["decision"] = "selected_within_study"
                        row["reason"] = "best_ranked_primary_outcome_row_for_study"
                primary_candidates.append((selected_study, selected_outcome, selected_effect, selected_row_id))

        primary_candidates = filter_benchmark_reference_primary_candidates(
            primary_candidates,
            benchmark_reference_manifest,
            primary_selection_audit,
            self.logger,
        )
        study_effects = dedupe_primary_effect_candidates(
            [(study, outcome, effect) for study, outcome, effect, _ in primary_candidates],
            self.logger,
        )
        final_primary_ids = {effect.study_id for effect in study_effects}
        for row in primary_selection_audit:
            if row["decision"] == "selected_within_study":
                row["in_final_primary_analysis"] = row["study_id"] in final_primary_ids
                if not row["in_final_primary_analysis"]:
                    row["decision"] = "excluded"
                    row["reason"] = "deduplicated_before_primary_meta_analysis"
            annotate_source_provenance(row)

        valid_effects = []
        invalid_effect_reasons: dict[str, str] = {}
        for effect in study_effects:
            ok, reason = effect_is_poolable(effect)
            if ok:
                valid_effects.append(effect)
            else:
                invalid_effect_reasons[effect.study_id] = reason
        if invalid_effect_reasons:
            for row in primary_selection_audit:
                if row.get("study_id") in invalid_effect_reasons and row.get("in_final_primary_analysis"):
                    row["decision"] = "excluded"
                    row["reason"] = invalid_effect_reasons[row.get("study_id")]
                    row["in_final_primary_analysis"] = False
        self.project.save_json("effect_selection_audit.json", primary_selection_audit, subdir="analysis")
        self.project.save_json("effect_sizes.json", [item.model_dump() for item in valid_effects], subdir="analysis")
        self.project.save_checkpoint("effect_sizes")
        return valid_effects, primary_selection_audit
