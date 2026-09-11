import json

import pytest
from pydantic import ValidationError

from new_meta.agents.research_planner import ResearchPlanner
from new_meta.schemas.protocol import PICO, ResearchProtocol


@pytest.fixture(autouse=True)
def independent_scope_stub(monkeypatch):
    # These tests isolate numeric/schema planning; scope semantics have their own suite.
    from new_meta.core.protocol_scope import scope_receipt
    from tests.test_protocol_scope import assessment
    monkeypatch.setattr(ResearchPlanner, "check_scope", lambda self, topic, protocol:
                        scope_receipt(topic, protocol, assessment(protocol, topic=topic)))


def test_research_planner_forces_hr_for_hfpef_composite_time_to_event_endpoint(monkeypatch) -> None:
    planner = ResearchPlanner()

    def fake_structured(*args, **kwargs):
        return ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in HFpEF?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="RR",
        )

    monkeypatch.setattr(planner, "call_llm_structured", fake_structured)

    protocol = planner.run(
        "SGLT2 inhibitors versus placebo for cardiovascular death or hospitalization for heart failure"
    )

    assert protocol.effect_measure == "HR"


def test_research_planner_keeps_rr_for_plain_binary_mortality_endpoint(monkeypatch) -> None:
    planner = ResearchPlanner()

    def fake_structured(*args, **kwargs):
        return ResearchProtocol(
            research_question="Do corticosteroids reduce 28-day mortality?",
            pico=PICO(
                population="Critically ill adults",
                intervention="Corticosteroids",
                comparator="Usual care",
                outcome_primary="28-day all-cause mortality",
            ),
            effect_measure="RR",
        )

    monkeypatch.setattr(planner, "call_llm_structured", fake_structured)

    protocol = planner.run("Corticosteroids versus usual care for 28-day all-cause mortality")

    assert protocol.effect_measure == "RR"


def test_research_planner_forces_hr_for_explicit_survival_endpoint() -> None:
    protocol = ResearchProtocol(
        research_question="Does treatment improve progression-free survival?",
        pico=PICO(
            population="Adults with cancer",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="progression-free survival",
        ),
        effect_measure="RR",
    )

    ResearchPlanner._apply_effect_measure_rules(protocol)

    assert protocol.effect_measure == "HR"



def _typed_protocol_payload(outcome_type):
    return {
        "research_question": "SGLT2 inhibitors versus placebo for chronic kidney disease progression",
        "pico": {"population": "Adults with CKD", "intervention": "SGLT2 inhibitors", "comparator": "Placebo", "outcome_primary": "Composite kidney disease progression"},
        "review_family": "intervention_rct", "effect_measure": "RR", "primary_outcome_type": outcome_type,
    }


@pytest.mark.parametrize("outcome_type", ["dichotomous_composite_renal_outcome", "continuous_kidney_function", "unknown", "binary_or_survival", "???", None, 2])
def test_protocol_rejects_invented_outcome_type_tags(outcome_type):
    with pytest.raises(ValidationError, match="primary_outcome_type"):
        ResearchProtocol.model_validate(_typed_protocol_payload(outcome_type))


@pytest.mark.parametrize("alias, canonical", [
    ("binary", "dichotomous"), ("categorical", "dichotomous"),
    ("survival", "time_to_event"), ("time-event", "time_to_event"),
    (" TIME-TO-EVENT ", "time_to_event"), ("incidence", "incidence_rate"),
    ("overall", "overall_performance"), ("  ", ""),
])
def test_protocol_preserves_existing_exact_outcome_type_aliases(alias, canonical):
    protocol = ResearchProtocol.model_validate(_typed_protocol_payload(alias))
    assert protocol.primary_outcome_type == canonical


def test_protocol_schema_covers_all_registered_method_outcome_types():
    from new_meta.core.method_registry import default_method_registry

    registry = default_method_registry()
    expected = {value for family in registry.families() for value in registry.plugin(family).supported_outcome_types}
    expected.discard("binary")  # Existing exact alias for dichotomous.
    enum = ResearchProtocol.model_json_schema()["properties"]["primary_outcome_type"]["enum"]
    assert set(enum) == expected | {""}
    for outcome_type in enum:
        assert ResearchProtocol.model_validate(_typed_protocol_payload(outcome_type)).primary_outcome_type == outcome_type


def test_actual_invalid_protocol_type_uses_existing_structured_model_repair(monkeypatch, tmp_path):
    import new_meta.core.llm as llm_module
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.project import Project

    monkeypatch.setattr(llm_module, "LLM_JSON_REPAIR_RETRIES", 1)
    planner = ResearchPlanner()
    invalid = _typed_protocol_payload("dichotomous_composite_renal_outcome")
    corrected = _typed_protocol_payload("dichotomous")
    responses = iter([json.dumps(invalid), json.dumps(corrected)])
    calls = []

    def fake_call(**kwargs):
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(planner.llm, "_call", fake_call)
    protocol = planner.run(invalid["research_question"])
    assert len(calls) == 2
    repair_prompt = calls[1]["messages"][-1]["content"]
    assert "primary_outcome_type" in repair_prompt
    assert "dichotomous_composite_renal_outcome" in repair_prompt
    assert "literal_error" in repair_prompt
    assert protocol.primary_outcome_type == "dichotomous"
    assert protocol.pico.outcome_primary == invalid["pico"]["outcome_primary"]
    plan = compile_project_method_plan(Project("protocol repair", output_dir=tmp_path), protocol)
    assert plan.outcome_type == "dichotomous"



def test_valid_type_for_wrong_review_family_still_fails_method_compilation(tmp_path):
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.method_registry import MethodCompilationError
    from new_meta.core.project import Project

    protocol = ResearchProtocol.model_validate(_typed_protocol_payload("diagnostic_accuracy"))
    with pytest.raises(MethodCompilationError, match="not supported by intervention_rct"):
        compile_project_method_plan(Project("wrong family", output_dir=tmp_path), protocol)
