"""Resolve model-selected references to immutable, contiguous original text."""
from copy import deepcopy
import hashlib
import json
import re

VERSION = 1
OBSERVATION_VERSION = 3
ASSESSOR = "extraction-check-sources-v3"
SOURCE_ASSESSOR_VERSIONS = {f"extraction-check-sources-v{version}": version for version in (1, 2, 3)}
MAX_SPAN_CHARS = 8192
MAX_SOURCE_CHARS = 128_000


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _digest(value):
    return _hash(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def source_catalogue(text, source_sha256, *, body_end=None, page_map=()):
    """Offsets address raw codepoints and UTF-8 bytes, never normalized text."""
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_SOURCE_CHARS:
        raise ValueError("Extraction source is empty or exceeds the existing context limit")
    if not re.fullmatch(r"[a-f0-9]{64}", source_sha256):
        raise ValueError("Extraction source digest is invalid")
    body_end = len(text) if body_end is None else body_end
    if type(body_end) is not int or not 0 <= body_end <= len(text):
        raise ValueError("Extraction source boundary is invalid")
    pages = [dict(item) for item in page_map]
    for page in pages:
        if (set(page) != {"page_number", "start_char", "end_char"}
                or any(type(page[key]) is not int for key in page)
                or page["page_number"] < 1
                or not 0 <= page["start_char"] <= page["end_char"] <= body_end):
            raise ValueError("Extraction source page map is invalid")
    identity = {"version": VERSION, "source_sha256": source_sha256,
        "checked_source_sha256": _hash(text), "offset_unit": "unicode_codepoints",
        "body_end": body_end, "page_map": pages}
    namespace = _digest(identity)[:20]
    # Physical lines and non-decimal punctuation are layout units, not
    # clinical classifications. Never cut a hyphenated line-end word in half.
    boundaries = {0, len(text), body_end}
    for match in re.finditer(r"(?:\r\n|\r|\n)|[.!?](?!\d)", text):
        if match.group().strip() == "" and re.search(r"\w[-‐‑]\s*$", text[:match.start()]):
            continue
        boundaries.add(match.end())
    byte_offsets = [0]
    for character in text:
        byte_offsets.append(byte_offsets[-1] + len(character.encode("utf-8")))
    ranges = []
    points = sorted(boundaries)
    for start, end in zip(points, points[1:]):
        while end - start > 1024:
            split = next((match.end() for match in re.finditer(r"\s+", text[start:end])
                          if 512 <= match.end() <= 1024), None)
            if split is None:
                break
            ranges.append((start, start + split))
            start += split
        ranges.append((start, end))
    sources = []
    for start, end in ranges:
        while start < end and text[start].isspace(): start += 1
        while end > start and text[end - 1].isspace(): end -= 1
        if start == end: continue
        if end - start > MAX_SPAN_CHARS:
            raise ValueError("An indivisible extraction source unit exceeds the span limit")
        location = f"Source characters {start}:{end}"
        if start >= body_end:
            location = f"Extracted tables; page unknown; characters {start}:{end}"
            markers = list(re.finditer(r"(?m)^\[PAGE ([1-9][0-9]*)\] Table [1-9][0-9]*", text[body_end:start + 1]))
            if markers:
                location = f"Extracted tables; Page {markers[-1].group(1)}; characters {start}:{end}"
        else:
            covered = [page["page_number"] for page in pages
                       if page["start_char"] <= start < page["end_char"]]
            if covered: location = f"Page {covered[0]}; characters {start}:{end}"
        sources.append({"source_id": f"s{namespace}_{len(sources):x}", "start": start, "end": end,
            "start_byte": byte_offsets[start], "end_byte": byte_offsets[end],
            "text_sha256": _hash(text[start:end]), "source_location": location})
    return {**identity, "sources": sources}


def validate_catalogue(text, catalogue):
    if (not isinstance(catalogue, dict) or type(catalogue.get("version")) is not int
            or catalogue != source_catalogue(text,
            catalogue.get("source_sha256", ""), body_end=catalogue.get("body_end"),
            page_map=catalogue.get("page_map", ()))):
        raise ValueError("Extraction source catalogue does not match its exact inputs")


def source_prompt(text, catalogue):
    validate_catalogue(text, catalogue)
    return "\n".join(f"[{item['source_id']}] " + json.dumps(text[item["start"]:item["end"]], ensure_ascii=False)
                     for item in catalogue["sources"])


def reference_schema(canonical_schema, *, wire_version=OBSERVATION_VERSION):
    """Derive the wire schema; all non-reference fields keep their actual types."""
    schema = deepcopy(canonical_schema)
    if type(wire_version) is not int or wire_version not in {1, 2, 3}:
        raise ValueError("Extraction source wire version is unsupported")
    if wire_version == 3:
        component = schema.get("$defs", {}).get("EndpointComponentVerification", {})
        component.get("properties", {}).pop("source_component", None)
        component["required"] = [name for name in component.get("required", []) if name != "source_component"]
    for definition in [schema, *schema.get("$defs", {}).values()]:
        properties = definition.get("properties", {})
        if "quote" not in properties or "source_location" not in properties: continue
        properties.pop("quote"); properties.pop("source_location")
        properties.pop("source_range", None)
        properties["source_id"] = {"anyOf": [{"type": "string"}, {"type": "null"}]}
        properties["end_source_id"] = {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None}
        definition["required"] = [name for name in definition.get("required", [])
                                  if name not in {"quote", "source_location", "source_range"}] + ["source_id"]
    return schema


def _supports(payload):
    if not isinstance(payload, dict): return
    issues = payload.get("data_issues")
    if isinstance(issues, list):
        for index, item in enumerate(issues): yield f"data_issues/{index}", item
    rows = payload.get("primary_analysis_alignment")
    if not isinstance(rows, list): return
    for index, row in enumerate(rows):
        if not isinstance(row, dict): continue
        prefix = f"primary_analysis_alignment/{index}"
        for name in ("outcome", "population", "contrast"):
            if name in row: yield f"{prefix}/{name}", row[name]
        details = row.get("verification")
        if not isinstance(details, dict): continue
        for name in ("source_endpoint_definition", "estimand_support", "selected_endpoint_result"):
            if name in details: yield f"{prefix}/verification/{name}", details[name]
        for name in ("numeric_findings", "conditioning_variables", "trial_units"):
            if isinstance(details.get(name), list):
                for child, item in enumerate(details[name]): yield f"{prefix}/verification/{name}/{child}", item
        if isinstance(details.get("component_bindings"), list):
            for child, binding in enumerate(details["component_bindings"]):
                if isinstance(binding, dict):
                    for name in ("target_result", "support"):
                        if name in binding:
                            yield f"{prefix}/verification/component_bindings/{child}/{name}", binding[name]


def _materialize_component_sources(resolved, text, errors, metadata):
    """Resolve each component excerpt without changing any model judgment.

    A valid component's binding is independent of broken siblings. The shared
    validator still checks membership, selected-result identity, and literal text.
    """
    from new_meta.core.extraction_verification import endpoint_binding_errors
    rows = resolved.get("primary_analysis_alignment") if isinstance(resolved, dict) else None
    if not isinstance(rows, list):
        return
    for row_index, row in enumerate(rows):
        details = row.get("verification") if isinstance(row, dict) else None
        if not isinstance(details, dict) or not isinstance(details.get("components"), list):
            continue
        bindings = details.get("component_bindings")
        bindings = bindings if isinstance(bindings, list) else []
        for index, component in enumerate(details["components"]):
            if not isinstance(component, dict):
                continue
            path = f"primary_analysis_alignment/{row_index}/verification/components/{index}/source_component"
            context = {"outcome_index": row.get("outcome_index"), "component_index": index, "path": path}
            if "source_component" in component:
                # Preserve the supplied value visibly, but never treat it as a
                # validated negative or silently replace it with another excerpt.
                component["source_component_reference_invalid"] = True
                errors.append({"code": "verification_component_source_supplied", **context})
                continue
            matches = [(position, item) for position, item in enumerate(bindings) if isinstance(item, dict)
                and type(item.get("component_index")) is int and item["component_index"] == index]
            if len(matches) != 1:
                errors.append({"code": "verification_component_binding_coverage", **context})
                continue
            position, binding = matches[0]
            support = binding.get("support")
            quote = support.get("quote") if isinstance(support, dict) else None
            value = quote if component.get("relation") in {"match", "extra"} else ""
            candidate = {**component, "source_component": value}
            components = list(details["components"])
            components[index] = candidate
            failures = endpoint_binding_errors({**details, "components": components}, text, index)
            if failures:
                errors.extend({**failure, **context} for failure in failures)
                continue
            component["source_component"] = value
            metadata.append({"path": path,
                "from_path": f"primary_analysis_alignment/{row_index}/verification/component_bindings/{position}/support",
                "text_sha256": _hash(value)})


def resolve_reference_payload(text, catalogue, payload, *, wire_version=OBSERVATION_VERSION):
    resolved, errors, metadata = deepcopy(payload), [], []
    if type(wire_version) is not int or wire_version not in {1, 2, 3}:
        return {}, [{"code": "verification_source_wire_version_invalid"}], metadata
    try: validate_catalogue(text, catalogue)
    except (ValueError, TypeError, KeyError):
        return {}, [{"code": "verification_source_catalogue_invalid"}], metadata
    sources = catalogue["sources"]
    positions = {item["source_id"]: index for index, item in enumerate(sources)}
    for location, support in _supports(resolved):
        if not isinstance(support, dict): continue
        first, last = support.get("source_id"), support.get("end_source_id")
        result_support = location.endswith(("/selected_endpoint_result", "/target_result"))
        if "source_id" not in support or any(name in support for name in ("quote", "source_location", "source_range")):
            support["source_reference_invalid"] = True
            errors.append({"code": "verification_source_reference_invalid", "path": location})
            continue
        if first is None and last is None:
            support.pop("source_id"); support.pop("end_source_id", None)
            support.update(quote="", source_location="")
            if result_support: support["source_range"] = None
            continue
        if not isinstance(first, str) or (last is not None and not isinstance(last, str)):
            errors.append({"code": "verification_source_reference_invalid", "path": location}); continue
        last = first if last is None else last
        if first not in positions or last not in positions or positions[first] > positions[last]:
            errors.append({"code": "verification_source_id_unknown", "path": location}); continue
        begin, finish = sources[positions[first]], sources[positions[last]]
        start, end = begin["start"], finish["end"]
        if end - start > MAX_SPAN_CHARS or (start < catalogue["body_end"] < end):
            errors.append({"code": "verification_source_range_invalid", "path": location}); continue
        quote = text[start:end]
        support.pop("source_id"); support.pop("end_source_id", None)
        source_location = begin["source_location"] if first == last else (
            f"{begin['source_location']} through characters {end}")
        support.update(quote=quote, source_location=source_location)
        if result_support:
            support["source_range"] = {"catalogue_sha256": _digest(catalogue),
                "checked_source_sha256": catalogue["checked_source_sha256"],
                "source_id": first, "end_source_id": last, "start": start, "end": end,
                "start_byte": begin["start_byte"], "end_byte": finish["end_byte"], "text_sha256": _hash(quote)}
        metadata.append({"path": location, "source_id": first, "end_source_id": last,
            "start": start, "end": end, "start_byte": begin["start_byte"], "end_byte": finish["end_byte"],
            "text_sha256": _hash(quote), "source_location": source_location})
    if wire_version == 3:
        _materialize_component_sources(resolved, text, errors, metadata)
    return resolved, errors, metadata


def _read_source_record(project, record):
    from new_meta.core.primary_analysis_alignment import _read_scoped
    from new_meta.core.llm import parse_source_json
    if not isinstance(record, dict) or set(record) != {"path", "sha256"}:
        raise ValueError("Extraction source record reference is invalid")
    if (not isinstance(record["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", record["sha256"])
            or record["path"] not in {f"extraction/verification/{kind}/{record['sha256']}.json"
                                     for kind in ("raw", "sources", "resolved")}):
        raise ValueError("Extraction source record path is invalid")
    data = _read_scoped(project, record["path"], max_bytes=4 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise ValueError("Extraction source record was changed")
    return parse_source_json(data.decode("utf-8"))


def validate_review_endpoint_sources(project, proof, assessment, source_text):
    """Human review selects real current ranges too; matching invented IDs is insufficient."""
    if proof.source_reference is None:
        from new_meta.schemas.study import ExtractionRowVerificationV3
        previous = proof.assessment.verification
        previous_span = previous.selected_endpoint_result.source_range if isinstance(previous, ExtractionRowVerificationV3) else None
        if previous_span is not None:
            try:
                catalogue = _read_source_record(project, {"path":
                    f"extraction/verification/sources/{previous_span.catalogue_sha256}.json",
                    "sha256": previous_span.catalogue_sha256})
            except FileNotFoundError:
                # Direct quoted contexts predate saved source catalogues. Only
                # their exactly reproducible default catalogue is compatible.
                catalogue = source_catalogue(source_text, proof.source_sha256)
                if _digest(catalogue) != previous_span.catalogue_sha256:
                    raise ValueError("Review requires the original endpoint source catalogue")
        else:
            catalogue = source_catalogue(source_text, proof.source_sha256)
    else:
        record = _read_source_record(project, proof.source_reference.model_dump(mode="json"))
        raw = _read_source_record(project, record["raw_record"])
        if (raw.get("source_sha256") != proof.source_sha256
                or raw.get("checked_source_sha256") != proof.checked_source_sha256
                or raw.get("protocol_sha256") != proof.protocol_sha256
                or raw.get("row_sha256", {}).get(str(proof.assessment.outcome_index)) != proof.row_sha256):
            raise ValueError("Review source catalogue belongs to different verified inputs")
        catalogue = _read_source_record(project, raw["catalogue"])
    validate_catalogue(source_text, catalogue)
    if catalogue["source_sha256"] != proof.source_sha256:
        raise ValueError("Review source catalogue belongs to a different document")
    details = assessment.verification
    supports = [details.selected_endpoint_result, *(item.target_result for item in details.component_bindings)]
    def reference(support):
        span = support.source_range
        if span is None:
            raise ValueError("Review endpoint result has no source identity")
        return {"source_id": span.source_id, "end_source_id": span.end_source_id}
    wire = {"primary_analysis_alignment": [{"verification": {
        "selected_endpoint_result": reference(supports[0]),
        "component_bindings": [{"target_result": reference(support)} for support in supports[1:]],
    }}]}
    resolved, errors, _ = resolve_reference_payload(source_text, catalogue, wire)
    if errors:
        raise ValueError("Review endpoint source references are invalid")
    resolved_details = resolved["primary_analysis_alignment"][0]["verification"]
    expected = [resolved_details["selected_endpoint_result"],
                *(item["target_result"] for item in resolved_details["component_bindings"])]
    if expected != [support.model_dump(mode="json") for support in supports]:
        raise ValueError("Review endpoint source identity does not match the original catalogue")


def replay_source_receipt(project, reference, source_text, source_sha, protocol_sha, row_sha, index, assessment,
                          *, expected_version=OBSERVATION_VERSION):
    """New proofs require the exact durable provider response and its resolution."""
    from new_meta.core.primary_analysis_alignment import digest
    from new_meta.core.llm import parse_source_json
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult, LegacyExtractionCheckResult
    from new_meta.schemas.study import ExtractionRowVerificationV3
    def read(record):
        return _read_source_record(project, record)
    record = read(reference)
    if (type(expected_version) is not int or expected_version not in {1, 2, 3}
            or not isinstance(record, dict) or type(record.get("version")) is not int or record.get("version") != expected_version
            or "raw_record" not in record or any(error.get("outcome_index") in {None, index}
                or error.get("code", "").startswith("verification_") for error in record.get("errors", []))):
        raise ValueError("Extraction source resolution is incomplete")
    raw = read(record["raw_record"])
    if (not isinstance(raw, dict) or type(raw.get("version")) is not int or raw.get("version") != expected_version
            or not isinstance(raw.get("raw_response"), dict) or "catalogue" not in raw
            or type(raw["raw_response"].get("provider_response_ordinal")) is not int
            or raw["raw_response"]["provider_response_ordinal"] < 1
            or raw.get("source_sha256") != source_sha or raw.get("checked_source_sha256") != _hash(source_text)
            or raw.get("protocol_sha256") != protocol_sha or raw.get("row_sha256", {}).get(str(index)) != row_sha
            or raw.get("raw_response", {}).get("finish_reason") not in {"stop", "completed"}):
        raise ValueError("Extraction source response belongs to different inputs or is incomplete")
    catalogue = read(raw["catalogue"])
    if catalogue.get("source_sha256") != source_sha:
        raise ValueError("Extraction source catalogue belongs to a different document")
    payload = parse_source_json(raw["raw_response"]["content"])
    resolved, errors, metadata = resolve_reference_payload(source_text, catalogue, payload, wire_version=expected_version)
    if errors or record.get("resolution") != metadata or record.get("resolved_response") != resolved:
        raise ValueError("Extraction source resolution cannot be replayed")
    schema = ExtractionCheckResult if expected_version >= 2 else LegacyExtractionCheckResult
    checked = schema.model_validate(resolved, strict=True)
    if expected_version == 1 and any(isinstance(item.verification, ExtractionRowVerificationV3)
                                   for item in checked.primary_analysis_alignment):
        raise ValueError("A current endpoint judgment cannot use a legacy source receipt")
    matches = [item for item in checked.primary_analysis_alignment if item.outcome_index == index]
    if len(matches) != 1 or digest(matches[0].model_dump(mode="json")) != digest(assessment.model_dump(mode="json")):
        raise ValueError("Extraction source response does not reproduce the stored judgment")
    if expected_version >= 2:
        from new_meta.core.extraction_verification import endpoint_binding_errors
        details = matches[0].verification
        if endpoint_binding_errors(details, source_text) or any(endpoint_binding_errors(details, source_text, component)
                for component in range(len(details.components))):
            raise ValueError("Extraction component membership cannot be replayed")
        if sorted(binding.component_index for binding in details.component_bindings) != list(range(len(details.components))):
            raise ValueError("Extraction component membership coverage cannot be replayed")
    return record
