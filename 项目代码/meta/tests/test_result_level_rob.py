from types import SimpleNamespace
import inspect

import pytest
from pydantic import ValidationError

from new_meta.agents.rob_agent import RoBAgent
from new_meta.core.effect_selection import build_rob_lookup, rob_for_study
from new_meta.core.grade_inputs import _rob_counts
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.core.result_rob import (
    RoBAdjudicationConflictError,
    build_result_rob_drafts,
    load_effective_rob_assessments,
    save_result_rob_adjudication,
)
from new_meta.schemas.meta_result import StudyEffect
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import (
    ResultRoBAssessment,
    RoBAssessmentStatus,
    RoBDomain,
    RoBTargetEffect,
    StudyRoB,
)
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics
import new_meta.main as main_module


def _assessment(
    *,
    result_id: str,
    outcome_name: str,
    judgment: str,
) -> ResultRoBAssessment:
    return ResultRoBAssessment(
        assessment_id=f"rob:{result_id}",
        result_id=result_id,
        study_id="S1",
        outcome_name=outcome_name,
        timepoint="28 days",
        analysis_population="intention-to-treat",
        tool_used="RoB 2",
        tool_version="RoB 2 v2 (2019)",
        target_effect=RoBTargetEffect.ASSIGNMENT,
        assessment_status=RoBAssessmentStatus.COMPLETE,
        domains=[
            RoBDomain(
                domain="Randomization process",
                judgment=judgment,
                support="Allocation details were checked in the trial report.",
                source_quote="Participants were randomly assigned.",
                source_page=3,
            )
        ],
        overall_judgment=judgment,
    )


def test_complete_result_rob_requires_result_target_and_source_evidence() -> None:
    with pytest.raises(ValidationError, match="complete result-level assessment"):
        ResultRoBAssessment(
            assessment_id="rob:S1",
            result_id="result:s1:0",
            study_id="S1",
            outcome_name="mortality",
            tool_used="RoB 2",
            tool_version="RoB 2 v2 (2019)",
            target_effect=RoBTargetEffect.ASSIGNMENT,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            domains=[
                RoBDomain(
                    domain="Randomization process",
                    judgment="Low risk",
                    support="Allocation was adequate.",
                )
            ],
            overall_judgment="Low risk",
        )


def test_selector_matches_risk_of_bias_to_the_specific_outcome_result() -> None:
    mortality = _assessment(
        result_id="result:s1:0",
        outcome_name="28-day mortality",
        judgment="Low risk",
    )
    quality_of_life = _assessment(
        result_id="result:s1:1",
        outcome_name="quality of life",
        judgment="High risk",
    )
    lookup = build_rob_lookup([quality_of_life, mortality])
    study = SimpleNamespace(
        characteristics=SimpleNamespace(
            study_id="S1",
            pmid="",
            doi="",
            title="Trial one",
        )
    )
    outcome = SimpleNamespace(outcome_name="28-day mortality", timepoint="28 days", subgroup="")
    effect = StudyEffect(study_id="S1", study_label="Smith 2024", yi=-0.1, vi=0.01, se=0.1)

    matched = rob_for_study(study, effect, lookup, outcome=outcome)

    assert matched is mortality
    assert matched.result_id == "result:s1:0"


def test_grade_counts_only_assessments_for_selected_result_ids() -> None:
    primary = _assessment(
        result_id="result:s1:0",
        outcome_name="28-day mortality",
        judgment="Low risk",
    )
    secondary = _assessment(
        result_id="result:s1:1",
        outcome_name="quality of life",
        judgment="High risk",
    )

    counts = _rob_counts(
        [primary, secondary],
        {"S1"},
        selected_result_ids={"result:s1:0"},
    )

    assert counts["assessed"] == 1
    assert counts["low"] == 1
    assert counts["high"] == 0
    assert counts["result_specific"] == 1


def test_study_level_assessment_is_projected_to_explicit_result_review_drafts() -> None:
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Trial one",
            authors=["Smith John"],
            year=2024,
            study_design="randomized controlled trial",
        ),
        outcomes=[
            OutcomeData(outcome_name="28-day mortality", outcome_type="dichotomous"),
            OutcomeData(outcome_name="quality of life", outcome_type="continuous", timepoint="90 days"),
        ],
    )
    legacy = SimpleNamespace(
        study_id="S1",
        tool_used="RoB 2",
        domains=[
            RoBDomain(
                domain="Randomization process",
                judgment="Low risk",
                support="Sequence generation was described.",
                source_quote="A computer-generated random sequence was used.",
                source_page=3,
            )
        ],
        overall_judgment="Low risk",
        is_synthetic=False,
    )

    drafts = build_result_rob_drafts([study], [legacy])

    assert [draft.result_id for draft in drafts] == ["result:s1:0", "result:s1:1"]
    assert all(draft.assessment_status is RoBAssessmentStatus.DRAFT for draft in drafts)
    assert all(draft.requires_adjudication is True for draft in drafts)
    assert all(draft.assessment_origin == "study_level_projection" for draft in drafts)


def test_rob_agent_persists_result_review_queue_and_readiness(tmp_path, monkeypatch) -> None:
    project = Project("result rob queue", output_dir=tmp_path / "project")
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            pmid="12345",
            title="Trial one",
            authors=["Smith John"],
            year=2024,
            study_design="randomized controlled trial",
        ),
        outcomes=[OutcomeData(outcome_name="28-day mortality", outcome_type="dichotomous")],
    )
    agent = RoBAgent()
    monkeypatch.setattr(
        agent,
        "call_llm_structured",
        lambda *args, **kwargs: type(agent._synthetic_rob("S1"))(
            study_id="S1",
            tool_used="RoB 2",
            domains=[
                RoBDomain(
                    domain="Randomization process",
                    judgment="Low risk",
                    support="Sequence generation was described.",
                    source_quote="A computer-generated random sequence was used.",
                    source_page=3,
                )
            ],
            overall_judgment="Low risk",
        ),
    )

    agent.run(
        [study],
        {"12345": {"full_text": "[PAGE 3] A computer-generated random sequence was used."}},
        project,
    )

    drafts = project.load_json("rob_result_assessments.json", subdir="risk_of_bias")
    readiness = project.load_json("rob_result_readiness.json", subdir="risk_of_bias")
    assert drafts[0]["result_id"] == "result:12345:0"
    assert drafts[0]["assessment_status"] == "draft"
    assert readiness["status"] == "blocked"
    assert readiness["blocker_codes"] == ["result_specific_rob_incomplete"]


def test_agent_completes_selected_result_rob_from_verbatim_source_evidence(
    tmp_path, monkeypatch
) -> None:
    project = Project("source grounded result rob", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="Does Drug reduce delirium?",
        pico=PICO(
            population="Older surgical patients",
            intervention="Drug",
            comparator="Placebo",
            outcome_primary="Postoperative delirium",
        ),
        review_family="intervention_rct",
        study_designs=["parallel RCT"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
    )
    compile_project_method_plan(project, protocol, enforce=True)
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            pmid="12345",
            title="Trial one",
            authors=["Smith John"],
            year=2024,
            study_design="randomized controlled trial",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="Postoperative delirium",
                outcome_type="dichotomous",
            )
        ],
    )
    quote = "A computer-generated random sequence was used."
    assessment = StudyRoB(
        study_id="12345",
        tool_used="RoB 2",
        domains=[
            RoBDomain(
                domain="Randomization process",
                judgment="Low risk",
                support="The sequence was randomized.",
                source_quote=quote,
                source_page=3,
                source_section="Methods",
            )
        ],
        overall_judgment="Low risk",
    )
    agent = RoBAgent()
    monkeypatch.setattr(
        agent,
        "call_llm_structured",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("LLM should not be called")),
    )

    completed = agent.complete_result_level_assessments(
        project=project,
        extracted_studies=[study],
        parsed_papers={"12345": {"full_text": f"[PAGE 3] Methods\n{quote}"}},
        study_assessments=[assessment],
        required_result_ids=["result:12345:0"],
    )

    assert completed[0].assessment_status is RoBAssessmentStatus.COMPLETE
    assert completed[0].assessment_origin == "source_grounded_study_assessment"
    readiness = project.load_json("rob_result_readiness.json", subdir="risk_of_bias")
    assert readiness["status"] == "ready"


def test_human_result_rob_adjudication_is_versioned_and_clears_readiness(tmp_path) -> None:
    project = Project("rob adjudication", output_dir=tmp_path / "project")
    assessment = _assessment(
        result_id="result:s1:0",
        outcome_name="28-day mortality",
        judgment="Low risk",
    ).model_copy(
        update={
            "assessment_status": RoBAssessmentStatus.ADJUDICATED,
            "adjudicated_by": "reviewer-7",
            "requires_adjudication": False,
            "assessment_origin": "human_adjudication",
        }
    )

    manifest = save_result_rob_adjudication(
        project,
        assessment,
        expected_revision=0,
        reason="Resolved after checking the prespecified analysis plan.",
    )

    saved = project.load_json("rob_result_assessments.json", subdir="risk_of_bias")
    readiness = project.load_json("rob_result_readiness.json", subdir="risk_of_bias")
    assert manifest["current_revision"] == 1
    assert manifest["history"][0]["reason"].startswith("Resolved after")
    assert saved[0]["assessment_status"] == "adjudicated"
    assert saved[0]["adjudicated_by"] == "reviewer-7"
    assert readiness["status"] == "ready"

    with pytest.raises(RoBAdjudicationConflictError, match="stale RoB adjudication revision"):
        save_result_rob_adjudication(
            project,
            assessment,
            expected_revision=0,
            reason="Stale duplicate write.",
        )


def test_effective_rob_loader_prefers_completed_result_assessment_but_not_draft(tmp_path) -> None:
    project = Project("effective result rob", output_dir=tmp_path / "project")
    legacy = type("Legacy", (), {"study_id": "S1"})()
    complete = _assessment(
        result_id="result:s1:0",
        outcome_name="28-day mortality",
        judgment="Low risk",
    )
    draft = complete.model_copy(
        update={
            "assessment_status": RoBAssessmentStatus.DRAFT,
            "requires_adjudication": True,
        }
    )
    project.save_json("rob_result_assessments.json", [draft], subdir="risk_of_bias")

    assert load_effective_rob_assessments(project, [legacy]) == [legacy]

    project.save_json("rob_result_assessments.json", [complete], subdir="risk_of_bias")
    effective = load_effective_rob_assessments(project, [legacy])
    assert effective[0].result_id == "result:s1:0"
    assert effective[1] is legacy


def test_grade_phase_consumes_effective_result_level_rob_assessments() -> None:
    source = inspect.getsource(main_module._run_grade_from_cached_meta)

    assert "load_effective_rob_assessments(" in source
    assert "rob_results=effective_rob_results" in source
