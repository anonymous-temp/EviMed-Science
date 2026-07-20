from pathlib import Path

import pytest

from new_meta.core.method_planning import (
    MethodCapabilityBlockedError,
    compile_project_method_plan,
    infer_review_family,
    normalize_protocol_method_fields,
)
from new_meta.core.project import Project
from new_meta.schemas.method_policy import ReviewFamily
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _protocol(**updates) -> ResearchProtocol:
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="28-day all-cause mortality",
        ),
        study_designs=["RCT"],
        effect_measure="RR",
        model_preference="random",
        primary_outcome_type="dichotomous",
        protocol_version="1.0",
    )
    return protocol.model_copy(update=updates)


def test_project_method_plan_is_inferred_versioned_and_persisted(tmp_path: Path) -> None:
    project = Project("method plan", output_dir=tmp_path / "project")
    protocol = _protocol()

    plan = compile_project_method_plan(
        project,
        protocol,
        allow_validating=True,
    )

    assert infer_review_family(protocol) is ReviewFamily.INTERVENTION_RCT
    assert plan.execution_allowed is True
    assert plan.protocol_version == "1.0"
    persisted = project.load_json("method_plan.json", subdir="analysis")
    snapshot = project.load_json("method_policy_snapshot.json", subdir="analysis")
    assert persisted["plan_fingerprint"] == plan.plan_fingerprint
    assert snapshot["plugin"]["policy_version"] == plan.policy_version
    assert snapshot["design_spec"]["study_designs"] == ["parallel_rct"]


def test_explicit_review_family_controls_method_selection(tmp_path: Path) -> None:
    project = Project("DTA method plan", output_dir=tmp_path / "project")
    protocol = _protocol(
        review_family="diagnostic_accuracy",
        study_designs=["diagnostic cross-sectional"],
        primary_outcome_type="diagnostic_accuracy",
        effect_measure="SENS_SPEC",
    )

    plan = compile_project_method_plan(project, protocol)

    assert infer_review_family(protocol) is ReviewFamily.DIAGNOSTIC_ACCURACY
    assert plan.family is ReviewFamily.DIAGNOSTIC_ACCURACY
    assert plan.execution_allowed is True
    assert plan.capability_id == "diagnostic_accuracy.reitsma_reml"
    assert plan.primary_estimator == "REITSMA_BIVARIATE_REML"


@pytest.mark.parametrize(
    "alias",
    [
        "therapeutic",
        "therapy",
        "treatment",
        "intervention",
        "rct",
        "therapeutic intervention",
        "randomized intervention review",
        "clinical trial effectiveness review",
    ],
)
def test_common_planner_aliases_map_to_intervention_rct(alias: str) -> None:
    protocol = _protocol(review_family=alias)

    assert infer_review_family(protocol) is ReviewFamily.INTERVENTION_RCT


@pytest.mark.parametrize(
    "umbrella_label",
    [
        "systematic review with meta-analysis",
        "systematic literature review",
        "quantitative evidence synthesis",
        "pairwise meta-analysis",
    ],
)
def test_generic_review_labels_defer_to_method_fields(umbrella_label: str) -> None:
    protocol = _protocol(
        review_family=umbrella_label,
        study_design="randomized controlled trial",
        effect_measure="HR",
    )

    assert infer_review_family(protocol) is ReviewFamily.INTERVENTION_RCT


def test_planner_method_fields_are_canonicalized_before_persistence() -> None:
    protocol = _protocol(
        review_family="pairwise meta-analysis",
        primary_outcome_type="time-to-event",
        effect_measure="Hazard Ratio",
        model_preference="random effects",
    )

    normalize_protocol_method_fields(protocol)

    assert protocol.review_family == ReviewFamily.INTERVENTION_RCT.value
    assert protocol.primary_outcome_type == "time_to_event"
    assert protocol.effect_measure == "HR"
    assert protocol.model_preference == "random"


@pytest.mark.parametrize(
    "design",
    [
        "randomized controlled trial",
        "Randomized controlled trials",
        "randomised controlled trials (RCTs)",
    ],
)
def test_planner_rct_design_variants_compile_to_parallel_rct(
    design: str,
    tmp_path: Path,
) -> None:
    project = Project("planner RCT design", output_dir=tmp_path / "project")
    protocol = _protocol(study_design=design, study_designs=[design])

    plan = compile_project_method_plan(project, protocol)

    assert plan.study_designs == ["parallel_rct"]


def test_enforced_validated_nma_compiles_before_analysis(tmp_path: Path) -> None:
    project = Project("NMA production", output_dir=tmp_path / "project")
    protocol = _protocol(
        review_family="network_meta",
        analysis_type="network",
        interventions=["A", "B", "C"],
        study_designs=["RCT", "multi-arm RCT"],
        effect_measure="OR",
    )

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert plan.family is ReviewFamily.NETWORK_META
    assert plan.execution_allowed is True
    assert plan.capability_status.value == "production"
    assert project.load_json("method_plan.json", subdir="analysis")["execution_allowed"] is True


def test_protocol_change_produces_new_method_fingerprint(tmp_path: Path) -> None:
    project = Project("method plan revision", output_dir=tmp_path / "project")
    first = compile_project_method_plan(project, _protocol(), allow_validating=True)
    second = compile_project_method_plan(
        project,
        _protocol(effect_measure="OR", protocol_version="1.1"),
        allow_validating=True,
    )

    assert first.plan_fingerprint != second.plan_fingerprint
    assert second.protocol_version == "1.1"


def test_hyphenated_time_to_event_outcome_is_canonicalized(tmp_path: Path) -> None:
    project = Project("time to event", output_dir=tmp_path / "project")
    protocol = _protocol(effect_measure="HR", primary_outcome_type="time-to-event")

    plan = compile_project_method_plan(project, protocol)

    assert plan.outcome_type == "time_to_event"


def test_natural_language_method_fields_are_canonicalized(tmp_path: Path) -> None:
    project = Project("method aliases", output_dir=tmp_path / "project")
    protocol = _protocol(
        effect_measure="Hazard Ratio",
        primary_outcome_type="survival",
        model_preference="random effects",
    )

    plan = compile_project_method_plan(project, protocol)

    assert plan.effect_measure == "HR"
    assert plan.outcome_type == "time_to_event"
    assert plan.primary_estimator == "REML"
