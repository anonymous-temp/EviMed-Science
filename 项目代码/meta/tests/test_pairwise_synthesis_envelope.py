from pathlib import Path

from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.core.synthesis_results import persist_pairwise_synthesis_envelope
from new_meta.schemas.meta_result import MetaAnalysisResults, PooledEffect
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_pairwise_meta_maps_to_same_synthesis_envelope_contract(tmp_path: Path) -> None:
    project = Project("pairwise envelope", output_dir=tmp_path / "project")
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
        tau_estimator="REML",
    )
    plan = compile_project_method_plan(project, protocol, enforce=True)
    project.save_json(
        "effect_selection_audit.json",
        [
            {"result_id": "result:S1:0", "in_final_primary_analysis": True},
            {"result_id": "result:S2:0", "in_final_primary_analysis": True},
            {"result_id": "result:S3:1", "in_final_primary_analysis": False},
        ],
        subdir="analysis",
    )
    results = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="mortality",
            n_studies=2,
            effect_measure="RR",
            pooled_effect=0.78,
            ci_lower=0.65,
            ci_upper=0.94,
            p_value=0.01,
            model="random",
            tau_estimator="REML",
            i_squared=24.0,
            tau_squared=0.03,
            prediction_interval=(0.51, 1.18),
        )
    )

    envelope = persist_pairwise_synthesis_envelope(project, plan=plan, results=results)

    assert envelope.route == "pairwise_aggregate"
    assert envelope.method_plan_fingerprint == plan.plan_fingerprint
    assert envelope.primary_estimates[0].estimate == 0.78
    assert envelope.primary_estimates[0].measure == "RR"
    assert envelope.primary_estimates[0].prediction_upper == 1.18
    assert envelope.input_result_ids == ["result:S1:0", "result:S2:0"]
    assert project.load_json("synthesis_result.json", subdir="analysis")["schema_version"] == 1
