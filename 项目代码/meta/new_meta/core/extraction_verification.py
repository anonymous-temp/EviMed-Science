"""Deterministic validation of independent, source-bound extraction judgments."""
from __future__ import annotations

from collections import Counter
import math
import re
from typing import Any, Literal, TypedDict
import hashlib

from pydantic import ValidationError

from new_meta.schemas.study import (ExtractedStudy, ExtractionDataIssue, ExtractionDataIssueEvidence,
    OutcomeData, PrimaryAlignmentAssessment, EndpointResultSource, EndpointComponentBinding,
    EndpointComponentVerification, ExtractionRowVerificationV3)
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
_TEXT_FIELDS = frozenset(name for name in _PROPERTIES if name not in NUMERIC_FIELDS and name not in NUMERIC_MAP_FIELDS)

CHECKER_HIDDEN_FIELDS = frozenset({"primary_analysis_alignment", "source_quote_verified", "source_quote_match",
    "canonical_outcome_name", "estimand_id", "contrast_id", "manual_adjudication", "override_revision",
    "covariance_basis"})
#: Covariance entries this code derives rather than reads (see
#: rct_design_reconciliation): no source states them, so none can be quoted.
#: Each is re-derived from its own row instead, and verified only by that.
_DERIVED_COVARIANCE_BASIS = "derived:shared_control_arm_summaries"
REFINABLE_FIELDS = frozenset(NUMERIC_FIELDS) | frozenset(NUMERIC_MAP_FIELDS) | {
    "source_quote", "source_location", "source_page", "source_section", "reported_effect_measure",
    "reported_effect_scale", "reported_effect_adjusted", "adjustment_covariates",
    "outcome_type", "comparative_design", "p_value_inequality", "extraction_confidence"}


def numeric_fields(outcome: OutcomeData) -> dict[str, int | float]:
    values = {name: getattr(outcome, name) for name in NUMERIC_FIELDS
              if getattr(outcome, name, None) is not None}
    for name in NUMERIC_MAP_FIELDS:
        values.update({f"{name}[{key}]": value for key, value in sorted(getattr(outcome, name, {}).items())
                       if not (name == "covariance_with" and _is_derived_covariance(outcome, key, value))})
    return values


def _is_derived_covariance(outcome: OutcomeData, key: str, value: float) -> bool:
    """A shared-control MD covariance that equals SD_c^2 / n_c of this very row.

    Any other value, or the same value without the derivation recorded, stays a
    numeric field that has to be anchored in the source like every other one.
    """
    if outcome.covariance_basis.get(key) != _DERIVED_COVARIANCE_BASIS:
        return False
    if outcome.sd_control is None or outcome.n_control is None or float(outcome.n_control) <= 1:
        return False
    expected = float(outcome.sd_control) ** 2 / float(outcome.n_control)
    return math.isclose(float(value), expected, rel_tol=1e-9, abs_tol=1e-12)


def _computed_effects(outcome: OutcomeData, protocol: ResearchProtocol) -> tuple:
    """What synthesis computes from one row: the pairwise (yi, vi) and the typed estimate."""
    from new_meta.core.effect_selection import outcome_effect
    from new_meta.core.rct_design_reconciliation import comparative_effect_from_outcome
    results = []
    try:
        results.append(tuple(float(value) for value in outcome_effect(outcome, protocol)))
    except Exception:
        results.append(None)
    try:
        effect = comparative_effect_from_outcome(outcome, protocol)
        results.append(tuple(effect.get(name) for name in ("estimate", "standard_error", "ci_lower", "ci_upper")))
    except Exception:
        results.append(None)
    return tuple(results)


def calculation_fields(outcome: OutcomeData, protocol: ResearchProtocol) -> frozenset[str] | None:
    """The numeric fields whose values this row's effect computation reads.

    None when the row computes no effect at all; then every number counts. The
    set is found by removal rather than by restating the engines' rules: a
    field is read when taking its value away changes, or stops, the pairwise
    (yi, vi) or the typed comparative estimate synthesis would use. On
    2026-09-28 a contested table p-value of one ma-001 trial held back the
    mean difference computed from its arm means, SDs and sizes, which never
    reads it. A numeric-map entry (an extracted covariance) always counts.
    """
    base = _computed_effects(outcome, protocol)
    if all(result is None for result in base):
        return None
    read = set()
    for name in numeric_fields(outcome):
        if "[" in name or _computed_effects(outcome.model_copy(update={name: None}), protocol) != base:
            read.add(name)
    return frozenset(read)


def _numeric_field_name(name: str) -> bool:
    return name in NUMERIC_FIELDS or name.split("[", 1)[0] in NUMERIC_MAP_FIELDS


def issue_field_outside_calculation(field: str, read: frozenset[str] | None) -> bool:
    """Whether a finding about ``field`` leaves the row's computed effect standing.

    Only numbers the computation does not read (and a p-value inequality when
    the scalar p-value is not read). Clinical identity fields - outcome,
    timepoint, design, arms, quotes - always count.
    """
    if read is None:
        return False
    if field == "p_value_inequality":
        return "p_value" not in read
    return _numeric_field_name(field) and field not in read


def _conflict_outside_calculation(conflict: dict[str, Any], read: frozenset[str] | None) -> bool:
    if read is None:
        return False
    named = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", str(conflict.get("field") or ""))) & (
        set(NUMERIC_FIELDS) | set(NUMERIC_MAP_FIELDS))
    # A conflict that names no field has no known reach; it keeps blocking.
    return bool(named) and not named & {name.split("[", 1)[0] for name in read}


def blocking_data_issues(outcome: OutcomeData, protocol: ResearchProtocol, issues: list) -> list:
    """The unresolved source-row issues that hold this row's verification.

    An issue about a number the row's computation does not read is kept in
    the row's history (and reported) but does not block the computation.
    """
    if not issues:
        return []
    read = calculation_fields(outcome, protocol)
    return [item for item in issues if not issue_field_outside_calculation(item.issue.field, read)]


def validate_data_issues(study: ExtractedStudy, indices: list[int], issues: list[ExtractionDataIssue],
                         source_text: str) -> list[VerificationIssue]:
    """Keep bad checker contracts separate from unresolved source-row defects."""
    errors = []
    for item in issues:
        index, field = item.outcome_index, item.field
        context = {"outcome_index": index, "field": field, "kind": item.kind}
        if index not in indices or not 0 <= index < len(study.outcomes):
            errors.append({"code": "verification_data_issue_index_invalid", **context})
            continue
        values = numeric_fields(study.outcomes[index])
        if field not in (set(_PROPERTIES) - CHECKER_HIDDEN_FIELDS) | set(values):
            errors.append({"code": "verification_data_issue_field_invalid", **context})
            continue
        if not quote_is_anchored(item.quote, item.source_location, source_text):
            errors.append({"code": "verification_data_issue_quote_not_anchored", **context})
            continue
        repairable = item.kind != "source_conflict" and (field in REFINABLE_FIELDS or field in values)
        errors.append({"code": "row_source_conflict_requires_adjudication" if item.kind == "source_conflict" else "row_data_issue",
            **context, "repairable": repairable, "rationale": item.rationale,
            "quote": item.quote, "source_location": item.source_location})
    return errors


def issue_field_value(outcome: OutcomeData, field: str):
    """Read the implicated field, including one member of a numeric map."""
    if field in _PROPERTIES:
        return getattr(outcome, field)
    return numeric_fields(outcome).get(field)


def update_issue_history(study, indices, histories, errors, *, source_sha256,
                         checked_source_sha256, protocol_sha256, checked_rows,
                         complete_current_check):
    """A later silent checker response is not evidence that a defect was fixed."""
    from new_meta.core.primary_analysis_alignment import digest
    for index in indices:
        previous, available = histories[index]
        unresolved = list(previous)
        known = {digest(item.model_dump(mode="json")) for item in unresolved}
        for error in errors:
            if error.get("outcome_index") != index or error["code"] not in {
                    "row_data_issue", "row_source_conflict_requires_adjudication"}:
                continue
            issue = ExtractionDataIssue.model_validate({name: error[name] for name in (
                "outcome_index", "field", "kind", "rationale", "quote", "source_location")})
            evidence = ExtractionDataIssueEvidence(issue=issue,
                field_sha256=digest(issue_field_value(study.outcomes[index], issue.field)),
                row_sha256=checked_rows[index], protocol_sha256=protocol_sha256,
                source_sha256=source_sha256, checked_source_sha256=checked_source_sha256)
            key = digest(evidence.model_dump(mode="json"))
            if key not in known:
                unresolved.append(evidence)
                known.add(key)
        if index in complete_current_check:
            unresolved = [item for item in unresolved if (
                item.issue.kind == "source_conflict"
                or digest(issue_field_value(study.outcomes[index], item.issue.field)) == item.field_sha256
                or issue_field_value(study.outcomes[index], item.issue.field) in (None, "", [], {}))]
        histories[index] = unresolved, available


def unresolved_issue_errors(indices, histories, *, study=None, protocol=None, notices=None):
    """Errors for every unresolved issue; with ``study`` and ``protocol``, only the blocking ones.

    An issue outside the row's calculation goes to ``notices`` instead.
    """
    errors = []
    for index in indices:
        issues, available = histories[index]
        if not available:
            errors.append({"code": "verification_issue_history_required", "outcome_index": index})
        blocking = issues if study is None or protocol is None else blocking_data_issues(
            study.outcomes[index], protocol, issues)
        for item in issues:
            issue = item.issue
            if not any(item is kept for kept in blocking):
                if notices is not None:
                    notices.append({"code": "row_issue_outside_calculation", "outcome_index": index,
                                    "field": issue.field, "kind": issue.kind, "rationale": issue.rationale})
                continue
            repairable = issue.kind != "source_conflict" and (
                issue.field in REFINABLE_FIELDS or any(issue.field.startswith(name + "[") for name in NUMERIC_MAP_FIELDS))
            errors.append({"code": "row_source_conflict_requires_adjudication" if issue.kind == "source_conflict" else "row_data_issue",
                **issue.model_dump(mode="json"), "repairable": repairable,
                "origin_field_sha256": item.field_sha256,
                "origin_source_sha256": item.source_sha256,
                "origin_checked_source_sha256": item.checked_source_sha256})
    return errors


def refinement_indices(errors: list[VerificationIssue]) -> list[int]:
    """Only a complete, anchored checker response may suggest source-row repair."""
    contract_errors = {"clinical_quote_not_anchored", "numeric_quote_not_anchored", "numeric_field_coverage",
                       "endpoint_component_mapping_incomplete"}
    if any(item["code"].startswith("verification_") or item["code"] in contract_errors for item in errors):
        return []
    conflicts = {item.get("outcome_index") for item in errors if item["code"] in {
        "numeric_conflict_requires_adjudication", "row_source_conflict_requires_adjudication"}}
    return sorted({item["outcome_index"] for item in errors if type(item.get("outcome_index")) is int
        and item["outcome_index"] not in conflicts and (item["code"] in {
            "numeric_value_mismatch", "numeric_value_unverified", "numeric_status_unresolved"}
            or item["code"] == "row_data_issue" and item.get("repairable") is True)})


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


#: Statistical notation a source uses to say what "a ± b" reports. A closed
#: vocabulary of notation, not prose: the forms that declare a standard
#: deviation, and the other quantities ± is written for.
_PLUS_MINUS_SD = re.compile(
    r"(?:(?:means?|均数|均值|x̄)\s*)?(?:±|\+/-)\s*(?:sd|s\.d\.|standard deviations?|标准差)(?![a-z])"
    r"|x̄\s*(?:±|\+/-)\s*s(?![a-z.])")
_PLUS_MINUS_OTHER = re.compile(
    r"(?:±|\+/-)\s*(?:se|s\.e\.|sem|s\.e\.m\.|standard errors?|标准误|(?:95\s*%\s*)?ci|iqr|range)(?![a-z])")
_MEAN_SD_NUMBER = r"[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
_MEAN_SD_TOKEN = re.compile(rf"({_MEAN_SD_NUMBER})\s*%?\s*(?:±|\+/-)\s*({_MEAN_SD_NUMBER})\s*%?")
#: Counts written as words. On 2026-09-28 the checker quoted "No patient had
#: clinical signs of deep vein thrombosis" for zero events and "required for one
#: patient" for one, and both were refused because no digit was in the quote.
#: Closed vocabulary: the determiners that state zero, and the cardinals to twenty.
_COUNT_WORDS = {
    "zero": 0, "no": 0, "none": 0, "nil": 0, "neither": 0, "nobody": 0,
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
}
_CJK_ZERO = ("零", "〇", "无", "未", "没有")
_CJK_DIGITS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
_CJK_CLASSIFIERS = "例名人位个"
_EVENT_FIELDS = frozenset({"true_positive", "false_negative", "false_positive", "true_negative", "prediction_events"})


def plus_minus_reports_sd(source_text: str) -> bool:
    """Whether the source declares its "a ± b" values as mean ± SD, and nothing else.

    Tables usually carry the declaration once, in a caption or the statistics
    paragraph ("Means ± SD"), not beside every value a checker quotes. A source
    that also writes ± for an SE, a CI or a range keeps the stricter rule: the
    quoted passage itself has to say which one it is.
    """
    from new_meta.core.primary_analysis_alignment import _normalized_quote
    text = _normalized_quote(source_text)
    return bool(_PLUS_MINUS_SD.search(text)) and not _PLUS_MINUS_OTHER.search(text)


def _count_word_in_quote(value: float, text: str) -> bool:
    if not float(value).is_integer() or not 0 <= value <= 20:
        return False
    count = int(value)
    if any(re.search(rf"(?<![a-z]){word}(?![a-z])", text) for word, number in _COUNT_WORDS.items() if number == count):
        return True
    if count == 0 and any(mark in text for mark in _CJK_ZERO):
        return True
    return any(re.search(rf"{digit}[{_CJK_CLASSIFIERS}]", text) for digit, number in _CJK_DIGITS.items() if number == count)


def numeric_value_in_quote(value: float | int | None, quote: str, field: str = "", *,
                           plus_minus_sd: bool = False) -> bool:
    """Check reported decimal/power literals, retaining signs and numeric spans.

    Compound fractions, multiplication and plus/minus expressions require explicit
    source values; they are not split into misleading numerator/denominator values.
    Interval endpoints are supported, including the common PDF en-dash form.
    "a ± b" gives a mean and its SD when the quote or, through ``plus_minus_sd``,
    the whole source declares that notation. An event count may be written as a
    word (``_COUNT_WORDS``).
    """
    from new_meta.core.primary_analysis_alignment import _normalized_quote, _NUMBER_ATOM, _NUMERIC_TOKEN
    if value is None or not math.isfinite(float(value)):
        return False
    text = _normalized_quote(quote)
    event_field = field.startswith("events") or field in _EVENT_FIELDS
    total_field = field.startswith("total") or field in {"n_intervention", "n_control", "correlation_n", "prediction_sample_size"}
    addition_spans = [match.span() for match in re.finditer(_NUMBER_ATOM + r"\s*\+\s*" + _NUMBER_ATOM, text)]
    labelled_mean_sd = plus_minus_sd or bool(re.search(r"(?:mean|均值)\s*(?:±|\+/-)\s*(?:sd|standard deviations?|标准差)\b", text))
    for compound in _NUMERIC_TOKEN.finditer(text):
        token = compound.group()
        if any(start <= compound.start() and compound.end() <= end for start, end in addition_spans):
            continue
        mean_sd = _MEAN_SD_TOKEN.fullmatch(token)
        if mean_sd and labelled_mean_sd and (field.startswith("mean_") or field.startswith("sd_")):
            reported = float(mean_sd.group(1 if field.startswith("mean_") else 2).replace("−", "-").replace(",", ""))
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
    return event_field and _count_word_in_quote(float(value), text)


_P_EXPRESSION = re.compile(r"p\s*(?:-?\s*values?)?\s*(<=|>=|≤|≥|<|>|=)\s*(\d*\.?\d+(?:e-?\d+)?)")
_P_COMPARATORS = {"≤": "<=", "≥": ">="}


def p_inequality_is_anchored(expression: str, source_text: str) -> bool:
    """A reported p-value inequality is in the source when its comparator and bound are.

    Extraction writes "p<0.001" for a source's "P < 0.001" or "P<.001": the
    same statement, spaced and cased differently, and on 2026-09-28 it was
    refused 52 times in one ma-001 run. Parsed as (comparator, number), both
    sides compare exactly; an expression that does not parse keeps the verbatim rule.
    """
    from new_meta.core.primary_analysis_alignment import _normalized_quote
    parsed = _P_EXPRESSION.fullmatch(_normalized_quote(expression).strip())
    if parsed is None:
        return quote_is_anchored(expression, "reported p-value inequality", source_text)
    comparator = _P_COMPARATORS.get(parsed.group(1), parsed.group(1))
    bound = float(parsed.group(2))
    text = _normalized_quote(source_text)
    for match in _P_EXPRESSION.finditer(text):
        if match.start() and text[match.start() - 1].isalnum():
            continue
        if (_P_COMPARATORS.get(match.group(1), match.group(1)) == comparator
                and math.isclose(float(match.group(2)), bound, rel_tol=1e-12, abs_tol=0.0)):
            return True
    return False


def _valid_endpoint_result(value, source_text):
    """Authenticate a resolved contiguous slice without interpreting its clinical text."""
    try:
        result = EndpointResultSource.model_validate(value, strict=True)
    except (ValidationError, TypeError):
        return None
    span = result.source_range
    if (span is None or not 0 <= span.start < span.end <= len(source_text)
            or span.end - span.start > 8192
            or span.checked_source_sha256 != hashlib.sha256(source_text.encode()).hexdigest()
            or source_text[span.start:span.end] != result.quote
            or span.text_sha256 != hashlib.sha256(result.quote.encode()).hexdigest()
            or span.start_byte != len(source_text[:span.start].encode())
            or span.end_byte != len(source_text[:span.end].encode())
            or not result.source_location.strip()):
        return None
    return result


def endpoint_binding_errors(details, source_text, component_index=None):
    """Validate one judgment's own endpoint binding, independent of sibling leaves.

    Called for complete responses, raw partial negatives, and receipt replay.
    Membership is the model's explicit semantic judgment, not a text classifier.
    """
    raw = details.model_dump(mode="json") if hasattr(details, "model_dump") else details
    if not isinstance(raw, dict) or type(raw.get("schema_version")) is not int or raw["schema_version"] != 3:
        return [{"code": "verification_endpoint_membership_required"}]
    selected = _valid_endpoint_result(raw.get("selected_endpoint_result"), source_text)
    if selected is None:
        return [{"code": "verification_endpoint_result_invalid"}]
    if raw.get("definition_scope") != "selected_endpoint":
        return [{"code": "verification_endpoint_definition_not_selected"}]
    try:
        from new_meta.schemas.study import VerificationSource
        definition = VerificationSource.model_validate(raw.get("source_endpoint_definition"), strict=True)
    except (ValidationError, TypeError):
        return [{"code": "verification_endpoint_definition_invalid"}]
    if not quote_is_anchored(definition.quote, definition.source_location, source_text):
        return [{"code": "verification_endpoint_definition_invalid"}]
    if component_index is None:
        return []
    context = {"component_index": component_index}
    def error(code):
        return [{"code": code, **context}]
    components, bindings = raw.get("components"), raw.get("component_bindings")
    if not isinstance(components, list) or not 0 <= component_index < len(components) or not isinstance(bindings, list):
        return error("verification_component_binding_required")
    matches = [item for item in bindings if isinstance(item, dict)
        and type(item.get("component_index")) is int and item["component_index"] == component_index]
    if len(matches) != 1:
        return error("verification_component_binding_coverage")
    try:
        component = EndpointComponentVerification.model_validate(components[component_index], strict=True)
        binding = EndpointComponentBinding.model_validate(matches[0], strict=True)
    except (ValidationError, TypeError):
        return error("verification_component_binding_invalid")
    target = _valid_endpoint_result(binding.target_result, source_text)
    if target is None or target.source_range != selected.source_range or target.quote != selected.quote:
        return error("verification_component_target_mismatch")
    if not quote_is_anchored(binding.support.quote, binding.support.source_location, source_text):
        return error("verification_component_support_not_anchored")
    required = {"match": "included_in_selected_endpoint", "extra": "included_in_selected_endpoint",
                "missing": "absent_from_selected_endpoint"}.get(component.relation)
    if required is not None and binding.source_membership != required:
        return error("verification_component_membership_inconsistent")
    if component.relation in {"match", "extra"} and not quote_is_anchored(
            component.source_component, binding.support.source_location, binding.support.quote):
        return error("verification_component_label_not_anchored")
    if component.relation in {"match", "missing"} and not component.protocol_component:
        return error("verification_component_mapping_incomplete")
    return []


def verification_verdict(assessment: PrimaryAlignmentAssessment, protocol: ResearchProtocol,
                         outcome: OutcomeData | None = None) -> VerificationVerdict:
    """The row's verification verdict; given its ``outcome``, numbers count within its calculation."""
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
    if (not _numbers_verified(details, protocol, outcome)
            or details.endpoint_relation != "equivalent" or not details.components
            or any(item.relation != "match" for item in details.components) or details.estimand_relation != "match"):
        return unknown
    return {"status": "match", "reason": "complete_source_verification"}


def _numbers_verified(details, protocol, outcome) -> bool:
    """All numbers match; or, for a row that computes an effect, all the numbers it reads.

    A summary status other than "verified" is accepted only when the checker's
    own findings explain it by a number outside the calculation.
    """
    read = calculation_fields(outcome, protocol) if outcome is not None else None
    if read is None:
        return details.numeric_status == "verified" and all(item.status == "match" for item in details.numeric_findings)
    inside = [item for item in details.numeric_findings if item.field in read]
    if any(item.status != "match" for item in inside) or not read <= {item.field for item in inside}:
        return False
    return details.numeric_status == "verified" or any(
        item.status != "match" and _numeric_field_name(item.field) and item.field not in read
        for item in details.numeric_findings)


def validate_check_batch(
    study: ExtractedStudy, indices: list[int], assessments: list[PrimaryAlignmentAssessment],
    source_text: str, protocol: ResearchProtocol, *, allow_legacy=False, notices: list | None = None,
) -> list[VerificationIssue]:
    """Return actionable schema/coverage/anchor/numeric errors before stamping.

    A number the row's effect computation does not read (``calculation_fields``)
    cannot block it: its findings go to ``notices``, when given, instead.
    """
    from new_meta.core.primary_analysis_alignment import _anchored
    errors = []
    plus_minus_sd = plus_minus_reports_sd(source_text)
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
        if isinstance(details, ExtractionRowVerificationV3):
            for error in endpoint_binding_errors(details, source_text):
                issue(error.pop("code"), index, **error)
            binding_indices = [binding.component_index for binding in details.component_bindings]
            if sorted(binding_indices) != list(range(len(details.components))):
                issue("verification_component_binding_coverage", index,
                      expected=list(range(len(details.components))), received=binding_indices)
            for component_index in range(len(details.components)):
                for error in endpoint_binding_errors(details, source_text, component_index):
                    issue(error.pop("code"), index, **error)
        elif not allow_legacy:
            issue("verification_endpoint_membership_required", index)
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
        outcome = study.outcomes[index]
        values = numeric_fields(outcome)
        read = calculation_fields(outcome, protocol)

        def scoped(code, blocks, **context):
            if blocks:
                issue(code, index, **context)
            elif notices is not None:
                notices.append({"code": code, "outcome_index": index, "outside_calculation": True, **context})

        p_inequality = outcome.p_value_inequality
        if p_inequality and not p_inequality_is_anchored(p_inequality, source_text):
            scoped("p_value_inequality_not_anchored", not issue_field_outside_calculation("p_value_inequality", read),
                   expression=p_inequality)
        conflicts = numeric_conflicts(outcome)
        outside = [item for item in conflicts if _conflict_outside_calculation(item, read)]
        if len(outside) < len(conflicts):
            issue("numeric_conflict_requires_adjudication", index, conflicts=[item for item in conflicts if item not in outside])
        if outside:
            scoped("numeric_conflict_requires_adjudication", False, conflicts=outside)
        findings = details.numeric_findings
        if values and details.numeric_status != "verified":
            explained = read is not None and all(item.status == "match" for item in findings if item.field in read) and any(
                item.status != "match" and _numeric_field_name(item.field) and item.field not in read for item in findings)
            scoped("numeric_status_unresolved", not explained, numeric_status=details.numeric_status)
        # A finding about a field that holds no number (a checker verifying
        # p_value_inequality beside p_value) verifies nothing and is left out;
        # a name that is no field at all still breaks the contract.
        names = [finding.field for finding in findings if finding.field in values or finding.field not in _TEXT_FIELDS]
        required = set(values) if read is None else set(values) & read
        complete = set(names) == set(values) and len(names) == len(values)
        covered = (required <= set(names) and not any(name not in values and not _numeric_field_name(name) for name in names)
                   and sum(name in required for name in names) == len(required))
        if not complete:
            scoped("numeric_field_coverage", read is None or not covered, expected=sorted(required if covered else values),
                   received=names)
        for finding in findings:
            if finding.field not in values:
                continue
            blocks = not issue_field_outside_calculation(finding.field, read)
            if finding.status == "mismatch" or (finding.reported_value is not None and not math.isclose(
                    values[finding.field], finding.reported_value, rel_tol=1e-10, abs_tol=1e-12)):
                scoped("numeric_value_mismatch", blocks, field=finding.field, extracted=values[finding.field],
                       reported=finding.reported_value)
            elif finding.status != "match" or finding.reported_value is None:
                scoped("numeric_value_unverified", blocks, field=finding.field)
            if finding.status == "match" and (not quote_is_anchored(finding.quote, finding.source_location, source_text)
                    or not numeric_value_in_quote(finding.reported_value, finding.quote, finding.field,
                                                  plus_minus_sd=plus_minus_sd)):
                scoped("numeric_quote_not_anchored", blocks, field=finding.field, quote=finding.quote,
                       reported=finding.reported_value)
    return errors


def trial_unit_issues(candidates: list[tuple[str, PrimaryAlignmentAssessment]], *,
                      publication_units: dict[str, str] | None = None,
                      assumed: list | None = None) -> list[VerificationIssue]:
    """Require known independent contributing units; publications are not trials.

    candidates contains (row_id, assessment). Aliases are joined only where one
    verified unit explicitly co-reports an ID and a name. No reference scanning.

    ``publication_units`` (unattended runs only, see
    primary_analysis_alignment.project_publication_units) names, per
    publication, the primary publication that stands for its own trial when
    the source reports neither a registry ID nor a trial name for it and the
    checker saw no uncertain unit. That independence is an assumption, not a
    verified fact: such rows are appended to ``assumed`` for the caller to report.
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
        publication = row_id.rsplit(":", 1)[0]
        if (publication_units and publication in publication_units and details is not None
                and details.trial_coverage in {"complete", "uncertain"}
                and not any(unit.role == "uncertain" or unit.registry_id.strip() or unit.trial_name.strip()
                            for unit in details.trial_units)):
            key = "publication:" + publication_units[publication]
            root(key)
            records.append((row_id, [key]))
            if assumed is not None:
                assumed.append(row_id)
            continue
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
            if any(root(unit) not in registry_groups and not unit.startswith("publication:") for unit in units):
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
