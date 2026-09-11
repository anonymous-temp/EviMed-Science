"""Deterministic validation of independent, source-bound extraction judgments."""
from __future__ import annotations

from collections import Counter
import math
import re
from typing import Any, Literal, TypedDict

from new_meta.schemas.study import ExtractedStudy, OutcomeData, PrimaryAlignmentAssessment
from new_meta.schemas.protocol import ResearchProtocol


class VerificationVerdict(TypedDict):
    status: Literal["match", "mismatch", "unknown"]
    reason: str


VerificationIssue = dict[str, Any]

# Derive coverage from the typed outcome schema so newly added statistical inputs
# cannot bypass verification. Page numbers and override revisions are runtime metadata.
_PROPERTIES = OutcomeData.model_json_schema()["properties"]

def _numeric_schema(schema: dict[str, Any]) -> bool:
    return schema.get("type") in {"number", "integer"} or any(
        item.get("type") in {"number", "integer"} for item in schema.get("anyOf", []))


NUMERIC_FIELDS = tuple(name for name, schema in _PROPERTIES.items()
                       if name not in {"source_page", "override_revision"} and _numeric_schema(schema))
NUMERIC_MAP_FIELDS = tuple(name for name, schema in _PROPERTIES.items()
                           if schema.get("type") == "object" and _numeric_schema(schema.get("additionalProperties", {})))


def numeric_fields(outcome: OutcomeData) -> dict[str, int | float]:
    values = {name: getattr(outcome, name) for name in NUMERIC_FIELDS
              if getattr(outcome, name, None) is not None}
    for name in NUMERIC_MAP_FIELDS:
        values.update({f"{name}[{key}]": value for key, value in sorted(getattr(outcome, name, {}).items())})
    return values


def numeric_conflicts(outcome: OutcomeData) -> list[dict[str, Any]]:
    """Preserved statistical/source contradictions require explicit adjudication."""
    fields = set(NUMERIC_FIELDS) | set(NUMERIC_MAP_FIELDS)
    result = []
    for index, conflict in enumerate(outcome.conflicts):
        tokens = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", conflict.field))
        observed_numbers = any(isinstance(value, (int, float)) and not isinstance(value, bool)
                               for value in conflict.observed_values.values())
        if tokens & fields or (observed_numbers and conflict.field not in {"source_page", "override_revision"}):
            result.append({"conflict_index": index, **conflict.model_dump(mode="json")})
    return result


def quote_is_anchored(quote: str, location: str, source_text: str) -> bool:
    from new_meta.core.primary_analysis_alignment import _complete_quote_occurs, _normalized_quote, _NUMERIC_TOKEN
    source, quoted = _normalized_quote(source_text), _normalized_quote(quote)
    spans = [match.span() for match in _NUMERIC_TOKEN.finditer(source)]
    return bool(quoted and str(location).strip() and _complete_quote_occurs(
        source, quoted, spans, [start for start, _ in spans], continuous_scripts=True))


def numeric_value_in_quote(value: float | int | None, quote: str, field: str = "") -> bool:
    """Check reported decimal/power literals, retaining signs and numeric spans.

    Compound fractions, multiplication and plus/minus expressions require explicit
    source values; they are not split into misleading numerator/denominator values.
    Interval endpoints are supported, including the common PDF en-dash form.
    """
    from new_meta.core.primary_analysis_alignment import _normalized_quote, _NUMBER_ATOM, _NUMERIC_TOKEN
    if value is None or not math.isfinite(float(value)):
        return False
    text = _normalized_quote(quote)
    event_field = field.startswith("events") or field in {"true_positive", "false_negative", "false_positive", "true_negative", "prediction_events"}
    total_field = field.startswith("total") or field in {"n_intervention", "n_control", "correlation_n", "prediction_sample_size"}
    addition_spans = [match.span() for match in re.finditer(_NUMBER_ATOM + r"\s*\+\s*" + _NUMBER_ATOM, text)]
    labelled_mean_sd = bool(re.search(r"(?:mean|均值)\s*(?:±|\+/-)\s*(?:sd|standard deviations?|标准差)\b", text))
    for compound in _NUMERIC_TOKEN.finditer(text):
        token = compound.group()
        if any(start <= compound.start() and compound.end() <= end for start, end in addition_spans):
            continue
        mean_sd = re.fullmatch(r"([+\-−]?\d+(?:\.\d+)?)\s*(?:±|\+/-)\s*(\d+(?:\.\d+)?)", token)
        if mean_sd and labelled_mean_sd and (field.startswith("mean_") or field.startswith("sd_")):
            reported = float(mean_sd.group(1 if field.startswith("mean_") else 2).replace("−", "-"))
            if math.isclose(float(value), reported, rel_tol=1e-10, abs_tol=1e-12):
                return True
            continue
        if "*" in token.replace("**", ""):
            continue
        count_pair = re.fullmatch(r"(\d+)\s*[/⁄∕]\s*(\d+)", token)
        if count_pair and (event_field or total_field):
            reported = int(count_pair.group(1 if event_field else 2))
            if reported == value:
                return True
            continue
        if re.search(r"[/⁄∕×·±]|\+/-", token):
            continue
        for number in re.finditer(_NUMBER_ATOM, token):
            raw = number.group().strip()
            if re.match(r"[<>≤≥≠≈≃≅~]", raw):
                continue
            if number.start() and token[number.start() - 1].isdigit() and raw.startswith("-"):
                raw = raw[1:]  # The separator in an unsigned interval, not a unary sign.
            raw = raw.replace("−", "-").replace(" ", "")
            if any(mark in raw for mark in ("%", "‰", "′", "″", "‴", "⁗")):
                continue
            try:
                if "^" in raw or "**" in raw:
                    base, power = re.split(r"\^|\*\*", raw)
                    parsed = float(base) ** int(power)
                else:
                    if "," in raw and not re.fullmatch(r"[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?", raw):
                        # Comma-separated decimal interval endpoints, not a decimal-comma guess.
                        parts = raw.split(",")
                        if all(re.fullmatch(r"[+-]?\d+\.\d+", part) for part in parts):
                            if any(math.isclose(float(value), float(part), rel_tol=1e-10, abs_tol=1e-12) for part in parts):
                                return True
                        continue
                    parsed = float(raw.replace(",", ""))
                if math.isfinite(parsed) and math.isclose(float(value), parsed, rel_tol=1e-10, abs_tol=1e-12):
                    return True
            except (ValueError, OverflowError):
                continue
    return False


def verification_verdict(assessment: PrimaryAlignmentAssessment, protocol: ResearchProtocol) -> VerificationVerdict:
    details = assessment.verification
    unknown = {"status": "unknown", "reason": "extraction_verification_required"}
    if details is None:
        return unknown
    if details.endpoint_relation in {"source_broader", "source_narrower", "different"} or any(
            component.relation in {"extra", "missing"} for component in details.components):
        return {"status": "mismatch", "reason": "endpoint_components_incompatible"}
    if details.estimand_relation == "mismatch":
        return {"status": "mismatch", "reason": "source_estimand_incompatible"}
    from new_meta.core.method_planning import infer_review_family
    from new_meta.schemas.method_policy import ReviewFamily
    rct = infer_review_family(protocol) is ReviewFamily.INTERVENTION_RCT
    if rct:
        if (details.postrandomization_conditioning is True or details.selection_timing == "postrandomization"
                or any(item.timing == "postrandomization" for item in details.conditioning_variables)
                or details.randomized_comparison is False):
            return {"status": "mismatch", "reason": "randomized_total_effect_required"}
        if (details.randomized_comparison is not True or details.postrandomization_conditioning is not False
                or details.selection_timing not in {"baseline", "not_applicable"}
                or any(item.timing == "uncertain" for item in details.conditioning_variables)):
            return unknown
    if (details.numeric_status != "verified" or any(item.status != "match" for item in details.numeric_findings)
            or details.endpoint_relation != "equivalent" or not details.components
            or any(item.relation != "match" for item in details.components) or details.estimand_relation != "match"):
        return unknown
    return {"status": "match", "reason": "complete_source_verification"}


def validate_check_batch(
    study: ExtractedStudy, indices: list[int], assessments: list[PrimaryAlignmentAssessment],
    source_text: str, protocol: ResearchProtocol,
) -> list[VerificationIssue]:
    """Return actionable schema/coverage/anchor/numeric errors before stamping."""
    from new_meta.core.primary_analysis_alignment import _anchored
    errors = []
    def issue(code, index=None, **context):
        errors.append({"code": code, "outcome_index": index, **context})
    expected = set(indices)
    received = [item.outcome_index for item in assessments]
    if set(received) != expected or len(received) != len(expected):
        issue("verification_index_coverage", expected=sorted(expected), received=received)
    counts = Counter(received)
    for item in assessments:
        index = item.outcome_index
        if index not in expected or not 0 <= index < len(study.outcomes) or counts[index] != 1:
            continue
        if not _anchored(item, source_text):
            issue("clinical_quote_not_anchored", index, dimensions={
                name: getattr(item, name).model_dump(mode="json") for name in ("outcome", "population", "contrast")})
        details = item.verification
        if details is None:
            issue("verification_details_missing", index)
            continue
        for name, support, required in (
                ("source_endpoint_definition", details.source_endpoint_definition, details.endpoint_relation != "uncertain"),
                ("estimand_support", details.estimand_support, details.estimand_relation != "uncertain")):
            if required and not quote_is_anchored(support.quote, support.source_location, source_text):
                issue("verification_quote_not_anchored", index, field=name, quote=support.quote)
        if details.endpoint_relation != "uncertain" and not details.components:
            issue("endpoint_component_mapping_incomplete", index)
        for component in details.components:
            if ((component.relation == "match" and (not component.source_component or not component.protocol_component))
                    or (component.relation == "extra" and not component.source_component)
                    or (component.relation == "missing" and not component.protocol_component)):
                issue("endpoint_component_mapping_incomplete", index)
        for unit in details.trial_units:
            for identifier in (unit.registry_id, unit.trial_name):
                if identifier and not quote_is_anchored(identifier, unit.source_location, unit.quote):
                    issue("trial_identifier_not_anchored", index)
        for item_support in [*details.conditioning_variables, *details.trial_units]:
            if not quote_is_anchored(item_support.quote, item_support.source_location, source_text):
                issue("verification_quote_not_anchored", index, field="conditioning_or_trial_unit")
        p_inequality = study.outcomes[index].p_value_inequality
        if p_inequality and not quote_is_anchored(p_inequality, "reported p-value inequality", source_text):
            issue("p_value_inequality_not_anchored", index, expression=p_inequality)
        conflicts = numeric_conflicts(study.outcomes[index])
        if conflicts:
            issue("numeric_conflict_requires_adjudication", index, conflicts=conflicts)
        values = numeric_fields(study.outcomes[index])
        if values and details.numeric_status != "verified":
            issue("numeric_status_unresolved", index, numeric_status=details.numeric_status)
        names = [finding.field for finding in details.numeric_findings]
        if set(names) != set(values) or len(names) != len(values):
            issue("numeric_field_coverage", index, expected=sorted(values), received=names)
        for finding in details.numeric_findings:
            if finding.field not in values:
                continue
            if finding.status == "mismatch" or (finding.reported_value is not None and not math.isclose(
                    values[finding.field], finding.reported_value, rel_tol=1e-10, abs_tol=1e-12)):
                issue("numeric_value_mismatch", index, field=finding.field, extracted=values[finding.field], reported=finding.reported_value)
            elif finding.status != "match" or finding.reported_value is None:
                issue("numeric_value_unverified", index, field=finding.field)
            if finding.status == "match" and (not quote_is_anchored(finding.quote, finding.source_location, source_text)
                    or not numeric_value_in_quote(finding.reported_value, finding.quote, finding.field)):
                issue("numeric_quote_not_anchored", index, field=finding.field, quote=finding.quote, reported=finding.reported_value)
    return errors


def trial_unit_issues(candidates: list[tuple[str, PrimaryAlignmentAssessment]]) -> list[VerificationIssue]:
    """Require known independent contributing units; publications are not trials.

    candidates contains (row_id, assessment). Aliases are joined only where one
    verified unit explicitly co-reports an ID and a name. No reference scanning.
    """
    from new_meta.core.primary_analysis_alignment import _normalized_quote
    parent = {}
    def root(key):
        parent.setdefault(key, key)
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key
    def alias(keys):
        for key in keys[1:]: parent[root(key)] = root(keys[0])
    records, issues = [], []
    for row_id, assessment in candidates:
        details = assessment.verification
        contributing = [unit for unit in details.trial_units if unit.role == "contributing"] if details else []
        if (not details or details.trial_coverage != "complete" or not contributing
                or any(unit.role == "uncertain" for unit in details.trial_units)):
            issues.append({"row_id": row_id, "reason": "trial_identity_required"})
            continue
        units = []
        for unit in contributing:
            keys = []
            if unit.registry_id.strip(): keys.append("registry:" + _normalized_quote(unit.registry_id))
            if unit.trial_name.strip(): keys.append("name:" + _normalized_quote(unit.trial_name))
            if not keys:
                issues.append({"row_id": row_id, "reason": "trial_identity_required"})
                continue
            root(keys[0])
            alias(keys)
            units.append(keys[0])
        records.append((row_id, units))
    registry_groups = {root(key) for key in list(parent) if key.startswith("registry:")}
    if len({row_id.rsplit(":", 1)[0] for row_id, _ in records}) > 1:
        for row_id, units in records:
            if any(root(unit) not in registry_groups for unit in units):
                issues.append({"row_id": row_id, "reason": "trial_identity_required",
                               "detail": "An unresolved trial-name/registry-ID relationship cannot establish disjoint cohorts."})
    by_unit = {}
    for row_id, units in records:
        for unit in {root(key) for key in units}:
            by_unit.setdefault(unit, set()).add(row_id)
    for unit, row_ids in by_unit.items():
        # Different candidate rows in the same publication are handled by the
        # existing explicit within-study primary choice, not by cohort deduping.
        if len({row_id.rsplit(":", 1)[0] for row_id in row_ids}) > 1:
            issues.extend({"row_id": row_id, "reason": "overlapping_trial_units",
                           "trial_unit": unit, "overlapping_rows": sorted(row_ids)} for row_id in sorted(row_ids))
    return issues
