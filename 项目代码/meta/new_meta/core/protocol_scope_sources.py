"""Resolve immutable original-question references through the unchanged quote gate."""
from collections import Counter
from dataclasses import dataclass
import re

from pydantic import BaseModel, ValidationError

from new_meta.core.llm import parse_source_json
from new_meta.core.primary_analysis_alignment import digest
from new_meta.core.protocol_scope import (
    ScopeAssessmentValidationError, _validate_scope_fields, _validated_scope_conflicts,
    protocol_hash, scope_fields,
)
from new_meta.schemas.protocol import (
    ProtocolScopeAssessment, ProtocolScopeField, ProtocolScopeReferenceField,
)

SOURCE_ASSESSOR = "independent_protocol_scope_sources_v1"
SOURCE_VERSION = 1
SCOPE_BATCH_SIZE = 8
_NEWLINE = r"(?:\r\n|\r(?!\n)|(?<!\r)\n)"
_PARAGRAPH_BREAK = re.compile(rf"{_NEWLINE}[^\S\r\n]*{_NEWLINE}(?:[^\S\r\n]*{_NEWLINE})*")


def source_catalogue(topic, protocol):
    """Use raw Python string offsets, never normalized or reconstructed paragraphs."""
    catalogue = {"version": SOURCE_VERSION, "offset_unit": "unicode_codepoints",
                 "topic_sha256": digest(topic), "protocol_sha256": protocol_hash(protocol)}
    identity = dict(catalogue)
    ranges = [("question", 0, len(topic))]
    start = 0
    for separator in _PARAGRAPH_BREAK.finditer(topic):
        if topic[start:separator.start()].strip():
            ranges.append(("paragraph", start, separator.start()))
        start = separator.end()
    if topic[start:].strip():
        ranges.append(("paragraph", start, len(topic)))
    catalogue["sources"] = []
    for kind, start, end in ranges:
        source = {"kind": kind, "start": start, "end": end,
                  "text_sha256": digest(topic[start:end])}
        source["source_id"] = "src_" + digest({**identity, **source})
        catalogue["sources"].append(source)
    return catalogue


def source_prompt_catalogue(topic, catalogue):
    return [{**source, "text": topic[source["start"]:source["end"]]}
            for source in catalogue["sources"]]


@dataclass
class ScopeReferenceEvaluation:
    resolved: ProtocolScopeAssessment
    conflicts: dict[str, ProtocolScopeField]
    reason: dict | None
    source_metadata: list[dict]


def evaluate_scope_references(topic, catalogue, response, expected_fields):
    """Retain raw duplicate counts even when some references cannot be resolved."""
    if isinstance(response, BaseModel):
        response = response.model_dump(mode="json")
    if catalogue["topic_sha256"] != digest(topic):
        return ScopeReferenceEvaluation(ProtocolScopeAssessment(fields=[]), {}, {
            "code": "scope_source_catalogue_mismatch",
            "message": "The source catalogue does not belong to the original question."}, [])
    if not isinstance(response, dict) or not isinstance(response.get("fields"), list):
        return ScopeReferenceEvaluation(ProtocolScopeAssessment(fields=[]), {}, {
            "code": "scope_assessment_malformed",
            "message": "Return an object containing only fields as an array of field assessments."}, [])
    rows = response["fields"]
    counts = Counter(row["field"] for row in rows if isinstance(row, dict) and isinstance(row.get("field"), str))
    reason = None
    if set(response) != {"fields"}:
        reason = {"code": "scope_assessment_malformed", "message": "The assessment envelope may contain only fields."}
    if set(counts) != set(expected_fields) or any(count != 1 for count in counts.values()):
        reason = {"code": "scope_field_coverage_invalid",
                  "message": "Scope assessment must cover every requested field exactly once."}
    sources = {source["source_id"]: source for source in catalogue["sources"]}
    resolved = []
    used_sources = {}
    for row in rows:
        try:
            item = ProtocolScopeReferenceField.model_validate(row)
        except ValidationError:
            reason = reason or {"code": "scope_field_malformed",
                                "message": "Each row must contain exactly field, status, basis, source_id and rationale with their required types."}
            continue
        source = sources.get(item.source_id)
        if source is None:
            reason = reason or {"code": "scope_source_id_unknown",
                                "message": "Select a source_id from this exact question and proposal catalogue."}
            continue
        if item.basis == "not_explicit" and source["kind"] != "question":
            reason = reason or {"code": "scope_absence_source_not_whole",
                                "message": "Absent constraints require the whole-question source_id."}
            continue
        used_sources[item.source_id] = dict(source)
        resolved.append(ProtocolScopeField(
            field=item.field, status=item.status, basis=item.basis,
            original_quote=topic[source["start"]:source["end"]], rationale=item.rationale))
    assessment = ProtocolScopeAssessment(fields=resolved)
    if reason is None:
        try:
            _validate_scope_fields(topic, assessment, expected_fields)
        except ScopeAssessmentValidationError as exc:
            reason = exc.reason
    eligible = ProtocolScopeAssessment(fields=[item for item in resolved if counts[item.field] == 1])
    conflicts = _validated_scope_conflicts(topic, eligible, expected_fields)
    return ScopeReferenceEvaluation(assessment, conflicts, reason, list(used_sources.values()))


def compose_scope_batch(topic, resolved, retained, expected_fields, batch, attempt,
                        provider_response_ordinal=1, retained_origins=None):
    """Compose original typed judgments without relabelling them as a retry return."""
    by_field = {item.field: item for item in resolved.fields}
    composed = ProtocolScopeAssessment(fields=[retained.get(field, by_field[field]) for field in expected_fields])
    _validate_scope_fields(topic, composed, expected_fields)
    origins = {field: ((retained_origins or {}).get(field) or {
        "batch": batch, "attempt": 1 if field in retained else attempt,
        "provider_response_ordinal": provider_response_ordinal})
               for field in expected_fields}
    return composed, origins


def scope_source_provenance(catalogue, responses, field_origins):
    """Successful provenance is complete; bounded diagnostics are never its source."""
    return {"version": SOURCE_VERSION, "catalogue": catalogue,
            "catalogue_sha256": digest(catalogue), "responses": responses,
            "field_origins": field_origins}


def replay_scope_sources(topic, protocol, provenance):
    """Rebuild source resolution and conflict composition from actual typed responses."""
    catalogue = source_catalogue(topic, protocol)
    if (not isinstance(provenance, dict) or type(provenance.get("version")) is not int
            or provenance.get("version") != SOURCE_VERSION
            or digest(provenance.get("catalogue")) != digest(catalogue)
            or provenance.get("catalogue_sha256") != digest(catalogue)):
        raise ValueError("Scope source catalogue does not match the exact current inputs")
    responses = provenance.get("responses")
    if not isinstance(responses, list):
        raise ValueError("Scope source provenance requires actual response records")
    fields = list(scope_fields(protocol))
    position = 0
    merged = []
    origins = {}
    for offset in range(0, len(fields), SCOPE_BATCH_SIZE):
        expected = fields[offset:offset + SCOPE_BATCH_SIZE]
        batch = offset // SCOPE_BATCH_SIZE + 1
        retained = {}
        retained_origins = {}
        for attempt in (1, 2):
            if position >= len(responses):
                raise ValueError("Scope source provenance omits a required response")
            ordinal = 0
            while position < len(responses):
                candidate = responses[position]
                if (not isinstance(candidate, dict) or type(candidate.get("batch")) is not int
                        or type(candidate.get("attempt")) is not int or candidate["batch"] != batch
                        or candidate["attempt"] != attempt):
                    if ordinal:
                        break
                    raise ValueError("Scope source response identity is invalid")
                record = candidate
                ordinal += 1
                position += 1
                if (type(record.get("provider_response_ordinal")) is not int
                        or record["provider_response_ordinal"] != ordinal
                        or "raw_content" not in record
                        or (record["raw_content"] is not None and not isinstance(record["raw_content"], str))
                        or record.get("raw_sha256") != digest(record["raw_content"])):
                    raise ValueError("Scope source provider observation is missing or altered")
                content = record["raw_content"]
                if content is None or not content.strip():
                    missing = "missing_content" if content is None else "empty_content"
                    if (record.get("response_unavailable") != missing or "response" in record
                            or "response_sha256" in record):
                        raise ValueError("Missing provider text cannot be represented as a model JSON response")
                    evaluated = None
                    continue
                if "response_unavailable" in record:
                    raise ValueError("An actual model response cannot be marked unavailable")
                payload = parse_source_json(record["raw_content"])
                if ("response" not in record or record.get("response_sha256") != digest(payload)
                        or digest(record["response"]) != digest(payload)):
                    raise ValueError("Scope source envelope differs from the actual provider response")
                evaluated = evaluate_scope_references(topic, catalogue, payload, expected)
                origin = {"batch": batch, "attempt": attempt, "provider_response_ordinal": ordinal}
                for field, judgment in evaluated.conflicts.items():
                    if field not in retained:
                        retained[field] = judgment
                        retained_origins[field] = origin
                if (position < len(responses) and isinstance(responses[position], dict)
                        and responses[position].get("batch") == batch and responses[position].get("attempt") == attempt
                        and record.get("finish_reason") not in {"length", "incomplete", "failed", "cancelled"}):
                    raise ValueError("Scope provenance invents another response after a completed provider call")
            if evaluated is None:
                raise ValueError("Scope source provenance ends with missing provider content")
            if evaluated.reason is not None or record.get("finish_reason") not in {"stop", "completed"}:
                if attempt == 2:
                    raise ValueError("Scope source provenance ends with an invalid response")
                continue
            composed, batch_origins = compose_scope_batch(
                topic, evaluated.resolved, retained, expected, batch, attempt, ordinal, retained_origins)
            merged.extend(composed.fields)
            origins.update(batch_origins)
            break
    if position != len(responses) or digest(provenance.get("field_origins")) != digest(origins):
        raise ValueError("Scope source provenance has extra responses or incomplete field origins")
    return ProtocolScopeAssessment(fields=merged)


def validate_scope_source_provenance(topic, protocol, assessment, provenance):
    replayed = replay_scope_sources(topic, protocol, provenance)
    if replayed.model_dump(mode="json") != ProtocolScopeAssessment.model_validate(assessment).model_dump(mode="json"):
        raise ValueError("Scope source provenance does not reproduce the exact stored assessment")
    return provenance
