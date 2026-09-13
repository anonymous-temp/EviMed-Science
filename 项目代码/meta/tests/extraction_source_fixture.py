"""Explicit offline provider fixtures for the reference wire, never production fallback."""
from copy import deepcopy
import hashlib
import json

from new_meta.core.extraction_sources import _supports, source_catalogue, OBSERVATION_VERSION
from new_meta.schemas.study import ExtractionReferenceEnvelope


def wire_payload(payload, text, catalogue=None, *, wire_version=OBSERVATION_VERSION):
    result = deepcopy(payload.model_dump(mode="json") if hasattr(payload, "model_dump") else payload)
    catalogue = catalogue or source_catalogue(text, hashlib.sha256(text.encode()).hexdigest())
    for _path, support in _supports(result):
        if not isinstance(support, dict) or "source_id" in support:
            continue
        quote = support.pop("quote", "")
        support.pop("source_location", None)
        support.pop("source_range", None)
        start = text.find(quote) if quote else -1
        begin = next((item for item in catalogue["sources"] if item["start"] == start), None)
        end = next((item for item in catalogue["sources"] if item["end"] == start + len(quote)), None)
        support["source_id"] = begin["source_id"] if begin and end else None if not quote else "unknown-source"
        support["end_source_id"] = end["source_id"] if begin and end else None
    if wire_version == 3:
        for row in result.get("primary_analysis_alignment", []):
            details = row.get("verification") if isinstance(row, dict) else None
            if isinstance(details, dict):
                for component in details.get("components", []):
                    if isinstance(component, dict):
                        component.pop("source_component", None)
    return result


def observed_check(response, text, observe, catalogue):
    payload = wire_payload(response, text, catalogue)
    observe({"content": json.dumps(payload), "finish_reason": "stop", "provider_response_ordinal": 1})
    return ExtractionReferenceEnvelope.model_validate(payload)
