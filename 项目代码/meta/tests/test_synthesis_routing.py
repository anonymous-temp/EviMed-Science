from pathlib import Path

from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.core.synthesis_routing import SynthesisRoute, load_synthesis_route
from new_meta.schemas.phase_result import ExecutionStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _protocol(**updates) -> ResearchProtocol:
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        study_designs=["RCT"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
        model_preference="random",
    )
    return protocol.model_copy(update=updates)


def test_parallel_rct_compiles_to_pairwise_aggregate_route(tmp_path: Path) -> None:
    project = Project("pairwise", output_dir=tmp_path / "pairwise")

    plan = compile_project_method_plan(project, _protocol(), enforce=True)
    route = load_synthesis_route(project)

    assert plan.study_designs == ["parallel_rct"]
    assert plan.outcome_type == "dichotomous"
    assert route.route is SynthesisRoute.PAIRWISE_AGGREGATE
    assert route.execution_allowed is True
    assert route.plan_fingerprint == plan.plan_fingerprint


def test_prevalence_compiles_to_method_plugin_not_pairwise_route(tmp_path: Path) -> None:
    project = Project("prevalence", output_dir=tmp_path / "prevalence")
    protocol = _protocol(
        review_family="prevalence_incidence",
        study_designs=["cross-sectional"],
        primary_outcome_type="proportion",
        effect_measure="PROP",
    )

    plan = compile_project_method_plan(
        project,
        protocol,
        allow_validating=True,
        enforce=True,
    )
    route = load_synthesis_route(project)

    assert plan.execution_allowed is True
    assert route.route is SynthesisRoute.METHOD_PLUGIN
    assert route.execution_allowed is True


def test_blocked_two_gate_method_compiles_to_blocked_route(tmp_path: Path) -> None:
    project = Project("diagnostic", output_dir=tmp_path / "diagnostic")
    protocol = _protocol(
        review_family="diagnostic_accuracy",
        study_designs=["case-control"],
        primary_outcome_type="diagnostic_accuracy",
        effect_measure="SENS_SPEC",
    )

    plan = compile_project_method_plan(project, protocol)
    route = load_synthesis_route(project)

    assert plan.execution_allowed is False
    assert route.route is SynthesisRoute.BLOCKED
    assert route.execution_allowed is False
    assert route.blocking_reasons


def test_pairwise_selector_returns_typed_block_for_method_plugin_route(tmp_path: Path) -> None:
    project = Project("prevalence selector", output_dir=tmp_path / "prevalence-selector")
    protocol = _protocol(
        review_family="prevalence_incidence",
        study_designs=["cross-sectional"],
        primary_outcome_type="proportion",
        effect_measure="PROP",
    )
    compile_project_method_plan(project, protocol, allow_validating=True, enforce=True)

    result = PipelineRunner(project).run_primary_effect_selection(
        protocol=protocol,
        extracted_studies=[],
    )

    assert result.status is ExecutionStatus.BLOCKED
    assert result.error_code == "wrong_synthesis_route"
    assert result.issues[0].code == "method_plugin_route_required"
    assert result.next_actions[0].action_id == "execute_method_plugin"
