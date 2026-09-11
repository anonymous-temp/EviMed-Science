"""Bind an independent scope assessment to the original request and proposal."""
from __future__ import annotations

import json
from collections import Counter

from new_meta.core.method_planning import ProtocolInputRequired
from new_meta.core.primary_analysis_alignment import (
    _complete_quote_occurs, _normalized_quote, _NUMERIC_TOKEN, _read_scoped, _write_scoped_atomic, digest,
)
from new_meta.schemas.protocol import ProtocolScopeAssessment, ResearchProtocol

ASSESSOR = "independent_protocol_scope_v1"


def scope_fields(protocol):
    """Include every eligibility entry, including empty lists and absent limits."""
    fields = {}
    for name, value in protocol.model_dump(mode="json").items():
        if isinstance(value, dict):
            for key, child in value.items():
                fields[f"{name}.{key}"] = child
                if isinstance(child, list):
                    fields.update({f"{name}.{key}[{i}]": item for i, item in enumerate(child)})
        else:
            fields[name] = value
            if isinstance(value, list):
                fields.update({f"{name}[{i}]": item for i, item in enumerate(value)})
    return fields


def protocol_hash(protocol):
    return digest(ResearchProtocol.model_validate(protocol.model_dump()).model_dump(mode="json"))


class ScopeAssessmentValidationError(ValueError):
    """A deterministic checker error with safe, machine-readable feedback."""

    def __init__(self, message, code, *, field=None):
        super().__init__(message)
        self.reason = {"code": code, "message": message}
        if field is not None:
            self.reason["field"] = field


def _validate_scope_fields(topic, assessment, expected_fields):
    """Validate one internal batch with the same quote rules as a full receipt."""
    assessment = ProtocolScopeAssessment.model_validate(assessment)
    required = set(expected_fields)
    names = [item.field for item in assessment.fields]
    if len(names) != len(set(names)) or set(names) != required:
        raise ScopeAssessmentValidationError(
            "Scope assessment must cover every proposal field exactly once within the requested inventory",
            "scope_field_coverage_invalid")
    source = _normalized_quote(topic)
    spans = [match.span() for match in _NUMERIC_TOKEN.finditer(source)]
    starts = [start for start, _ in spans]
    for item in assessment.fields:
        quote = _normalized_quote(item.original_quote)
        if item.basis == "not_explicit" and quote != source:
            raise ScopeAssessmentValidationError(
                f"Absent constraints require the full original question as context for {item.field}",
                "scope_absence_context_incomplete", field=item.field)
        if not quote or not item.rationale.strip() or not _complete_quote_occurs(source, quote, spans, starts, continuous_scripts=True):
            raise ScopeAssessmentValidationError(
                f"Scope assessment lacks an intact original-request anchor/rationale for {item.field}",
                "scope_anchor_or_rationale_invalid", field=item.field)
    return assessment


def validate_scope_assessment(topic, protocol, assessment):
    """Always require the entire proposal; a batch can never become a receipt."""
    return _validate_scope_fields(topic, assessment, scope_fields(protocol))


def _validated_scope_conflicts(topic, assessment, expected_fields):
    """Keep only unambiguous, independently anchored non-match field judgments."""
    counts = Counter(item.field for item in assessment.fields)
    conflicts = {}
    for item in assessment.fields:
        if item.status == "match" or item.field not in expected_fields or counts[item.field] != 1:
            continue
        try:
            _validate_scope_fields(topic, ProtocolScopeAssessment(fields=[item]), [item.field])
        except (ValueError, TypeError):
            continue
        conflicts[item.field] = item.model_copy(deep=True)
    return conflicts


def scope_receipt(topic, protocol, assessment):
    assessment = validate_scope_assessment(topic, protocol, assessment)
    conflicts = [item.model_dump() for item in assessment.fields if item.status != "match"]
    if conflicts:
        raise ProtocolInputRequired("The proposed protocol does not demonstrably preserve the original research question.",
            code="protocol_scope_input_required", protocol=protocol, context={"scope_findings": conflicts})
    return {"schema_version": 1, "assessor": ASSESSOR, "topic_sha256": digest(topic),
            "protocol_sha256": protocol_hash(protocol), "assessment": assessment.model_dump(mode="json")}


def original_project_topic(project):
    try:
        record = json.loads(_read_scoped(project, project.TOPIC_FILE, max_bytes=1024 * 1024))
        topic = record["topic"]
        if not isinstance(topic, str) or not topic.strip():
            raise ValueError("missing original topic")
        return topic
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ProtocolInputRequired("The original project question is missing or unreadable; restart from the original research question.",
                                    code="protocol_scope_original_missing", project=project) from exc


def ensure_project_protocol_scope(project, protocol, *, planner=None, allow_recheck=True):
    """Use only a current runtime assessment; stale or legacy proposals are rechecked."""
    topic = original_project_topic(project)
    candidates = [protocol._scope_receipt]
    try:
        candidates.append(json.loads(_read_scoped(project, "analysis/protocol_scope.json", max_bytes=4 * 1024 * 1024)))
    except (OSError, ValueError):
        pass
    for receipt in candidates:
        if not isinstance(receipt, dict) or receipt.get("assessor") != ASSESSOR:
            continue
        if receipt.get("topic_sha256") != digest(topic) or receipt.get("protocol_sha256") != protocol_hash(protocol):
            continue
        try:
            validated = scope_receipt(topic, protocol, receipt["assessment"])
        except (ValueError, KeyError, TypeError):
            continue
        _write_scoped_atomic(project, "analysis/protocol_scope.json", json.dumps(validated, ensure_ascii=False, indent=2).encode())
        return validated
    if not allow_recheck:
        raise ProtocolInputRequired("The current protocol lacks a matching independent original-question scope assessment; resume planning or restart before refreshing the report.",
                                    code="protocol_scope_unverified", protocol=protocol, project=project)
    if planner is None:
        from new_meta.agents.research_planner import ResearchPlanner
        planner = ResearchPlanner()
    try:
        receipt = planner.check_scope(topic, protocol)
    except ProtocolInputRequired as exc:
        raise exc.persist(project)
    if original_project_topic(project) != topic:
        raise ProtocolInputRequired("Original question changed during scope assessment; restart with the intended question.",
                                    code="protocol_scope_original_changed", protocol=protocol, project=project)
    _write_scoped_atomic(project, "analysis/protocol_scope.json", json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    protocol._scope_receipt = receipt
    return receipt
