"""Component excerpts come from bound references, never model retyping or repair."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from new_meta.core.extraction_sources import reference_schema, resolve_reference_payload, source_catalogue
from new_meta.core.extraction_verification import validate_check_batch
from new_meta.schemas.study import PrimaryAlignmentAssessment
from new_meta.agents.data_extraction_agent import ExtractionCheckResult
from test_extraction_verification import SOURCE, checked_row, protocol, study
from endpoint_binding_fixture import bind_components
from extraction_source_fixture import wire_payload


def case():
    evidence = json.loads((Path(__file__).parent / "fixtures/credence_component_label_observation.json").read_text())
    text = SOURCE + "\n" + evidence["support"]["quote"]
    row = bind_components(checked_row(), text)
    row["verification"]["components"][1] = evidence["component"]
    row["verification"]["component_bindings"][1]["support"] = evidence["support"]
    return text, row


def wire_without_labels(row, text):
    wire = wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]}, text)
    for component in wire["primary_analysis_alignment"][0]["verification"]["components"]:
        component.pop("source_component", None)
    return wire


def test_current_reference_schema_never_asks_model_to_retype_source_component():
    schema = reference_schema(ExtractionCheckResult.model_json_schema())
    fields = schema["$defs"]["EndpointComponentVerification"]["properties"]
    assert "source_component" not in fields
    assert "relation" in fields and "protocol_component" in fields


def test_actual_missing_the_label_is_preserved_by_old_contract_and_avoided_by_new_reference():
    text, row = case()
    parsed = PrimaryAlignmentAssessment.model_validate(row)
    assert any(e["code"] == "verification_component_label_not_anchored"
               for e in validate_check_batch(study(), [0], [parsed], text, protocol()))
    wire = wire_without_labels(row, text); before = deepcopy(wire)
    catalog = source_catalogue(text, hashlib.sha256(text.encode()).hexdigest())
    resolved, errors, metadata = resolve_reference_payload(text, catalog, wire)
    assert errors == [] and wire == before
    details = resolved["primary_analysis_alignment"][0]["verification"]
    assert details["components"][1]["source_component"] == "doubling of the serum creatinine level, or renal"
    assert details["components"][1]["relation"] == row["verification"]["components"][1]["relation"]
    assert details["components"][1]["protocol_component"] == row["verification"]["components"][1]["protocol_component"]
    assert details["component_bindings"][1]["rationale"] == row["verification"]["component_bindings"][1]["rationale"]
    checked = ExtractionCheckResult.model_validate(resolved, strict=True)
    assert validate_check_batch(study(), [0], checked.primary_analysis_alignment, text, protocol()) == []


def test_current_wire_rejects_model_supplied_label_without_overwriting_it():
    text, row = case(); wire = wire_without_labels(row, text)
    wire["primary_analysis_alignment"][0]["verification"]["components"][1]["source_component"] = "Untrusted replacement"
    before = deepcopy(wire)
    resolved, errors, _ = resolve_reference_payload(text, source_catalogue(text, hashlib.sha256(text.encode()).hexdigest()), wire)
    assert errors and wire == before
    assert resolved["primary_analysis_alignment"][0]["verification"]["components"][1]["source_component"] == "Untrusted replacement"


def test_new_outcome_and_refinement_wires_use_the_canonical_statistical_type():
    from new_meta.agents.data_extraction_agent import OutcomeList, ExtractionRefinement
    from new_meta.schemas.outcome_types import CANONICAL_EXTRACTION_OUTCOME_TYPES
    for schema in (OutcomeList, ExtractionRefinement):
        definitions = schema.model_json_schema()["$defs"]
        source = definitions.get("ExtractedOutcomeData", definitions.get("OutcomeData"))
        assert set(source["properties"]["outcome_type"].get("enum", [])) == set(CANONICAL_EXTRACTION_OUTCOME_TYPES)
        assert "outcome_type" in source["required"]
    bad = {"outcome_name": "A composite clinical endpoint", "outcome_type": "time_to_event_composite"}
    with pytest.raises(ValueError): OutcomeList.model_validate({"outcomes": [bad]})
    with pytest.raises(ValueError): ExtractionRefinement.model_validate({"outcomes": [{"outcome_index": 0, "outcome": bad}]})


@pytest.mark.parametrize("relation,membership", [("extra", "included_in_selected_endpoint"), ("missing", "absent_from_selected_endpoint")])
def test_reference_expansion_preserves_valid_component_negatives(relation, membership):
    from new_meta.core.extraction_observations import inspect_extraction_payload
    text, row = case(); details = row["verification"]
    details["components"][2]["relation"] = relation
    details["component_bindings"][2]["source_membership"] = membership
    wire = wire_without_labels(row, text); before = deepcopy(wire)
    resolved, errors, _ = resolve_reference_payload(text, source_catalogue(text, hashlib.sha256(text.encode()).hexdigest()), wire)
    assert errors == [] and wire == before
    result = inspect_extraction_payload(resolved, ExtractionCheckResult, study(), [0], text, protocol())
    negatives = [item for item in result["clinical_negatives"] if item.get("field") == "components"]
    assert len(negatives) == 1 and negatives[0]["component_index"] == 2
    component = resolved["primary_analysis_alignment"][0]["verification"]["components"][2]
    assert component["relation"] == relation
    assert component["source_component"] == (details["component_bindings"][2]["support"]["quote"] if relation == "extra" else "")


@pytest.mark.parametrize("damage", ["non_dict", "duplicate", "unknown_source", "supplied_label"])
def test_bad_sibling_cannot_conceal_valid_reference_component_negative(damage):
    from new_meta.core.extraction_observations import inspect_extraction_payload
    text, row = case(); row["verification"]["components"][2]["relation"] = "extra"
    wire = wire_without_labels(row, text); details = wire["primary_analysis_alignment"][0]["verification"]
    if damage == "non_dict": details["component_bindings"][0] = None
    elif damage == "duplicate": details["component_bindings"].append(deepcopy(details["component_bindings"][0]))
    elif damage == "unknown_source": details["component_bindings"][0]["support"]["source_id"] = "unknown-source"
    else: details["components"][0]["source_component"] = "Do not substitute this model value"
    before = deepcopy(wire)
    resolved, errors, _ = resolve_reference_payload(text, source_catalogue(text, hashlib.sha256(text.encode()).hexdigest()), wire)
    assert errors and wire == before
    result = inspect_extraction_payload(resolved, ExtractionCheckResult, study(), [0], text, protocol())
    assert [item["component_index"] for item in result["clinical_negatives"] if item.get("field") == "components"] == [2]


def test_other_endpoint_component_cannot_be_materialized_as_an_extra():
    from new_meta.core.extraction_observations import inspect_extraction_payload
    text, row = case(); details = row["verification"]
    details["components"][2]["relation"] = "extra"
    details["component_bindings"][2]["source_membership"] = "belongs_to_other_endpoint"
    wire = wire_without_labels(row, text)
    resolved, errors, _ = resolve_reference_payload(text, source_catalogue(text, hashlib.sha256(text.encode()).hexdigest()), wire)
    assert any(item["code"] == "verification_component_membership_inconsistent" for item in errors)
    assert "source_component" not in resolved["primary_analysis_alignment"][0]["verification"]["components"][2]
    inspected = inspect_extraction_payload(resolved, ExtractionCheckResult, study(), [0], text, protocol())
    assert inspected["clinical_negatives"] == []


def test_v2_label_transport_is_unchanged_and_does_not_accept_v3_omission():
    text, row = case()
    catalog = source_catalogue(text, hashlib.sha256(text.encode()).hexdigest())
    old_wire = wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]}, text, wire_version=2)
    resolved, errors, _ = resolve_reference_payload(text, catalog, old_wire, wire_version=2)
    assert errors == []
    assessment = PrimaryAlignmentAssessment.model_validate(resolved["primary_analysis_alignment"][0])
    assert assessment.verification.components[1].source_component == row["verification"]["components"][1]["source_component"]
    assert any(item["code"] == "verification_component_label_not_anchored" for item in validate_check_batch(study(), [0], [assessment], text, protocol()))
    new_wire = wire_without_labels(row, text)
    old_resolved, _, _ = resolve_reference_payload(text, catalog, new_wire, wire_version=2)
    old_assessment = PrimaryAlignmentAssessment.model_validate(old_resolved["primary_analysis_alignment"][0])
    assert validate_check_batch(study(), [0], [old_assessment], text, protocol())


@pytest.mark.parametrize("version", [True, "3", 3.0, 0, 4])
def test_reference_wire_version_is_explicit_and_strict(version):
    text, row = case(); wire = wire_without_labels(row, text)
    assert resolve_reference_payload(text, source_catalogue(text, hashlib.sha256(text.encode()).hexdigest()), wire, wire_version=version)[1]
    with pytest.raises(ValueError): reference_schema(ExtractionCheckResult.model_json_schema(), wire_version=version)
