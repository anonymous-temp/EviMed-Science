"""Exact batch feedback for the observed extra indexed-child failure."""
import json
from pathlib import Path

import pytest

from new_meta.agents.research_planner import ResearchPlanner
from new_meta.core.method_planning import ProtocolInputRequired
from new_meta.core.protocol_scope import scope_fields
from new_meta.core.protocol_scope_sources import evaluate_scope_references, replay_scope_sources, source_catalogue
from new_meta.schemas.protocol import ResearchProtocol
from tests.test_protocol_scope import TOPIC, batch_assessment, proposal, scope_response_mock
from tests.test_protocol_scope_sources import reference_rows


@pytest.fixture
def saved_case():
    return json.loads((Path(__file__).parent / "fixtures/protocol_scope_extra_indexed_child.json").read_text())


def test_actual_saved_extra_child_has_precise_feedback_and_is_still_rejected(saved_case):
    protocol = ResearchProtocol.model_validate(saved_case["proposal"])
    assert protocol.pico.outcomes_secondary == protocol.subgroup_variables == []
    catalogue = source_catalogue(saved_case["topic"], protocol)
    assert saved_case["expected_fields"][-1] == "study_designs"
    for actual in saved_case["actual_responses"]:
        reviewed = evaluate_scope_references(saved_case["topic"], catalogue, actual, saved_case["expected_fields"])
        assert reviewed.reason["code"] == "scope_field_coverage_invalid"
        assert reviewed.reason["expected_count"] == 8 and reviewed.reason["observed_count"] == 9
        assert reviewed.reason["unexpected_fields"] == ["study_designs[0]"]
        assert reviewed.reason["missing_fields"] == reviewed.reason["duplicate_fields"] == []
        assert 'Remove unexpected fields: "study_designs[0]"' in reviewed.reason["message"]
        assert len(reviewed.resolved.fields) == 9  # The evaluator never silently filters the extra row.


def test_same_batch_corrective_retry_names_extra_child_and_full_receipt_replays(saved_case, monkeypatch):
    protocol = ResearchProtocol.model_validate(saved_case["proposal"])
    planner = ResearchPlanner()
    prompts = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        prompts.append(messages[1]["content"])
        if len(prompts) == 1:
            return saved_case["actual_responses"][0]
        # The second and later responses simulate a corrected model response, not gate filtering.
        return batch_assessment(messages, protocol, topic=saved_case["topic"])

    monkeypatch.setattr(planner.llm, "structured_output", check)
    receipt = planner.check_scope(saved_case["topic"], protocol)
    assert "Return exactly 8 rows" in prompts[0]
    assert "one row for the entire list" in prompts[0]
    assert "only if that literal indexed key is listed in this batch" in prompts[0]
    assert 'Remove unexpected fields: \\"study_designs[0]\\"' in prompts[1]
    assert '"expected_count": 8' in prompts[1] and '"observed_count": 9' in prompts[1]
    assert len(receipt["assessment"]["fields"]) == len(scope_fields(protocol))
    assert replay_scope_sources(saved_case["topic"], protocol, receipt["source_provenance"]).model_dump(mode="json") == receipt["assessment"]


def test_repeated_extra_child_is_not_accepted(saved_case, monkeypatch):
    protocol = ResearchProtocol.model_validate(saved_case["proposal"])
    planner = ResearchPlanner()
    responses = iter(saved_case["actual_responses"])
    monkeypatch.setattr(planner.llm, "structured_output", scope_response_mock(lambda *args, **kwargs: next(responses)))
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(saved_case["topic"], protocol)
    assert caught.value.phase.error_code == "protocol_scope_unverified"
    assert len(caught.value.phase.data["scope_check_attempts"]) == 2
    assert protocol._scope_receipt == {}


@pytest.mark.parametrize("damage", ["missing", "duplicate", "list_field", "dict_field", "nonobject_row"])
def test_generic_coverage_feedback_handles_missing_duplicate_and_unhashable_fields(damage):
    protocol = proposal()
    catalogue = source_catalogue(TOPIC, protocol)
    expected = ["pico.population", "pico.comparator"]
    response = reference_rows(catalogue, expected).model_dump(mode="json")
    if damage == "missing": response["fields"].pop()
    if damage == "duplicate": response["fields"].append(dict(response["fields"][0]))
    if damage == "list_field": response["fields"][0]["field"] = ["pico.population"]
    if damage == "dict_field": response["fields"][0]["field"] = {"field": "pico.population"}
    if damage == "nonobject_row": response["fields"][0] = []
    reason = evaluate_scope_references(TOPIC, catalogue, response, expected).reason
    assert reason["code"] == "scope_field_coverage_invalid"
    assert reason["expected_count"] == 2 and reason["observed_count"] == len(response["fields"])
    if damage == "duplicate": assert reason["duplicate_fields"] == ["pico.population"]
    elif damage == "missing": assert reason["missing_fields"] == ["pico.comparator"]
    else:
        assert reason["missing_fields"] == ["pico.population"]
        assert reason["invalid_field_count"] == 1


def test_diagnostic_name_lists_are_bounded_without_changing_the_gate():
    protocol = proposal()
    catalogue = source_catalogue(TOPIC, protocol)
    response = reference_rows(catalogue, ["pico.population"]).model_dump(mode="json")
    for index in range(100):
        response["fields"].append({**response["fields"][0], "field": f"unexpected_{index:03}"})
    response["fields"].append({**response["fields"][0], "field": "x" * 100000})
    reason = evaluate_scope_references(TOPIC, catalogue, response, ["pico.population"]).reason
    assert reason["observed_count"] == 102
    assert len(reason["unexpected_fields"]) <= 8
    assert reason["unexpected_fields_omitted"] == 101 - len(reason["unexpected_fields"])
    assert len(json.dumps(reason)) < 4000
