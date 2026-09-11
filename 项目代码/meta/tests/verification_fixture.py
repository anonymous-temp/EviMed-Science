"""Explicit independent-verifier oracles for synthetic downstream test records."""
from new_meta.core.extraction_verification import numeric_fields


def verification_payload(outcome, assessment, *, numeric_quotes=None, registry_id="NCT00000001", trial_quote=None, randomized=True):
    values=numeric_fields(outcome)
    quotes=numeric_quotes or {field: outcome.source_quote for field in values}
    return {
        "numeric_status":"verified", "numeric_findings":[{
            "field":field,"status":"match","reported_value":value,"quote":quotes[field],
            "source_location":"Synthetic numerical fixture","rationale":"The fixture explicitly reports this field/value."
        } for field,value in values.items()],
        "endpoint_relation":"equivalent", "source_endpoint_definition":{
            "quote":assessment["outcome"]["quote"],"source_location":assessment["outcome"]["source_location"]},
        "components":[{"source_component":outcome.outcome_name or "Prespecified endpoint", "protocol_component":"Prespecified endpoint", "relation":"match"}],
        "estimand_relation":"match", "randomized_comparison":True if randomized else None,
        "postrandomization_conditioning":False if randomized else None,"selection_timing":"baseline" if randomized else "not_applicable",
        "conditioning_variables":[],"estimand_support":{
            "quote":assessment["contrast"]["quote"],"source_location":assessment["contrast"]["source_location"]},
        "trial_coverage":"complete" if randomized else "not_applicable",
        "trial_units":[{"registry_id":registry_id,"trial_name":"","role":"contributing",
                        "quote":trial_quote or f"The independent trial was registered as {registry_id}.","source_location":"Synthetic trial fixture"}] if randomized else [],
    }
