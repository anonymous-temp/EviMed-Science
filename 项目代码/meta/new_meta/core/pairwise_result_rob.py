"""Bind pairwise result-specific RoB to the selected source-backed synthesis."""
from __future__ import annotations

import json

from new_meta.agents.rob_agent import RoBAgent
from new_meta.core.artifact_package import _build_risk_of_bias_completeness_review
from new_meta.core.extraction_ledger import result_entity_id
from new_meta.core.llm import parse_source_json
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.rob_policy import resolve_rob_policy
from new_meta.core.primary_analysis_alignment import (
    PrimaryAlignmentRequired, _read_scoped, _write_scoped_atomic, alignment_status,
    digest, needs_input_phase, protocol_fingerprint, require_current_cached_alignment,
    save_pool_binding,
)
from new_meta.schemas.risk_of_bias import ResultRoBAssessment, RoBAssessmentStatus
from new_meta.schemas.study import ExtractedStudy


RECEIPT_PATH = "risk_of_bias/pairwise_result_rob_receipt.json"
_COMPLETE = {RoBAssessmentStatus.COMPLETE, RoBAssessmentStatus.ADJUDICATED}
_MISSING = object()


def _block(project, reason, rows=()):
    pending = [{**row, "decision": "needs_input", "reason": reason,
                "in_final_primary_analysis": False, "requires_adjudication": True}
               for row in rows]
    phase = needs_input_phase(project, pending, reason=reason)
    phase.summary = "Primary synthesis requires current source-bound, complete risk-of-bias assessments for every selected result."
    raise PrimaryAlignmentRequired(phase)


def _read_json(project, path, *, optional=False, missing=None):
    try:
        return parse_source_json(_read_scoped(project, path, max_bytes=16 * 1024 * 1024).decode())
    except FileNotFoundError:
        if optional:
            return missing
        raise


def _records(project):
    raw = _read_json(project, "risk_of_bias/rob_result_assessments.json", optional=True, missing=_MISSING)
    if raw is _MISSING:
        return []
    if not isinstance(raw, list):
        raise ValueError("Result-level RoB records must be a list")
    records = [ResultRoBAssessment.model_validate(item) for item in raw]
    if len({record.result_id for record in records}) != len(records):
        raise ValueError("Duplicate result-level RoB records")
    return records


def require_study_rob_refresh_safe(project):
    """Stop a study-level refresh before it can replace completed result history."""
    try:
        records = _records(project)
        receipt = _read_json(project, RECEIPT_PATH, optional=True, missing=_MISSING)
    except (OSError, ValueError, TypeError, AttributeError):
        _block(project, "study_rob_history_requires_review")
    if receipt is not _MISSING or any(item.assessment_status in _COMPLETE for item in records):
        _block(project, "study_rob_refresh_would_replace_result_history")


def _selected_state(project, protocol, studies, meta_results, *, require_binding=True):
    if require_binding:
        require_current_cached_alignment(project, protocol=protocol, meta_results=meta_results)
    stored = _read_json(project, "extraction/all_extractions.json")
    stored_studies = [ExtractedStudy.model_validate(item) for item in stored]
    if digest([item.model_dump(mode="json") for item in studies]) != digest(
        [item.model_dump(mode="json") for item in stored_studies]
    ):
        raise ValueError("Caller extraction differs from the current checkpoint")
    # Derived legacy diagnostics can contain NaN for unavailable tests. Preserve
    # the existing pool loader/serialization semantics here only; source inputs,
    # RoB observations and receipts still use strict source JSON parsing.
    stored_meta = json.loads(_read_scoped(project, "analysis/meta_results.json"))
    if digest(stored_meta) != digest(meta_results.model_dump(mode="json")):
        raise ValueError("Caller pooled result differs from the stored result")
    selection = _read_json(project, "analysis/primary_alignment_selection.json")
    audit = _read_json(project, "analysis/effect_selection_audit.json")
    selected = [row for row in audit if row.get("in_final_primary_analysis") is True]
    row_ids = [row["row_id"] for row in selected]
    required = [row["result_id"] for row in selected]
    study_ids = [row["study_id"] for row in selected]
    pooled_ids = [item.study_id for item in meta_results.primary_outcome.studies]
    if (not required or any(not isinstance(value, str) or not value for value in required)
            or len(set(required)) != len(required) or len(set(row_ids)) != len(row_ids)
            or len(set(study_ids)) != len(study_ids) or len(set(pooled_ids)) != len(pooled_ids)
            or set(study_ids) != set(pooled_ids) or set(row_ids) != set(selection["selected_row_ids"])
            or len(pooled_ids) != meta_results.primary_outcome.n_studies):
        raise ValueError("Selected results do not uniquely cover pooled contributors")
    effects = _read_json(project, "analysis/effect_sizes.json")
    effect_map = {item["study_id"]: item for item in effects}
    if (len(effect_map) != len(effects) or set(effect_map) != set(pooled_ids)
            or meta_results.primary_outcome.effect_measure != protocol.effect_measure):
        raise ValueError("Pooled effect inputs do not match selected effects")
    for item in meta_results.primary_outcome.studies:
        # Pooling may change display weights, but never the source-derived effect,
        # variance, standard error or subgroup defining a contributor.
        if any(getattr(item, key) != effect_map[item.study_id].get(key)
               for key in ("yi", "vi", "se", "subgroup")):
            raise ValueError("A pooled contributor differs from the selected effect")
    inputs = {key: value for key, value in selection.items() if key != "selection_gate_sha256"}
    sources, parsed = [], {}
    by_result = {result_entity_id(study, index): (study, index)
                 for study in studies for index in range(len(study.outcomes))}
    for row in selected:
        study, index = by_result[row["result_id"]]
        if row["row_id"] != f"{study.characteristics.pmid or study.characteristics.study_id}:{index}":
            raise ValueError("Selected row identity does not match its result")
        status = alignment_status(project, protocol, study, index)
        if status["status"] != "match" or status["proof_id"] != row["alignment"]["proof_id"]:
            raise ValueError("Selected result no longer has its admitted source proof")
        proof = study.outcomes[index].primary_analysis_alignment
        checked = _read_scoped(project, proof.checked_source_path).decode()
        sources.append({"result_id": row["result_id"], "proof_id": proof.proof_id,
                        "source_sha256": proof.source_sha256, "checked_source_sha256": proof.checked_source_sha256})
        parsed[row["study_id"]] = {"full_text": checked, "_source_sha256": proof.source_sha256}
    state = {
        "protocol_sha256": protocol_fingerprint(protocol),
        "extractions_sha256": digest([item.model_dump(mode="json") for item in studies]),
        "selection_inputs": inputs, "selected_result_ids": required,
        "sources": sources, "meta_sha256": digest(meta_results.model_dump(mode="json")),
        "method_plan_sha256": digest(_read_json(project, "analysis/method_plan.json")),
        "study_rob_sha256": digest(_read_json(project, "risk_of_bias/rob_results.json", optional=True)),
        "adjudications_sha256": digest(_read_json(project, "risk_of_bias/rob_adjudications.json", optional=True)),
    }
    return state, selected, parsed


def _receipt_state(project, source_state):
    observations = RoBAgent._load_result_rob_observations(project)
    selected_studies = {row_id.rsplit(":", 1)[0]
                        for row_id in source_state["selection_inputs"]["selected_row_ids"]}
    if any(item["study_id"] in selected_studies and item["status"] in {"pending", "incomplete"}
           for item in observations):
        raise ValueError("Selected source-grounded RoB observations remain pending")
    return {"schema_version": 1, "scope": "pairwise_selected_results", "inputs": source_state,
            "result_rob_sha256": digest(_read_json(project, "risk_of_bias/rob_result_assessments.json", optional=True)),
            "observations_sha256": digest(observations),
            "selection_sha256": digest(_read_json(project, "analysis/primary_alignment_selection.json")),
            "pool_sha256": digest(_read_json(project, "analysis/primary_alignment_pool.json"))}


def _formal_selected(project, records, required, studies, parsed):
    by_id = {record.result_id: record for record in records}
    if any(rid not in by_id for rid in required):
        raise ValueError("A selected result has no risk-of-bias record")
    selected = [by_id[rid] for rid in required]
    if any(item.assessment_status not in _COMPLETE or item.requires_adjudication or item.is_synthetic for item in selected):
        raise ValueError("Selected result-level RoB is pending or synthetic")
    targets = {result_entity_id(study, index): (study, outcome)
               for study in studies for index, outcome in enumerate(study.outcomes)}
    plan = _read_json(project, "analysis/method_plan.json")
    for item in selected:
        study, outcome = targets[item.result_id]
        study_id = study.characteristics.pmid or study.characteristics.study_id
        policy = resolve_rob_policy(family=plan["family"], study_design=study.characteristics.study_design)
        if (item.study_id != study_id or item.outcome_name != (outcome.outcome_name or "Outcome")
                or item.timepoint != str(outcome.accepted_timepoint or outcome.timepoint or "")
                or item.subgroup != str(outcome.subgroup or "")
                or item.tool_used != policy.tool_name or item.tool_version != policy.tool_version
                or item.target_effect != policy.target_effect
                or sorted(domain.domain for domain in item.domains) != sorted(policy.domain_names)
                or RoBAgent._grounded_study_rob(item, parsed[study_id]["full_text"]) is None):
            raise ValueError("Result-level RoB does not match its exact source-grounded target and tool domains")
        if item.assessment_status is RoBAssessmentStatus.ADJUDICATED and not RoBAgent._has_recorded_result_rob_adjudication(project, item):
            raise ValueError("Result-level RoB adjudication lacks its recorded decision")
    review = _build_risk_of_bias_completeness_review(project)
    if (not review or review.get("passed") is not True or review.get("schema_version") != 2
            or {item["result_id"] for item in review.get("results", [])} != set(required)):
        raise ValueError("The selected risk-of-bias completeness review did not pass")
    return selected


def ensure_pairwise_result_rob(
    project, *, protocol, meta_results, extracted_studies, study_assessments,
    agent_factory=None, allow_completion=True,
):
    """Complete fresh drafts, or reuse only a source-bound completed receipt.

    Old completed/adjudicated records without a matching receipt are preserved and
    require review. They are never deleted or relabelled to force a new model run.
    """
    selected = []
    try:
        before, selected, parsed = _selected_state(project, protocol, extracted_studies, meta_results)
        records = _records(project)
        expected = _receipt_state(project, before)
        saved = _read_json(project, RECEIPT_PATH, optional=True, missing=_MISSING)
        if saved is not _MISSING:
            if saved != expected:
                _block(project, "pairwise_result_rob_receipt_stale", selected)
            return _formal_selected(project, records, before["selected_result_ids"], extracted_studies, parsed)
        required = before["selected_result_ids"]
        if not allow_completion or any(item.result_id in required and item.assessment_status in _COMPLETE for item in records):
            _block(project, "pairwise_result_rob_receipt_required", selected)
        agent = agent_factory() if agent_factory else RoBAgent()
        agent.complete_result_level_assessments(
            project=project, extracted_studies=extracted_studies, parsed_papers=parsed,
            # Anchored study-level quotes do not establish the target outcome's
            # bias judgment. Preserve legacy records, but require this exact
            # result's assessment or retained target-bound observations.
            study_assessments=[], required_result_ids=required,
        )
        completed = _formal_selected(project, _records(project), required, extracted_studies, parsed)
        # RoB changes the selection gate. Re-run its actual policies instead of
        # rewriting the gate hash on an old selection or pooled effect dataset.
        phase = PipelineRunner(project).run_primary_effect_selection(
            protocol=protocol, extracted_studies=extracted_studies, rob_results=study_assessments,
        )
        if phase.status.value != "succeeded":
            _block(project, "pairwise_result_rob_selection_changed", selected)
        after, new_selected, _ = _selected_state(project, protocol, extracted_studies, meta_results, require_binding=False)
        if before != after or digest([item.model_dump(mode="json") for item in phase.data["effects"]]) != before["selection_inputs"]["effects_sha256"]:
            _block(project, "pairwise_result_rob_selection_changed", new_selected)
        save_pool_binding(project, meta_results)
        require_current_cached_alignment(project, protocol=protocol, meta_results=meta_results)
        receipt = _receipt_state(project, after)
        _write_scoped_atomic(project, RECEIPT_PATH, json.dumps(receipt, sort_keys=True, indent=2).encode())
        return completed
    except PrimaryAlignmentRequired:
        raise
    except Exception:
        # Preserve partial records/High observations; an interrupted assessment is
        # a visible input requirement, not an exception swallowed by GRADE.
        _block(project, "pairwise_result_rob_incomplete", selected)


def validated_pairwise_result_rob(project, *, protocol, meta_results, extracted_studies):
    """Read the effective selected records without permission to run a model."""
    return ensure_pairwise_result_rob(
        project, protocol=protocol, meta_results=meta_results, extracted_studies=extracted_studies,
        study_assessments=[], allow_completion=False,
    )
