"""A source description is not the canonical comparative-design contract."""

import pytest
from pydantic import ValidationError

from new_meta.agents.data_extraction_agent import (
    DataExtractionAgent,
    ExtractionCheckResult,
    ExtractionRefinement,
    OutcomeList,
)
from new_meta.core.method_planning import ProtocolInputRequired, admit_project_protocol
from new_meta.core.method_registry import default_method_registry
from new_meta.core.project import Project
from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
from new_meta.schemas.extracted_outcome import ExtractedOutcomeData
from new_meta.schemas.method_policy import ReviewFamily
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, ExtractionDataIssue, OutcomeData, StudyCharacteristics
from protocol_scope_fixture import approve_synthetic_protocol_scope


# Original provider responses 001/002 and 003/004 from the two-PDF diagnostic,
# before the legacy reconciler annotated their designs. The source below is a
# synthetic fixture; these descriptions are not manually normalized by tests.
PRODUCER_DESIGNS = [
    (
        "Randomized, double-blind, placebo-controlled, multicenter clinical trial (parallel RCT)",
        "Randomized placebo-controlled double-blind trial (parallel-group)",
    ),
    (
        "Multicenter, randomized, double-blind, placebo-controlled, parallel-group, phase III study (parallel RCT)",
        "parallel-group randomized controlled trial",
    ),
]
SOURCE = (
    "Adults were randomized individually to Drug or placebo in parallel groups. "
    "For disease progression the hazard ratio was 0.66 (95% CI 0.53 to 0.81)."
)


def _protocol():
    return ResearchProtocol(
        research_question="Drug versus placebo for disease progression in randomized trials",
        pico=PICO(population="Adults", intervention="Drug", comparator="Placebo",
                  outcome_primary="Disease progression"),
        review_family="intervention_rct", study_design="RCT", study_designs=["RCT"],
        primary_outcome_type="time_to_event", effect_measure="HR",
    )


def _row(design):
    return {
        "outcome_name": "Disease progression", "outcome_type": "time_to_event",
        "effect_size": 0.66, "ci_lower": 0.53, "ci_upper": 0.81,
        "reported_effect_measure": "HR", "reported_effect_scale": "original",
        "comparative_design": design, "treatment_arm": "Drug", "reference_arm": "Placebo",
        "source_quote": "For disease progression the hazard ratio was 0.66 (95% CI 0.53 to 0.81).",
        "source_location": "Results",
    }


def _parse_source(project, protocol, description, row, *, source=SOURCE):
    responses = iter([
        {"study_id": "S1", "study_design": description},
        {"outcomes": row if isinstance(row, list) else [row]},
    ])
    agent = object.__new__(DataExtractionAgent)
    agent.log = lambda *args, **kwargs: None
    agent._extract_with_retry = lambda prompt, schema, paper_id: schema.model_validate(next(responses))
    return agent._extract_single({"pmid": "123"}, {"full_text": source}, protocol, project)


def test_generated_design_is_required_and_uses_the_registry_vocabulary():
    schema = ExtractedOutcomeData.model_json_schema()
    allowed = set(schema["properties"]["comparative_design"]["enum"])
    assert "comparative_design" in schema["required"]
    assert allowed == set(default_method_registry().plugin(ReviewFamily.INTERVENTION_RCT).supported_designs) | {"", "unknown"}
    row = _row("parallel_rct")
    del row["comparative_design"]
    with pytest.raises(ValidationError):
        OutcomeList.model_validate({"outcomes": [row]})


@pytest.mark.parametrize("description,raw_design", PRODUCER_DESIGNS)
def test_original_descriptive_producer_requires_fresh_typed_extraction(tmp_path, description, raw_design):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    with pytest.raises(ValidationError):
        _parse_source(project, protocol, description, _row(raw_design))
    with pytest.raises(ValidationError):
        ExtractionRefinement.model_validate({"outcomes": [{"outcome_index": 0, "outcome": _row(raw_design)}]})
    # Loading an old record preserves its description, but cannot certify it as
    # a new canonical model response or silently admit it for quantitative work.
    study = ExtractedStudy(characteristics=StudyCharacteristics(study_design=description),
                           outcomes=[OutcomeData.model_validate(_row(raw_design))])
    agent = object.__new__(DataExtractionAgent)
    agent.log = lambda *args, **kwargs: None
    agent._validate_source_quotes(study, SOURCE, [])
    assert study.outcomes[0].source_quote_verified
    assert study.outcomes[0].comparative_design == raw_design
    project.save_json("all_extractions.json", [study], subdir="extraction")
    approve_synthetic_protocol_scope(project, protocol)
    with pytest.raises(ProtocolInputRequired, match="unknown|canonical|outside"):
        admit_project_protocol(project, protocol, enforce=True)


@pytest.mark.parametrize("description,_", PRODUCER_DESIGNS)
def test_fresh_canonical_producer_preserves_description_and_admitted_protocol(tmp_path, description, _):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    project.save_json("protocol.json", protocol)
    approve_synthetic_protocol_scope(project, protocol)
    admit_project_protocol(project, protocol, enforce=True)
    before = project.get_path("protocol.json").read_bytes()
    study = _parse_source(project, protocol, description, _row("parallel_rct"))
    assert study.outcomes[0].source_quote_verified

    reconcile_extracted_rct_designs(protocol, [study])
    project.save_json("all_extractions.json", [study], subdir="extraction")
    plan = admit_project_protocol(project, protocol, enforce=True)
    reloaded = ResearchProtocol.model_validate(project.load_json("protocol.json"))
    resumed_plan = admit_project_protocol(project, reloaded, enforce=True)

    assert plan.study_designs == ["parallel_rct"]
    assert plan.capability_id == "intervention_rct.parallel.standard"
    assert resumed_plan.plan_fingerprint == plan.plan_fingerprint
    assert study.characteristics.study_design == description
    assert project.get_path("protocol.json").read_bytes() == before


@pytest.mark.parametrize("design", ["", "unknown"])
def test_unknown_typed_design_does_not_inherit_randomization_from_description(tmp_path, design):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    study = _parse_source(project, protocol, PRODUCER_DESIGNS[0][0], _row(design))
    reconcile_extracted_rct_designs(protocol, [study])
    project.save_json("all_extractions.json", [study], subdir="extraction")
    approve_synthetic_protocol_scope(project, protocol)
    with pytest.raises(ProtocolInputRequired):
        admit_project_protocol(project, protocol, enforce=True)


@pytest.mark.parametrize("design", ["", "parallel_rct", "cluster_rct", "crossover_rct", "multi_arm_rct", "unknown"])
def test_refinement_uses_canonical_design_and_preserves_description(monkeypatch, design):
    current = ExtractedStudy(
        characteristics=StudyCharacteristics(study_design=PRODUCER_DESIGNS[0][0]),
        outcomes=[OutcomeData.model_validate(_row(PRODUCER_DESIGNS[0][1]))],
    )
    agent = object.__new__(DataExtractionAgent)
    agent.log = lambda *args, **kwargs: None
    monkeypatch.setattr(agent, "call_llm_structured", lambda prompt, schema, **kwargs:
                        schema.model_validate({"outcomes": [{"outcome_index": 0, "outcome": _row(design)}]}))
    result = agent._refine_extraction(SOURCE, current, ExtractionCheckResult(score=8, data_issues=[]), _protocol())
    assert result.outcomes[0].comparative_design == design
    assert result.characteristics == current.characteristics
    assert current.outcomes[0].comparative_design == PRODUCER_DESIGNS[0][1]


@pytest.mark.parametrize("design", ["cluster_rct", "crossover_rct", "multi_arm_rct"])
def test_specific_typed_dependencies_survive_descriptive_parallel_layout(tmp_path, design):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    methods = {
        "cluster_rct": "Clinics were randomized to parallel Drug or placebo arms with cluster-adjusted analysis. ",
        "crossover_rct": "Adults were randomized to Drug/placebo sequences with a paired crossover analysis. ",
        "multi_arm_rct": "Adults were randomized to Drug low, Drug high, or shared placebo arms. ",
    }
    source = methods[design] + _row(design)["source_quote"]
    study = _parse_source(project, protocol, PRODUCER_DESIGNS[0][0], _row(design), source=source)
    reconcile_extracted_rct_designs(protocol, [study])
    project.save_json("all_extractions.json", [study], subdir="extraction")
    approve_synthetic_protocol_scope(project, protocol)
    plan = admit_project_protocol(project, protocol, enforce=True)
    assert plan.study_designs == [design]
    assert plan.capability_id == "intervention_rct.complex_design"
    assert "design_adjustment_complete" in plan.hard_gates


def test_typed_parallel_contrasts_with_shared_arms_still_require_multi_arm_execution(tmp_path):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    rows = [{**_row("parallel_rct"), "treatment_arm": arm} for arm in ("Drug low", "Drug high")]
    source = (
        "Adults were randomized to Drug low, Drug high, or a shared placebo group. "
        "Both dose comparisons reported the same rounded estimate and interval. "
        + rows[0]["source_quote"]
    )
    study = _parse_source(project, protocol, PRODUCER_DESIGNS[0][0], rows, source=source)
    report = reconcile_extracted_rct_designs(protocol, [study])
    project.save_json("all_extractions.json", [study], subdir="extraction")
    approve_synthetic_protocol_scope(project, protocol)
    plan = admit_project_protocol(project, protocol, enforce=True)
    assert report["multi_arm_studies"] == ["123"]
    assert plan.study_designs == ["multi_arm_rct"]
    assert plan.capability_id == "intervention_rct.complex_design"
    assert all(not row.covariance_with for row in study.outcomes)


def test_existing_verifier_can_repair_a_source_anchored_design_defect():
    from new_meta.core.extraction_verification import validate_data_issues

    study = ExtractedStudy(outcomes=[OutcomeData.model_validate(_row("cluster_rct"))],
                           characteristics=StudyCharacteristics())
    issue = ExtractionDataIssue(outcome_index=0, field="comparative_design", kind="incorrect_metadata",
                                rationale="The source reports individual randomization, not cluster allocation.",
                                quote=SOURCE, source_location="Methods")
    errors = validate_data_issues(study, [0], [issue], SOURCE)
    assert len(errors) == 1
    assert errors[0]["field"] == "comparative_design"
    assert errors[0]["repairable"] is True


def test_invalid_refinement_never_replaces_a_legacy_design(monkeypatch):
    current = ExtractedStudy(characteristics=StudyCharacteristics(study_design=PRODUCER_DESIGNS[0][0]),
                             outcomes=[OutcomeData.model_validate(_row(PRODUCER_DESIGNS[0][1]))])
    before = current.model_dump(mode="json")
    agent = object.__new__(DataExtractionAgent)
    agent.log = lambda *args, **kwargs: None
    monkeypatch.setattr(agent, "call_llm_structured", lambda prompt, schema, **kwargs:
                        schema.model_validate({"outcomes": [{"outcome_index": 0, "outcome": _row("probably parallel")}]}))
    result = agent._refine_extraction(SOURCE, current, ExtractionCheckResult(score=8, data_issues=[]), _protocol())
    assert result.model_dump(mode="json") == before


@pytest.mark.parametrize("description", ["", PRODUCER_DESIGNS[0][0]])
@pytest.mark.parametrize("sibling_endpoint", ["Secondary endpoint", "Disease progression"])
def test_typed_sibling_cannot_supply_a_missing_primary_design(tmp_path, description, sibling_endpoint):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    approve_synthetic_protocol_scope(project, protocol)
    admit_project_protocol(project, protocol, enforce=True)  # A cached route is not row evidence.
    rows = [
        {**_row(""), "treatment_arm": "Drug low"},
        {**_row("parallel_rct"), "outcome_name": sibling_endpoint, "treatment_arm": "Drug high",
         "source_quote": "For the second outcome comparison the hazard ratio was 0.66 (95% CI 0.53 to 0.81)."},
    ]
    source = "Adults received Drug low, Drug high, or placebo. " + " ".join(row["source_quote"] for row in rows)
    study = _parse_source(project, protocol, description, rows, source=source)
    reconcile_extracted_rct_designs(protocol, [study])
    assert study.outcomes[0].source_quote_verified
    assert study.outcomes[0].comparative_design == ""
    project.save_json("all_extractions.json", [study], subdir="extraction")
    with pytest.raises(ProtocolInputRequired):
        admit_project_protocol(project, protocol, enforce=True)


def test_sibling_design_does_not_authorize_numeric_data_added_after_diagnostic_compilation(tmp_path):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    approve_synthetic_protocol_scope(project, protocol)
    rows = [{**_row(design), "effect_size": None, "ci_lower": None, "ci_upper": None}
            for design in ("", "parallel_rct")]
    rows[1]["outcome_name"] = "Secondary endpoint"
    study = _parse_source(project, protocol, PRODUCER_DESIGNS[0][0], rows)
    reconcile_extracted_rct_designs(protocol, [study])
    project.save_json("all_extractions.json", [study], subdir="extraction")
    admit_project_protocol(project, protocol, enforce=True)
    study.outcomes[0].effect_size = 0.66
    study.outcomes[0].reported_effect_standard_error = 0.17
    project.save_json("all_extractions.json", [study], subdir="extraction")
    with pytest.raises(ProtocolInputRequired):
        admit_project_protocol(project, protocol, enforce=True)


def test_exact_source_characteristics_can_supply_existing_legacy_design_metadata(tmp_path):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    study = _parse_source(project, protocol, "parallel RCT", _row(""))
    reconcile_extracted_rct_designs(protocol, [study])
    assert study.outcomes[0].source_quote_verified
    assert study.outcomes[0].comparative_design == "parallel_rct"
    project.save_json("all_extractions.json", [study], subdir="extraction")
    approve_synthetic_protocol_scope(project, protocol)
    plan = admit_project_protocol(project, protocol, enforce=True)
    assert plan.study_designs == ["parallel_rct"]
