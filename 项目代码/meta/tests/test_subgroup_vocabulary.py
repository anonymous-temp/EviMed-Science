"""The protocol's subgroup variables become a closed vocabulary before extraction.

Production job meta-20260928185649 (ma-001, 2026-09-28) prespecified "Route of
tranexamic acid administration (intravenous vs topical vs combined)"; the
engine grouped contrasts by their free-text labels and two trials giving the
same topical route were two one-study labels. The values are now derived once
per protocol by one model call, checked by code, and every extracted row is
assigned one value per variable; anything outside the vocabulary is refused.
No test here calls a model: the model's answers are supplied.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from new_meta.core.llm_retry import FAILURES_FILE, FAILURES_SUBDIR
from new_meta.core.project import Project
from new_meta.core.subgroup_vocabulary import (
    NOT_RUN_CONSEQUENCE,
    SubgroupVocabularyProposal,
    SubgroupVocabularyRefused,
    admit_subgroup_values,
    engine_subgroup_variables,
    ensure_subgroup_vocabulary,
    extraction_prompt_block,
    load_subgroup_vocabulary,
    validated_vocabulary,
    variable_ids,
)
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics

ROUTE = "Route of tranexamic acid administration (intravenous vs topical vs combined)"
ROUTE_ID = "route_of_tranexamic_acid_administration"


def _protocol(subgroups=(ROUTE,)) -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does tranexamic acid reduce total blood loss in primary total knee arthroplasty?",
        pico=PICO(population="Adults undergoing primary unilateral total knee arthroplasty.",
                  intervention="Tranexamic acid administered intravenously, topically (intra-articular), or by combined routes.",
                  comparator="Placebo or no tranexamic acid.",
                  outcome_primary="Total blood loss, measured in millilitres (mL)."),
        review_family="intervention_rct", effect_measure="MD", primary_outcome_type="continuous",
        subgroup_variables=list(subgroups),
    )


def _route_proposal(**changes) -> dict:
    values = [
        {"value": "intravenous", "definition": "Tranexamic acid given only intravenously."},
        {"value": "topical", "definition": "Tranexamic acid given only topically or intra-articularly."},
        {"value": "combined", "definition": "Tranexamic acid given both intravenously and topically."},
    ]
    variable = {"protocol_text": ROUTE, "values": values}
    variable.update(changes)
    return {"variables": [variable]}


def test_variable_ids_are_code_assigned_stable_and_unique():
    texts = [ROUTE, "给药途径", ROUTE + " at 24 hours", "5 mg or 10 mg dose"]
    ids = variable_ids(texts)
    assert ids == variable_ids(texts)
    assert ids[0] == ROUTE_ID
    assert ids[1] == "subgroup_2"
    assert len(set(ids)) == 4 and ids[2] == f"{ROUTE_ID}_2"
    assert ids[3].startswith("subgroup_")


def test_a_valid_proposal_is_closed_with_not_reported_appended_by_code():
    vocabulary = validated_vocabulary(_route_proposal(), _protocol())
    [route] = vocabulary.variables
    assert route.variable_id == ROUTE_ID and route.protocol_text == ROUTE
    assert route.value_tokens == ["intravenous", "topical", "combined", "not_reported"]
    assert vocabulary.status == "derived"


@pytest.mark.parametrize("proposal", [
    {"variables": []},                                                     # the protocol variable is missing
    _route_proposal(protocol_text="Route of TXA administration"),          # paraphrased, not verbatim
    {"variables": _route_proposal()["variables"] * 2},                     # the same variable twice
    {"variables": _route_proposal()["variables"] + [
        {**_route_proposal()["variables"][0], "protocol_text": "Dose"}]},  # not a protocol variable
    _route_proposal(values=[{"value": "topical", "definition": "Topical."}]),  # fewer than 2 values
    _route_proposal(values=[{"value": f"v{i}", "definition": "x"} for i in range(9)]),  # more than 8
    _route_proposal(values=[{"value": "intra articular (topical)", "definition": "x"},
                            {"value": "intravenous", "definition": "y"}]),  # not a token
    _route_proposal(values=[{"value": "not_reported", "definition": "x"},
                            {"value": "topical", "definition": "y"}]),      # the reserved value
    _route_proposal(values=[{"value": "topical", "definition": "x"},
                            {"value": "Topical", "definition": "y"}]),      # a duplicate value
    _route_proposal(values=[{"value": "topical", "definition": ""},
                            {"value": "intravenous", "definition": "y"}]),  # no definition
    _route_proposal(values=[{"value": "topical", "definition": "two\nlines"},
                            {"value": "intravenous", "definition": "y"}]),  # not one line
])
def test_a_proposal_breaking_a_checkable_rule_is_refused(proposal):
    with pytest.raises(ValueError):
        validated_vocabulary(proposal, _protocol())


def test_an_unusable_answer_is_asked_again_with_the_form_held_more_strictly(tmp_path: Path):
    project = Project("vocabulary retry", output_dir=tmp_path)
    prompts = []
    answers = [_route_proposal(values=[{"value": "topical", "definition": "Topical."}]), _route_proposal()]

    def ask(prompt, schema):
        assert schema is SubgroupVocabularyProposal
        prompts.append(prompt)
        return schema.model_validate(answers[len(prompts) - 1])

    vocabulary = ensure_subgroup_vocabulary(project, _protocol(), ask)
    assert vocabulary is not None and len(prompts) == 2
    assert ROUTE in prompts[0] and "could not be used" not in prompts[0]
    assert "could not be used" in prompts[1]
    saved = project.load_json("subgroup_vocabulary.json", subdir="extraction")
    assert saved["status"] == "derived" and saved["variables"][0]["variable_id"] == ROUTE_ID
    assert not (project.base_dir / FAILURES_SUBDIR / FAILURES_FILE).exists()


def test_exhausted_attempts_record_the_failure_and_leave_no_vocabulary(tmp_path: Path):
    project = Project("vocabulary exhausted", output_dir=tmp_path)
    calls = []

    def ask(prompt, schema):
        calls.append(prompt)
        raise SubgroupVocabularyRefused("still unusable")

    assert ensure_subgroup_vocabulary(project, _protocol(), ask) is None
    assert len(calls) == 3
    failures = json.loads((project.base_dir / FAILURES_SUBDIR / FAILURES_FILE).read_text())["failures"]
    assert [(item["stage"], item["consequence"]) for item in failures] == [
        ("subgroup_vocabulary", "subgroup analysis not run: no closed subgroup values")]
    saved = project.load_json("subgroup_vocabulary.json", subdir="extraction")
    assert saved["status"] == "unavailable" and saved["reason"] == NOT_RUN_CONSEQUENCE
    assert load_subgroup_vocabulary(project, _protocol()) is None
    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "model_output_unusable")
    assert "subgroup analysis not run" in warning["message"]
    # With no vocabulary the engine is told every variable has no closed values.
    assert engine_subgroup_variables(_protocol(), None) == [
        {"variable_id": ROUTE_ID, "label": ROUTE, "values": []}]


def test_no_prespecified_subgroup_means_no_model_call(tmp_path: Path):
    project = Project("no subgroups", output_dir=tmp_path)

    def ask(prompt, schema):  # pragma: no cover - must not be called
        raise AssertionError("no subgroup variables, no call")

    assert ensure_subgroup_vocabulary(project, _protocol(subgroups=()), ask) is None
    assert project.load_json("subgroup_vocabulary.json", subdir="extraction") is None
    assert extraction_prompt_block(None) == "None. Leave subgroup_values empty."


def test_the_vocabulary_is_reused_for_its_protocol_and_derived_again_for_a_changed_one(tmp_path: Path):
    project = Project("vocabulary resume", output_dir=tmp_path)
    calls = []

    def ask(prompt, schema):
        calls.append(prompt)
        text = ROUTE if "Dose of" not in prompt else "Dose of tranexamic acid (low vs high)"
        proposal = _route_proposal(protocol_text=text)
        return schema.model_validate(proposal)

    first = ensure_subgroup_vocabulary(project, _protocol(), ask)
    again = ensure_subgroup_vocabulary(project, _protocol(), ask)
    assert first == again and len(calls) == 1
    changed = ensure_subgroup_vocabulary(project, _protocol(subgroups=("Dose of tranexamic acid (low vs high)",)), ask)
    assert len(calls) == 2 and changed.variables[0].protocol_text == "Dose of tranexamic acid (low vs high)"
    assert load_subgroup_vocabulary(project, _protocol()) is None


def test_admission_keeps_in_vocabulary_values_and_refuses_the_rest():
    vocabulary = validated_vocabulary(_route_proposal(), _protocol())
    kept, refused = admit_subgroup_values(
        {ROUTE_ID: "topical", "dose": "high", "other": 3}, vocabulary)
    assert kept == {ROUTE_ID: "topical"}
    assert {item["reason"] for item in refused} == {"unknown_variable", "malformed"}
    kept, refused = admit_subgroup_values({ROUTE_ID: "intra_articular"}, vocabulary)
    assert kept == {} and refused == [
        {"variable_id": ROUTE_ID, "value": "intra_articular", "reason": "value_outside_vocabulary"}]
    assert admit_subgroup_values({ROUTE_ID: "topical"}, None) == (
        {}, [{"variable_id": ROUTE_ID, "value": "topical", "reason": "unknown_variable"}])


def test_the_schema_holds_the_form_and_omits_empty_values_from_every_dump():
    row = OutcomeData(subgroup_values={"Route_Of": " Not Reported ", "dose": "Intra-articular"})
    assert row.subgroup_values == {"route_of": "not_reported", "dose": "intra_articular"}
    assert "subgroup_values" not in OutcomeData().model_dump()
    assert "subgroup_values" not in OutcomeData().model_dump_json()
    assert OutcomeData(subgroup_values=["topical"]).subgroup_values == {}


SOURCE = "Total blood loss was 921 ± 252 mL with topical TXA versus 1131 ± 336 mL with placebo."


def test_extraction_lists_the_closed_values_and_refuses_what_is_outside_them(tmp_path: Path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, OutcomeList

    protocol = _protocol()
    vocabulary = validated_vocabulary(_route_proposal(), protocol)
    agent = DataExtractionAgent()
    prompts = []
    rows = [
        {"outcome_name": "Total blood loss (mL)", "outcome_type": "continuous", "comparative_design": "multi_arm_rct",
         "treatment_arm": "Topical TXA 3 g", "reference_arm": "Placebo", "source_quote": SOURCE,
         "subgroup_values": {ROUTE_ID: "Topical"}},
        {"outcome_name": "Total blood loss (mL)", "outcome_type": "continuous", "comparative_design": "multi_arm_rct",
         "treatment_arm": "IV TXA 1 g", "reference_arm": "Placebo", "source_quote": SOURCE,
         "subgroup_values": {ROUTE_ID: "intra_articular", "dose": "high_dose"}},
    ]

    def extract(prompt, schema, _identity):
        prompts.append(prompt)
        if schema is OutcomeList:
            return OutcomeList.model_validate({"outcomes": rows})
        return StudyCharacteristics(study_id="29410968", pmid="29410968", title="Three-arm TXA trial")

    monkeypatch.setattr(agent, "_extract_with_retry", extract)
    project = Project("closed extraction", output_dir=tmp_path)
    study = agent._extract_single({"pmid": "29410968"}, {"full_text": SOURCE}, protocol, project,
                                  subgroup_vocabulary=vocabulary)
    assert "## Closed Subgroup Values" in prompts[1]
    assert f'- {ROUTE_ID} ("{ROUTE}"):' in prompts[1] and "    - not_reported:" in prompts[1]
    assert study.outcomes[0].subgroup_values == {ROUTE_ID: "topical"}
    assert study.outcomes[1].subgroup_values == {}
    assert sorted((item["row_id"], item["reason"]) for item in agent.subgroup_value_refusals) == [
        ("29410968:1", "unknown_variable"), ("29410968:1", "value_outside_vocabulary")]
    saved = ExtractedStudy.model_validate(project.load_json("29410968.json", subdir="extraction"))
    assert [row.subgroup_values for row in saved.outcomes] == [{ROUTE_ID: "topical"}, {}]


def test_without_a_vocabulary_the_prompt_asks_for_no_values_and_none_are_kept(tmp_path: Path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, OutcomeList

    agent = DataExtractionAgent()
    prompts = []

    def extract(prompt, schema, _identity):
        prompts.append(prompt)
        if schema is OutcomeList:
            return OutcomeList.model_validate({"outcomes": [{
                "outcome_name": "Total blood loss (mL)", "outcome_type": "continuous", "comparative_design": "",
                "source_quote": SOURCE, "subgroup_values": {ROUTE_ID: "topical"}}]})
        return StudyCharacteristics(study_id="S1", pmid="S1", title="Trial")

    monkeypatch.setattr(agent, "_extract_with_retry", extract)
    study = agent._extract_single({"pmid": "S1"}, {"full_text": SOURCE}, _protocol(),
                                  Project("no vocabulary", output_dir=tmp_path))
    assert "## Closed Subgroup Values\nNone. Leave subgroup_values empty." in prompts[1]
    assert study.outcomes[0].subgroup_values == {}


def test_run_derives_the_vocabulary_first_and_the_audit_counts_refusals(tmp_path: Path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from test_extraction_ledger_migration import _study

    project = Project("run with closed subgroups", output_dir=tmp_path / "project")
    pdf = tmp_path / "trial.pdf"
    pdf.write_bytes(b"primary report bytes")
    study = _study(pdf)
    agent = DataExtractionAgent()
    seen = {}

    def structured(prompt, schema, **_):
        assert schema is SubgroupVocabularyProposal
        return schema.model_validate(_route_proposal())

    def extract_single(paper, parsed, protocol, project, *, subgroup_vocabulary=None):
        seen["vocabulary"] = subgroup_vocabulary
        agent._admit_subgroup_values(study, subgroup_vocabulary, "12345")
        return study

    study.outcomes[0].subgroup_values = {ROUTE_ID: "subcutaneous"}
    monkeypatch.setattr(agent, "call_llm_structured", structured)
    monkeypatch.setattr(agent, "_extract_single", extract_single)
    monkeypatch.setattr(agent, "_check_extraction", lambda *_: ExtractionCheckResult(data_issues=[], score=9))
    agent.run([{"pmid": "12345", "title": "Primary randomized trial"}],
              {"12345": {"full_text": "Mortality was 10/100 versus 20/100."}}, _protocol(), project)

    assert [item.variable_id for item in seen["vocabulary"].variables] == [ROUTE_ID]
    audit = project.load_json("extraction_audit.json", subdir="extraction")
    assert audit["summary"]["subgroup_vocabulary"] == "derived"
    assert audit["summary"]["subgroup_values_refused"] == 1
    assert audit["subgroup_value_refusals"][0]["reason"] == "value_outside_vocabulary"
    assert project.load_json("subgroup_vocabulary.json", subdir="extraction")["status"] == "derived"
