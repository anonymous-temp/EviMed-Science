from pathlib import Path

import pytest

from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.core.result_rob import build_result_rob_drafts
from new_meta.core.rob_policy import resolve_rob_policy
from new_meta.schemas.method_policy import ReviewFamily
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import RoBTargetEffect, StudyRoB
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


@pytest.mark.parametrize(
    ("family", "expected_tool"),
    [
        (ReviewFamily.INTERVENTION_RCT, "RoB 2"),
        (ReviewFamily.INTERVENTION_NRSI, "ROBINS-I"),
        (ReviewFamily.PREVALENCE_INCIDENCE, "JBI Critical Appraisal Checklist for Prevalence Studies"),
        (ReviewFamily.DIAGNOSTIC_ACCURACY, "QUADAS-2"),
        (ReviewFamily.PROGNOSTIC_FACTOR, "QUIPS"),
        (ReviewFamily.PREDICTION_MODEL, "PROBAST"),
    ],
)
def test_review_family_resolves_validated_risk_of_bias_tool(family, expected_tool) -> None:
    policy = resolve_rob_policy(family=family, study_design="cross-sectional")

    assert policy.tool_name == expected_tool
    assert policy.tool_version
    assert policy.domain_names
    assert policy.prompt_template


def test_prevalence_result_drafts_use_jbi_policy_not_legacy_observational_tool(tmp_path: Path) -> None:
    project = Project("prevalence RoB", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="What is the prevalence?",
        pico=PICO(
            population="Adults",
            intervention="None",
            comparator="None",
            outcome_primary="Disease prevalence",
        ),
        effect_measure="PROP",
        review_family="prevalence_incidence",
        primary_outcome_type="proportion",
        study_designs=["cross-sectional"],
    )
    plan = compile_project_method_plan(project, protocol, enforce=True)
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Survey",
            authors=["Smith John"],
            year=2024,
            study_design="cross-sectional",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="Disease prevalence",
                outcome_type="proportion",
                events=10,
                total_n=100,
            )
        ],
    )

    drafts = build_result_rob_drafts(
        [study],
        [
            StudyRoB(
                study_id="S1",
                tool_used="Newcastle-Ottawa Scale",
                overall_judgment="Some concerns",
            )
        ],
        method_plan=plan,
    )

    assert drafts[0].tool_used == "JBI Critical Appraisal Checklist for Prevalence Studies"
    assert drafts[0].tool_version == "JBI Prevalence Checklist (2020)"
    assert drafts[0].target_effect is RoBTargetEffect.PREVALENCE
    assert drafts[0].domains == []
    assert drafts[0].assessment_origin == "method_policy_projection"
