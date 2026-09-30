"""Unattended, the review's primary comparison is one analysis set, one contribution per trial.

Production run meta-20260928172536 (ma-001, 2026-09-28): four RCTs reported
the primary outcome, total blood loss, and analysis_set_candidates.json held
six one-study candidates - keyed by free-text timepoint and by "subgroup"
labels that were really the arms of three multi-arm trials (routes and doses
of TXA). The ranking picked one, and synthesis stopped at "1 contrast from 1
study". The shapes below are the production ones.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from new_meta.core.analysis_set import discover_analysis_set_candidates
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.primary_analysis_alignment import UNATTENDED_RUN_FILE
from new_meta.core.project import Project
from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
from new_meta.engines.complex_rct import run_complex_rct
from new_meta.schemas.method_policy import MethodPlan
from new_meta.schemas.study import ExtractedStudy, StudyCharacteristics

from test_multi_arm_continuous import _protocol, _row


def _arm(treatment, mean_i, sd_i, n_i, control, mean_c, sd_c, n_c, *, timepoint, subgroup="", design="multi_arm_rct"):
    row = _row(treatment, mean_i, sd_i, n_i, mean_c, sd_c, n_c)
    row.reference_arm = control
    row.treatment_arm_role, row.reference_arm_role = "review_intervention", "review_comparator"
    row.protocol_outcome_role = "primary"
    row.comparative_design = design
    row.timepoint = timepoint
    row.subgroup = subgroup or None
    return row


def _study(pmid: str, *rows) -> ExtractedStudy:
    return ExtractedStudy(characteristics=StudyCharacteristics(study_id=pmid, pmid=pmid, title=f"Trial {pmid}",
                                                               study_design="randomized controlled trial"),
                          outcomes=list(rows))


def _production_studies() -> list[ExtractedStudy]:
    return [
        _study("22053253", _arm("Tranexamic acid 15 mg/kg (tranexamic acid)", 690.0, 210.0, 50, "Placebo", 980.0, 260.0, 50,
                                timepoint="postoperative blood loss measured to 4th postoperative day", design="parallel_rct")),
        _study("39673144", _arm("Low-dose intra-articular TXA 1 g (tranexamic acid)", 754.0, 409.7, 75, "Placebo (saline)",
                                977.3, 418.7, 75, timepoint="perioperative", subgroup="dose level: 1 g intra-articular txa")),
        _study("27222617",
               _arm("Intravenous TXA (tranexamic acid)", 820.0, 240.0, 40, "No TXA", 1150.0, 300.0, 40,
                    timepoint="postoperative calculated total blood loss", subgroup="route of administration: intravenous"),
               _arm("Topical TXA (tranexamic acid)", 870.0, 250.0, 40, "No TXA", 1150.0, 300.0, 40,
                    timepoint="postoperative calculated total blood loss", subgroup="route of administration: topical")),
        _study("24308672",
               _arm("Intra-articular TXA 250 mg (tranexamic acid)", 900.0, 230.0, 30, "Saline", 1100.0, 280.0, 30,
                    timepoint="postoperative day 4", subgroup="txa dose level: 250 mg (single intra-articular)"),
               _arm("Intra-articular TXA 500 mg (tranexamic acid)", 800.0, 220.0, 30, "Saline", 1100.0, 280.0, 30,
                    timepoint="postoperative day 4", subgroup="txa dose level: 500 mg (single intra-articular)")),
    ]


def _project(tmp_path: Path, studies, *, unattended: bool) -> tuple[Project, MethodPlan]:
    from primary_alignment_fixture import approve_synthetic_method_fixture
    protocol = _protocol()
    reconcile_extracted_rct_designs(protocol, studies)
    project = Project("ma-001 analysis set", output_dir=tmp_path / "project")
    project.save_json("all_extractions.json", studies, subdir="extraction")
    assert migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies).skipped_results == []
    compile_project_method_plan(project, protocol, enforce=True)
    approve_synthetic_method_fixture(project, protocol, studies)
    if unattended:
        project.save_json(UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": True})
    return project, MethodPlan.model_validate(project.load_json("method_plan.json", subdir="analysis"))


def test_the_six_production_strata_are_one_primary_candidate(tmp_path: Path):
    project, plan = _project(tmp_path, _production_studies(), unattended=True)
    candidates = discover_analysis_set_candidates(project, plan).candidates
    assert len(candidates) == 1
    primary = candidates[0]
    assert primary.eligible and primary.subgroup == ""
    assert len(set(primary.study_ids)) == 4 and len(primary.result_ids) == 6

    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "primary_timepoints_merged")
    studies = warning["context"]["studies"]
    assert studies["study:27222617"]["timepoints"] == ["postoperative calculated total blood loss"]
    assert studies["study:22053253"]["timepoints"] == ["postoperative blood loss measured to 4th postoperative day"]
    assert sorted(item["label"] for item in studies["study:24308672"]["contrasts"]) == [
        "txa dose level: 250 mg (single intra-articular)", "txa dose level: 500 mg (single intra-articular)"]

    phase = PipelineRunner(project).run_compiled_method_synthesis()
    assert phase.status.value == "succeeded", phase.summary
    payload = project.load_json("synthesis_result.json", subdir="analysis")["engine_payload"]
    assert payload["n_studies"] == 4 and payload["n_contrasts"] == 6
    by_study = {item["study_id"]: item for item in payload["study_effects"]}
    assert by_study["study:24308672"]["n_contrasts"] == 2 and by_study["study:27222617"]["n_contrasts"] == 2
    # Each multi-arm trial counts once: its GLS variance keeps its shared control's.
    assert by_study["study:27222617"]["variance"] > 300.0 ** 2 / 40
    # Heterogeneity and the prediction interval run on the joined set.
    assert payload["prediction_interval"] is not None and payload["tau_squared"] >= 0
    # The free-text labels group nothing: moderators are closed protocol
    # subgroup values (test_closed_subgroup_values.py), and this protocol has none.
    assert payload["moderator_subgroups"] == {}
    audit = project.load_json("method_input_audit.json", subdir="analysis")
    assert {item["timepoint"] for item in audit["inputs"]} == {
        "postoperative blood loss measured to 4th postoperative day", "perioperative",
        "postoperative calculated total blood loss", "postoperative day 4"}


def test_interactively_the_strata_are_offered_as_before(tmp_path: Path):
    project, plan = _project(tmp_path, _production_studies(), unattended=False)
    candidates = discover_analysis_set_candidates(project, plan).candidates
    assert len(candidates) == 6 and all(len(set(item.study_ids)) == 1 for item in candidates)
    assert PipelineRunner(project).run_compiled_method_synthesis().status.value == "needs_input"


def test_one_study_reporting_the_primary_outcome_is_too_few_to_pool(tmp_path: Path):
    # The synthesis still does not pool one study; since 2026-09-29 its stop is
    # typed, and the CLI writes the narrative report for it (test_refusal_is_recorded).
    project, _ = _project(tmp_path, _production_studies()[1:2], unattended=True)  # 39673144 alone
    phase = PipelineRunner(project).run_compiled_method_synthesis()
    assert phase.status.value == "blocked"
    assert phase.error_code == "insufficient_studies_for_synthesis"
    assert phase.summary.startswith(
        "Complex RCT synthesis requires at least 2 contrasts from at least 2 independent studies; "
        "the selected analysis set has 1 contrast(s) from 1 study/studies.")


def test_a_trial_never_enters_twice_without_its_covariance(tmp_path: Path):
    studies = _production_studies()
    # The same comparison of 22053253 at a second window: which is primary is nobody's call here.
    studies[0].outcomes.append(_arm("Tranexamic acid 15 mg/kg (tranexamic acid)", 400.0, 150.0, 50, "Placebo",
                                    600.0, 200.0, 50, timepoint="first 24 hours", design="parallel_rct"))
    # 24308672's two arms against controls reported differently: no covariance can be derived.
    studies[3].outcomes[1].sd_control = 281.0
    project, plan = _project(tmp_path, studies, unattended=True)
    candidate = discover_analysis_set_candidates(project, plan).candidates[0]
    assert sorted(set(candidate.study_ids)) == ["study:27222617", "study:39673144"]
    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "primary_results_left_out")
    assert warning["context"]["results"] == {
        "result:22053253:0": "same_comparison_reported_more_than_once",
        "result:22053253:1": "same_comparison_reported_more_than_once",
        "result:24308672:0": "multi_arm_covariance_unresolved",
        "result:24308672:1": "multi_arm_covariance_unresolved",
    }


def test_a_moderator_shared_by_two_trials_is_pooled_and_tested():
    def record(study, contrast, estimate, route, covariance=None):
        return {"result_id": f"{study}:{contrast}", "study_id": study, "design": "multi_arm_rct", "measure": "MD",
                "estimate": estimate, "variance": 900.0, "precision_basis": "computed", "estimand_id": "primary",
                "treatment": contrast, "comparator": "control", "contrast_id": f"{study}:{contrast}",
                "covariance_with": covariance or {}, "subgroup_values": {"route": route}}
    records = [
        record("A", "iv", -300.0, "intravenous", {"A:topical": 400.0}),
        record("A", "topical", -200.0, "topical", {"A:iv": 400.0}),
        record("B", "iv", -280.0, "intravenous", {"B:topical": 400.0}),
        record("B", "topical", -150.0, "topical", {"B:iv": 400.0}),
    ]
    result = run_complex_rct(records, subgroup_variables=[
        {"variable_id": "route", "label": "Route", "values": ["intravenous", "topical", "not_reported"]}])
    assert result.n_studies == 2 and result.n_contrasts == 4
    route = result.moderator_subgroups["variables"][0]
    values = route["values"]
    assert values["intravenous"]["n_studies"] == 2 and values["intravenous"]["estimate"] == pytest.approx(-290.0)
    assert values["topical"]["estimate"] == pytest.approx(-175.0)
    assert route["between"]["df"] == 1 and route["between"]["q"] > 0 and route["between"]["approximate"] is True
