"""Read independent verifier observations without repairing their judgments."""
from collections import Counter

from pydantic import TypeAdapter, ValidationError

from new_meta.core.extraction_verification import (
    quote_is_anchored, validate_check_batch, validate_data_issues,
)
from new_meta.core.llm import parse_source_json
from new_meta.schemas.study import (
    AlignmentDimension, ConditioningVariableVerification, EndpointComponentVerification,
    ExtractionDataIssue, ExtractionRowVerification, VerificationSource,
)


def _anchored_support(value, source_text):
    try:
        support = VerificationSource.model_validate(value, strict=True)
    except (ValidationError, TypeError):
        return None
    return support if quote_is_anchored(support.quote, support.source_location, source_text) else None


def _verification_negatives(details, source_text, protocol):
    """Validate each negative only against the support that establishes it.

    These are the existing endpoint/estimand/RCT mismatch conditions. The source
    schema supplies their closed vocabulary; no missing sibling is synthesized.
    """
    if not isinstance(details, dict):
        return []
    negatives = []
    def retain(field, value, support_field, support, reason, **context):
        negatives.append({"dimension": "verification", "field": field,
            "judgment": {field: value, support_field: support.model_dump(mode="json")},
            "verdict": {"status": "mismatch", "reason": reason}, **context})

    endpoint = _anchored_support(details.get("source_endpoint_definition"), source_text)
    estimand = _anchored_support(details.get("estimand_support"), source_text)
    for field, negative_values, support_field, support, reason in (
        ("endpoint_relation", {"source_broader", "source_narrower", "different"},
         "source_endpoint_definition", endpoint, "endpoint_components_incompatible"),
        ("estimand_relation", {"mismatch"}, "estimand_support", estimand, "source_estimand_incompatible"),
    ):
        try:
            value = TypeAdapter(ExtractionRowVerification.model_fields[field].annotation).validate_python(details.get(field), strict=True)
        except ValidationError:
            continue
        if support is not None and value in negative_values:
            retain(field, value, support_field, support, reason)
    components = details.get("components")
    if endpoint is not None and isinstance(components, list):
        for component_index, raw_component in enumerate(components):
            try:
                component = EndpointComponentVerification.model_validate(raw_component, strict=True)
            except (ValidationError, TypeError):
                continue
            if ((component.relation == "extra" and component.source_component)
                    or (component.relation == "missing" and component.protocol_component)):
                retain("components", [component.model_dump(mode="json")], "source_endpoint_definition", endpoint,
                       "endpoint_components_incompatible", component_index=component_index)
    from new_meta.core.method_planning import infer_review_family
    from new_meta.schemas.method_policy import ReviewFamily
    if infer_review_family(protocol) is not ReviewFamily.INTERVENTION_RCT:
        return negatives
    for field, negative_value in (("randomized_comparison", False), ("postrandomization_conditioning", True),
                                  ("selection_timing", "postrandomization")):
        try:
            value = TypeAdapter(ExtractionRowVerification.model_fields[field].annotation).validate_python(details.get(field), strict=True)
        except ValidationError:
            continue
        if estimand is not None and type(value) is type(negative_value) and value == negative_value:
            retain(field, value, "estimand_support", estimand, "randomized_total_effect_required")
    variables = details.get("conditioning_variables")
    if isinstance(variables, list):
        for variable_index, raw_variable in enumerate(variables):
            try:
                variable = ConditioningVariableVerification.model_validate(raw_variable, strict=True)
            except (ValidationError, TypeError):
                continue
            if variable.timing == "postrandomization" and quote_is_anchored(
                    variable.quote, variable.source_location, source_text):
                negatives.append({"dimension": "verification", "field": "conditioning_variables",
                    "variable_index": variable_index,
                    "judgment": {"conditioning_variables": [variable.model_dump(mode="json")]},
                    "verdict": {"status": "mismatch", "reason": "randomized_total_effect_required"}})
    return negatives


def inspect_extraction_observation(content, schema, study, indices, source_text, protocol):
    """Retain only independently valid, uniquely identified source judgments.

    The complete envelope is validated separately. A valid item beside a broken
    sibling supplies negative evidence, never permission to certify a partial row.
    """
    result = {"response": None, "errors": [], "data_errors": [], "clinical_negatives": []}
    try:
        raw = parse_source_json(content)
    except (ValueError, TypeError) as exc:
        result["errors"].append({"code": "verification_raw_json_invalid", "error_type": type(exc).__name__})
        return result
    try:
        result["response"] = schema.model_validate(raw, strict=True)
    except ValidationError as exc:
        result["errors"].append({"code": "verification_raw_schema_invalid",
            "validation_errors": exc.errors(include_input=False, include_context=False, include_url=False)})
    if not isinstance(raw, dict):
        return result
    rows = raw.get("primary_analysis_alignment")
    rows = rows if isinstance(rows, list) else []
    counts = Counter(item.get("outcome_index") for item in rows
                     if isinstance(item, dict) and type(item.get("outcome_index")) is int)
    for index, count in counts.items():
        if count > 1:
            result["errors"].append({"code": "verification_duplicate_row", "outcome_index": index})
    for item in rows:
        if not isinstance(item, dict):
            continue
        index = item.get("outcome_index")
        if type(index) is not int or index not in indices or counts[index] != 1:
            continue
        # A damaged sibling dimension must not conceal a valid, explicit negative.
        for dimension in ("outcome", "population", "contrast"):
            try:
                judgment = AlignmentDimension.model_validate(item.get(dimension), strict=True)
            except (ValidationError, TypeError):
                continue
            if judgment.status != "match" and quote_is_anchored(
                    judgment.quote, judgment.source_location, source_text):
                result["clinical_negatives"].append({"outcome_index": index,
                    "dimension": dimension, "judgment": judgment.model_dump(mode="json")})
        result["clinical_negatives"].extend({"outcome_index": index, **judgment} for judgment in
            _verification_negatives(item.get("verification"), source_text, protocol))
    issues = raw.get("data_issues")
    issues = issues if isinstance(issues, list) else []
    parsed_issues = []
    for item in issues:
        try:
            parsed_issues.append(ExtractionDataIssue.model_validate(item, strict=True))
        except (ValidationError, TypeError):
            continue
    result["data_errors"] = validate_data_issues(study, indices, parsed_issues, source_text)
    if result["response"] is not None:
        checked = result["response"]
        result["errors"].extend(validate_check_batch(
            study, indices, checked.primary_analysis_alignment, source_text, protocol))
        result["errors"].extend(validate_data_issues(study, indices, checked.data_issues, source_text))
    return result
