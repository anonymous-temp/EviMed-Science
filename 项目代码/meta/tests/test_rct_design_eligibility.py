"""Observed trial designs select execution without rewriting admitted eligibility."""

import pytest

from new_meta.core.method_planning import (
    ProtocolInputRequired,
    admit_project_protocol,
    compile_project_method_plan,
)
from new_meta.core.project import Project
from new_meta.core.protocol_scope import protocol_hash
from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
from new_meta.core.synthesis_routing import SynthesisRoute, load_synthesis_route
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics
from protocol_scope_fixture import approve_synthetic_protocol_scope


def _protocol():
    return ResearchProtocol(
        research_question="Drug versus placebo for disease progression in randomized trials",
        pico=PICO(population="Adults", intervention="Drug", comparator="Placebo",
                  outcome_primary="Disease progression"),
        review_family="intervention_rct",
        study_design="parallel_rct / multi_arm_rct",
        study_designs=["parallel_rct", "multi_arm_rct"],
        primary_outcome_type="time_to_event", effect_measure="HR",
    )


def _study(study_id="S1", design="parallel RCT", **outcome_updates):
    outcome = OutcomeData(
        outcome_name="Disease progression", outcome_type="time_to_event",
        effect_size=0.66, ci_lower=0.53, ci_upper=0.81,
        reported_effect_measure="HR", reported_effect_scale="original",
        source_quote="The hazard ratio was 0.66 (95% CI 0.53 to 0.81).",
        source_quote_verified=True, treatment_arm="Drug", reference_arm="Placebo",
    ).model_copy(update=outcome_updates)
    return ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id=study_id, study_design=design,
            intervention_description="Drug", control_description="Placebo",
        ),
        outcomes=[outcome],
    )


def _save_studies(project, studies):
    project.save_json("all_extractions.json", studies, subdir="extraction")


def test_reconciliation_preserves_every_admitted_protocol_field():
    protocol = _protocol()
    before = protocol.model_dump(mode="json")
    fingerprint = protocol_hash(protocol)

    report = reconcile_extracted_rct_designs(protocol, [_study()])

    assert report["detected_designs"] == ["parallel_rct"]
    assert protocol.model_dump(mode="json") == before
    assert protocol_hash(protocol) == fingerprint


@pytest.mark.parametrize("design", ["", "unknown", "non-randomized controlled trial"])
@pytest.mark.parametrize("arm_count", [1, 2])
def test_reconciliation_cannot_invent_rct_design_before_readmission(tmp_path, design, arm_count):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    approve_synthetic_protocol_scope(project, protocol)
    admit_project_protocol(project, protocol, enforce=True)
    before = protocol.model_dump(mode="json")
    receipt = project.get_path("protocol_scope.json", subdir="analysis").read_bytes()
    study = _study(design=design, treatment_arm="Drug low")
    if arm_count == 2:
        study.outcomes.append(study.outcomes[0].model_copy(update={"treatment_arm": "Drug high"}))

    report = reconcile_extracted_rct_designs(protocol, [study])
    _save_studies(project, [study])

    with pytest.raises(ProtocolInputRequired):
        admit_project_protocol(project, protocol, enforce=True)
    assert report["multi_arm_studies"] == []
    assert all(outcome.comparative_design not in {"parallel_rct", "multi_arm_rct"}
               for outcome in study.outcomes)
    assert protocol.model_dump(mode="json") == before
    assert project.get_path("protocol_scope.json", subdir="analysis").read_bytes() == receipt
    assert not project.get_path("meta_results.json", subdir="analysis").exists()


@pytest.mark.parametrize("typed,expected", [
    ("parallel_rct", "parallel_rct"), ("RCT", "parallel_rct"),
    ("cluster_rct", "cluster_rct"), ("crossover_rct", "crossover_rct"),
    ("multi_arm_rct", "multi_arm_rct"),
])
def test_explicit_typed_design_survives_missing_characteristics_and_readmission(tmp_path, typed, expected):
    protocol = _protocol()
    protocol.study_designs = ["RCT"]
    project = Project(protocol.research_question, output_dir=tmp_path)
    approve_synthetic_protocol_scope(project, protocol)
    study = _study(design="", comparative_design=typed)

    reconcile_extracted_rct_designs(protocol, [study])
    _save_studies(project, [study])
    plan = admit_project_protocol(project, protocol, enforce=True)

    assert study.characteristics.study_design == ""
    assert study.outcomes[0].comparative_design == expected
    assert plan.study_designs == [expected]


def test_shared_arms_with_explicit_typed_rct_keep_multi_arm_requirements(tmp_path):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    study = _study(design="", comparative_design="RCT", treatment_arm="Drug low")
    study.outcomes.append(study.outcomes[0].model_copy(update={"treatment_arm": "Drug high"}))

    report = reconcile_extracted_rct_designs(protocol, [study])
    _save_studies(project, [study])
    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert report["multi_arm_studies"] == ["S1"]
    assert plan.study_designs == ["multi_arm_rct"]
    assert load_synthesis_route(project).route is SynthesisRoute.METHOD_PLUGIN
    assert all(outcome.covariance_with == {} for outcome in study.outcomes)


def test_parallel_subset_survives_project_reconciliation_readmission_and_reload(tmp_path):
    from new_meta.main import _admit_cli_protocol, _reconcile_project_rct_designs

    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    project.save_json("protocol.json", protocol)
    approve_synthetic_protocol_scope(project, protocol)
    admitted = _admit_cli_protocol(project, protocol, enforce=True)
    assert admitted.capability_id == "intervention_rct.complex_design"
    protocol_bytes = project.get_path("protocol.json").read_bytes()
    scope_bytes = project.get_path("protocol_scope.json", subdir="analysis").read_bytes()
    fingerprint = protocol_hash(protocol)
    studies = [_study(), _study("S2", effect_size=0.38, ci_lower=0.12, ci_upper=1.22)]
    _save_studies(project, studies)

    report = _reconcile_project_rct_designs(
        project, protocol, studies, {}, allow_validating=False,
    )
    plan = _admit_cli_protocol(project, protocol, enforce=True)
    reloaded = ResearchProtocol.model_validate(project.load_json("protocol.json"))
    resumed_plan = admit_project_protocol(project, reloaded, enforce=True)

    assert protocol_hash(protocol) == fingerprint
    assert project.get_path("protocol.json").read_bytes() == protocol_bytes
    assert project.get_path("protocol_scope.json", subdir="analysis").read_bytes() == scope_bytes
    assert report["compiled_capability_id"] == "intervention_rct.parallel.standard"
    assert plan.study_designs == ["parallel_rct"]
    assert resumed_plan.plan_fingerprint == plan.plan_fingerprint
    assert load_synthesis_route(project).route is SynthesisRoute.PAIRWISE_AGGREGATE


def test_method_compilation_uses_current_extractions_instead_of_allowed_designs(tmp_path):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study()])
    first = compile_project_method_plan(project, protocol, enforce=True)
    assert first.study_designs == ["parallel_rct"]
    assert load_synthesis_route(project).route is SynthesisRoute.PAIRWISE_AGGREGATE

    _save_studies(project, [_study(design="multi-arm RCT")])
    second = compile_project_method_plan(project, protocol, enforce=True)
    assert second.study_designs == ["multi_arm_rct"]
    assert second.plan_fingerprint != first.plan_fingerprint
    assert load_synthesis_route(project).route is SynthesisRoute.METHOD_PLUGIN


@pytest.mark.parametrize("designs,expected", [
    (["cluster RCT"], ["cluster_rct"]),
    (["crossover RCT"], ["crossover_rct"]),
    (["multi-arm RCT"], ["multi_arm_rct"]),
    (["parallel RCT", "cluster RCT", "crossover RCT", "multi-arm RCT"],
     ["cluster_rct", "crossover_rct", "multi_arm_rct", "parallel_rct"]),
])
def test_observed_complex_designs_retain_the_design_aware_route(tmp_path, designs, expected):
    protocol = _protocol()
    protocol.study_designs = ["parallel_rct", "cluster_rct", "crossover_rct", "multi_arm_rct"]
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study(f"S{index}", design) for index, design in enumerate(designs)])

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert plan.study_designs == expected
    assert plan.capability_id == "intervention_rct.complex_design"
    assert "design_adjustment_complete" in plan.hard_gates
    assert {"cluster_design_adjustment", "crossover_correlation", "multi_arm_covariance"} <= set(plan.required_diagnostics)
    assert load_synthesis_route(project).route is SynthesisRoute.METHOD_PLUGIN


def test_unverified_or_secondary_rows_cannot_hide_observed_cluster_design(tmp_path):
    protocol = _protocol()
    protocol.study_designs.append("cluster_rct")
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study(), _study("C1", "cluster RCT", source_quote_verified=False,
                                           outcome_name="Secondary outcome")])

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert plan.study_designs == ["cluster_rct", "parallel_rct"]
    assert load_synthesis_route(project).route is SynthesisRoute.METHOD_PLUGIN


@pytest.mark.parametrize("design,typed", [
    ("", ""),
    ("unclassified randomized study", "unknown"),
    ("cohort", "parallel_rct"),
    ("non-randomized controlled trial", ""),
    ("parallel RCT", "unclassified"),
])
def test_unknown_or_mixed_non_rct_data_cannot_become_parallel_execution(tmp_path, design, typed):
    protocol = _protocol()
    before = protocol.model_dump(mode="json")
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study(), _study("S2", design, comparative_design=typed)])

    with pytest.raises(ProtocolInputRequired):
        compile_project_method_plan(project, protocol, enforce=True)

    assert protocol.model_dump(mode="json") == before


@pytest.mark.parametrize("design,typed", [("cluster RCT", ""), ("parallel RCT", "cluster_rct")])
def test_observed_design_outside_admitted_eligibility_is_not_silently_added(tmp_path, design, typed):
    protocol = _protocol()
    before = protocol.model_dump(mode="json")
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study(design=design, comparative_design=typed)])

    with pytest.raises(ProtocolInputRequired):
        compile_project_method_plan(project, protocol, enforce=True)

    assert protocol.model_dump(mode="json") == before


@pytest.mark.parametrize("generic", ["RCT", "RCTs", "randomized controlled trials"])
def test_generic_rct_eligibility_does_not_exclude_observed_complex_designs(tmp_path, generic):
    protocol = _protocol()
    protocol.study_design = generic
    protocol.study_designs = [generic]
    before = protocol.model_dump(mode="json")
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study(design="cluster RCT")])

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert protocol.model_dump(mode="json") == before
    assert plan.study_designs == ["cluster_rct"]
    assert load_synthesis_route(project).route is SynthesisRoute.METHOD_PLUGIN


@pytest.mark.parametrize("design", ["cluster_rct", "crossover_rct", "multi_arm_rct"])
def test_reconciliation_preserves_typed_dependencies_when_characteristics_are_generic(tmp_path, design):
    protocol = _protocol()
    protocol.study_designs = ["RCT"]
    project = Project(protocol.research_question, output_dir=tmp_path)
    study = _study(design="RCT", comparative_design=design)

    reconcile_extracted_rct_designs(protocol, [study])
    _save_studies(project, [study])
    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert study.outcomes[0].comparative_design == design
    assert plan.study_designs == [design]
    assert load_synthesis_route(project).route is SynthesisRoute.METHOD_PLUGIN


@pytest.mark.parametrize("design", ["cluster RCT", "crossover RCT", "unclassified randomized study"])
def test_multiple_arms_do_not_erase_other_extracted_design_requirements(tmp_path, design):
    protocol = _protocol()
    protocol.study_designs = ["RCT"]
    study = _study(design=design, treatment_arm="Drug low")
    study.outcomes.append(study.outcomes[0].model_copy(update={"treatment_arm": "Drug high"}))

    reconcile_extracted_rct_designs(protocol, [study])

    assert study.characteristics.study_design == design


@pytest.mark.parametrize("design,typed", [
    ("cluster RCT", "crossover_rct"),
    ("cluster RCT", "multi_arm_rct"),
])
def test_combined_dependencies_require_a_supported_execution_path(tmp_path, design, typed):
    protocol = _protocol()
    protocol.study_designs = ["RCT"]
    project = Project(protocol.research_question, output_dir=tmp_path)
    study = _study(design=design, comparative_design=typed)
    reconcile_extracted_rct_designs(protocol, [study])
    _save_studies(project, [study])

    with pytest.raises(ProtocolInputRequired, match="Combined trial design dependencies"):
        compile_project_method_plan(project, protocol, enforce=True)


@pytest.mark.parametrize("typed", ["cluster_rct", "crossover_rct", "multi_arm_rct"])
def test_parallel_arm_label_does_not_erase_more_specific_typed_dependencies(tmp_path, typed):
    protocol = _protocol()
    protocol.study_designs = ["RCT"]
    project = Project(protocol.research_question, output_dir=tmp_path)
    study = _study(design="parallel RCT", comparative_design=typed)
    reconcile_extracted_rct_designs(protocol, [study])
    _save_studies(project, [study])

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert plan.study_designs == [typed]
    assert load_synthesis_route(project).route is SynthesisRoute.METHOD_PLUGIN


def test_observing_a_supported_subset_does_not_hide_invalid_protocol_designs(tmp_path):
    protocol = _protocol()
    protocol.study_designs.append("unclassified")
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study()])

    with pytest.raises(ProtocolInputRequired):
        compile_project_method_plan(project, protocol, enforce=True)


def test_unknown_design_cannot_pool_a_reported_hr_with_se_instead_of_ci(tmp_path):
    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    _save_studies(project, [_study(design="", ci_lower=None, ci_upper=None,
                                  reported_effect_standard_error=0.17)])

    with pytest.raises(ProtocolInputRequired):
        compile_project_method_plan(project, protocol, enforce=True)


def test_diagnostic_compilation_does_not_admit_later_numeric_results_with_unknown_design(tmp_path):
    protocol = _protocol()
    protocol.study_designs = ["parallel_rct"]
    project = Project(protocol.research_question, output_dir=tmp_path)
    study = _study(design="", effect_size=None, ci_lower=None, ci_upper=None)
    _save_studies(project, [study])
    extraction_bytes = project.get_path("all_extractions.json", subdir="extraction").read_bytes()

    compile_project_method_plan(project, protocol, enforce=True)

    assert project.get_path("all_extractions.json", subdir="extraction").read_bytes() == extraction_bytes
    study.outcomes[0].effect_size = 0.66
    study.outcomes[0].reported_effect_standard_error = 0.17
    _save_studies(project, [study])
    with pytest.raises(ProtocolInputRequired):
        compile_project_method_plan(project, protocol, enforce=True)


@pytest.mark.parametrize("with_effect", [False, True])
def test_diagnostic_computability_probe_does_not_mutate_protocol_or_extractions(with_effect):
    from new_meta.core.method_planning import _has_computable_effect

    protocol = _protocol()
    study = _study() if with_effect else _study(effect_size=None, ci_lower=None, ci_upper=None)
    before = (protocol.model_dump(mode="json"), study.model_dump(mode="json"))

    assert _has_computable_effect([study], protocol) is with_effect
    assert (protocol.model_dump(mode="json"), study.model_dump(mode="json")) == before


def test_actual_protocol_change_still_requires_independent_scope_assessment(tmp_path, monkeypatch):
    from new_meta.agents.research_planner import ResearchPlanner

    protocol = _protocol()
    project = Project(protocol.research_question, output_dir=tmp_path)
    approve_synthetic_protocol_scope(project, protocol)
    admit_project_protocol(project, protocol, enforce=True)
    _save_studies(project, [_study()])
    reconcile_extracted_rct_designs(protocol, [_study()])
    protocol.study_designs = ["parallel_rct"]
    protocol.study_design = "parallel RCT"

    def reject_changed_scope(self, topic, candidate):
        assert topic == protocol.research_question
        assert candidate.study_designs == ["parallel_rct"]
        raise ProtocolInputRequired("Independent scope assessment required for changed eligibility",
                                    protocol=candidate)

    monkeypatch.setattr(ResearchPlanner, "check_scope", reject_changed_scope)
    with pytest.raises(ProtocolInputRequired, match="Independent scope assessment required"):
        admit_project_protocol(project, protocol, enforce=True)
