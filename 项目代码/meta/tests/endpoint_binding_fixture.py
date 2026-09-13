"""Explicit source membership for synthetic fixtures, never production inference."""
from copy import deepcopy
import hashlib
from new_meta.core.extraction_sources import source_catalogue, _digest


def result_support(text, quote):
    catalogue = source_catalogue(text, hashlib.sha256(text.encode()).hexdigest())
    start = text.index(quote)
    end = start + len(quote)
    first = next(item for item in catalogue["sources"] if item["start"] == start)
    last = next(item for item in catalogue["sources"] if item["end"] == end)
    location = first["source_location"] if first == last else f"{first['source_location']} through characters {end}"
    return {"quote": quote, "source_location": location, "source_range": {
        "catalogue_sha256": _digest(catalogue), "checked_source_sha256": catalogue["checked_source_sha256"],
        "source_id": first["source_id"], "end_source_id": last["source_id"],
        "start": start, "end": end, "start_byte": first["start_byte"], "end_byte": last["end_byte"],
        "text_sha256": hashlib.sha256(quote.encode()).hexdigest()}}


def bind_components(row, text):
    result = deepcopy(row)
    details = result["verification"]
    selected = result_support(text, details["numeric_findings"][0]["quote"] if details["numeric_findings"]
                              else details["source_endpoint_definition"]["quote"])
    details.update(schema_version=3, selected_endpoint_result=selected, definition_scope="selected_endpoint",
        component_bindings=[{"component_index": index,
            "source_membership": "absent_from_selected_endpoint" if item["relation"] == "missing" else "included_in_selected_endpoint",
            "target_result": deepcopy(selected), "support": deepcopy(details["source_endpoint_definition"]),
            "rationale": "The synthetic source explicitly supports this component's target membership."}
            for index, item in enumerate(details["components"])])
    return result
