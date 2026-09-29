"""Subgroup analyses group contrasts by closed protocol values, never by their wording.

Production job meta-20260928185649 (ma-001, 2026-09-28): the protocol
prespecified "Route of tranexamic acid administration (intravenous vs topical
vs combined)"; the design-aware engine grouped the three primary contrasts by
their free-text labels - "Intravenous (IV) route" (29410968:0), "Topical
(intra-articular) route" (29410968:1) and "Topical (intra-articular) TXA"
(39673144:0) - so every label held one study and nothing was pooled. The
fixture is cut from that run's saved files (tests/fixtures/closed_subgroup_ma001.json).
The closed values here are assigned by hand, as the extraction model now
assigns them; no test calls a model.
"""
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import pytest

from new_meta.core.project import Project
from new_meta.core.subgroup_vocabulary import validated_vocabulary
from new_meta.engines.complex_rct import run_complex_rct
from new_meta.engines.meta_engine import random_effects_reml, subgroup_analysis
from new_meta.schemas.meta_result import StudyEffect
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "closed_subgroup_ma001.json").read_text(encoding="utf-8"))
PRODUCTION = Path("/tmp/w29/prod/meta-20260928185649-1fc3ffd33a97/output/"
                  "20260928_185654_Tranexamic_acid_for_reducing_perioperative_blood_l")
ROUTE = "Route of tranexamic acid administration (intravenous vs topical vs combined)"
ROUTE_ID = "route_of_tranexamic_acid_administration"
#: What the extraction model would plausibly assign each production contrast.
CLOSED = {"result:29410968:0": "intravenous", "result:29410968:1": "topical", "result:39673144:0": "topical"}


def _protocol() -> ResearchProtocol:
    return ResearchProtocol.model_validate(FIXTURE["protocol"])


def _vocabulary(protocol=None):
    return validated_vocabulary({"variables": [{"protocol_text": ROUTE, "values": [
        {"value": "intravenous", "definition": "Tranexamic acid given only intravenously."},
        {"value": "topical", "definition": "Tranexamic acid given only topically or intra-articularly."},
        {"value": "combined", "definition": "Tranexamic acid given both intravenously and topically."},
    ]}]}, protocol or _protocol())


def _studies() -> dict[str, ExtractedStudy]:
    return {pmid: ExtractedStudy.model_validate(payload) for pmid, payload in FIXTURE["studies"].items()}


def _records(closed: dict[str, str] | None = None) -> list[dict]:
    """The engine records exactly as the method executor builds them from the ledger."""
    records = []
    for item in FIXTURE["method_inputs"]:
        raw = {key: value for key, value in item["raw_data"].items() if key != "data_type"}
        values = {ROUTE_ID: closed[item["result_id"]]} if closed and item["result_id"] in closed else {}
        records.append({"result_id": item["result_id"], "study_id": item["study_id"], **raw, **item["estimate"],
                        "subgroup_values": values})
    return records


def _route_spec(values=("intravenous", "topical", "combined", "not_reported")) -> list[dict]:
    return [{"variable_id": ROUTE_ID, "label": ROUTE, "values": list(values)}]


# --- the saved production rows keep their proofs --------------------------------------------------


def test_saved_production_rows_keep_their_fingerprints_under_the_new_schema():
    from new_meta.core.extraction_ledger import current_extraction_matches_result, extraction_result_binding
    from new_meta.core.primary_analysis_alignment import row_fingerprint, selection_input_fingerprint
    from new_meta.schemas.evidence_ledger import ResultEntity

    protocol, studies = _protocol(), _studies()
    for pmid, study in studies.items():
        for index, row in enumerate(study.outcomes):
            assert row.subgroup_values == {} and "subgroup_values" not in row.model_dump(mode="json")
            # The verification proof recorded the digest of the row as extracted.
            assert row_fingerprint(study, index) == row.primary_analysis_alignment.row_sha256
            # The row as the selection receipt saw it, before any closed value.
            before = selection_input_fingerprint(study, index)
            row.subgroup_values = {ROUTE_ID: "topical"}
            assert row_fingerprint(study, index) != row.primary_analysis_alignment.row_sha256
            assert selection_input_fingerprint(study, index) != before
            row.subgroup_values = {}
            assert selection_input_fingerprint(study, index) == before
    for payload in FIXTURE["ledger_results"]:
        entity = ResultEntity.model_validate(payload)
        _, pmid, index = entity.entity_id.split(":")
        assert "subgroup_values" not in entity.derivation
        binding = extraction_result_binding(studies[pmid], int(index), protocol, entity)
        assert binding == entity.derivation["extraction_binding"]
        assert current_extraction_matches_result(studies[pmid], int(index), protocol, entity)


def test_the_ledger_writes_the_saved_payloads_again_and_carries_closed_values_only_when_present(tmp_path: Path):
    from new_meta.core.evidence_ledger import EvidenceLedger
    from new_meta.core.extraction_ledger import migrate_extractions_to_ledger

    protocol, studies = _protocol(), _studies()
    project = Project("ma-001 ledger replay", output_dir=tmp_path)
    review_id = FIXTURE["ledger_results"][0]["review_id"]
    project.save_json("review_identity.json", {"review_id": review_id}, subdir="evidence")
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=list(studies.values()))
    ledger = EvidenceLedger(project.get_path("ledger.jsonl", subdir="evidence"), review_id=review_id)
    for saved in FIXTURE["ledger_results"]:
        assert ledger.current(saved["entity_id"]) == saved

    studies["29410968"].outcomes[1].subgroup_values = {ROUTE_ID: "topical"}
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=list(studies.values()))
    ledger.assert_valid()
    assert ledger.current("result:29410968:1")["derivation"]["subgroup_values"] == {ROUTE_ID: "topical"}
    assert "subgroup_values" not in ledger.current("result:29410968:0")["derivation"]


@pytest.mark.skipif(not PRODUCTION.exists(), reason="the saved production run is not on this machine")
def test_the_saved_production_run_still_verifies_after_loading_with_the_new_schema(tmp_path: Path):
    from new_meta.core.primary_analysis_alignment import alignment_status, require_current_compiled_alignment

    copy = tmp_path / "run"
    shutil.copytree(PRODUCTION, copy)
    project = Project("ma-001 replay", resume_dir=copy)
    protocol = _protocol()
    for pmid, index in (("29410968", 0), ("29410968", 1), ("39673144", 0)):
        study = ExtractedStudy.model_validate_json((copy / f"extraction/{pmid}.json").read_text())
        assert alignment_status(project, protocol, study, index)["status"] == "match"
    require_current_compiled_alignment(project)


# --- the engine groups by the closed value ------------------------------------------------------


def test_the_production_contrasts_pool_the_topical_route_across_two_trials():
    result = run_complex_rct(_records(CLOSED), subgroup_variables=_route_spec())
    # The primary analysis is the one production computed.
    assert result.pooled_effect == pytest.approx(FIXTURE["saved_pooled"]["pooled_effect"])
    assert (result.n_studies, result.n_contrasts) == (2, 3)

    [route] = result.moderator_subgroups["variables"]
    assert route["variable_id"] == ROUTE_ID and route["label"] == ROUTE
    topical, intravenous, combined = (route["values"][key] for key in ("topical", "intravenous", "combined"))
    assert topical["pooled"] and topical["n_studies"] == 2 and topical["study_ids"] == ["study:29410968", "study:39673144"]
    assert intravenous == {"n_studies": 1, "n_contrasts": 1, "study_ids": ["study:29410968"], "pooled": False}
    assert combined["n_studies"] == 0 and not combined["pooled"]
    # Only one value is shared by two trials: no between-value test, and the reason says so.
    assert route["between"] is None
    assert route["not_run_reason"] == "fewer than two values with at least two trials each"

    # The topical estimate is REML over the two trials' own topical contrasts (CI-derived precision).
    effects = []
    for item in FIXTURE["method_inputs"]:
        if CLOSED[item["result_id"]] == "topical":
            estimate = item["estimate"]
            se = (estimate["ci_upper"] - estimate["ci_lower"]) / (2 * 1.959963984540054)
            effects.append(StudyEffect(study_id=item["study_id"], study_label=item["study_id"],
                                       yi=estimate["estimate"], vi=se * se, se=se))
    expected = random_effects_reml(effects, "MD", "topical")
    assert topical["estimate"] == pytest.approx(expected.pooled_effect)
    assert (topical["ci_lower"], topical["ci_upper"]) == pytest.approx((expected.ci_lower, expected.ci_upper))


def test_the_saved_labels_were_three_one_study_groups_and_labels_group_nothing_now():
    saved = FIXTURE["saved_moderator_subgroups"]["labels"]
    assert sorted(saved) == ["Intravenous (IV) route", "Topical (intra-articular) TXA", "Topical (intra-articular) route"]
    assert all(item == {"n_studies": 1, "pooled": None} for item in saved.values())

    # The old free-text label is ignored; without closed values nothing is grouped.
    unlabelled = [{**record, "moderator": "Topical"} for record in _records()]
    [route] = run_complex_rct(unlabelled, subgroup_variables=_route_spec()).moderator_subgroups["variables"]
    assert route["not_run_reason"] == "no closed subgroup values"
    assert sorted(route["unassigned"]) == sorted(CLOSED)
    assert all(value["n_studies"] == 0 for value in route["values"].values())
    # A protocol variable without a derived vocabulary has no values at all.
    [route] = run_complex_rct(_records(CLOSED), subgroup_variables=_route_spec(values=())).moderator_subgroups["variables"]
    assert route["values"] == {} and route["not_run_reason"] == "no closed subgroup values"
    # No prespecified subgroup variable: no moderator analysis.
    assert run_complex_rct(_records(CLOSED)).moderator_subgroups == {}


def test_not_reported_contrasts_are_listed_never_grouped():
    closed = {**CLOSED, "result:39673144:0": "not_reported"}
    [route] = run_complex_rct(_records(closed), subgroup_variables=_route_spec()).moderator_subgroups["variables"]
    assert route["not_reported"] == ["result:39673144:0"]
    assert route["values"]["topical"]["n_studies"] == 1 and route["not_run_reason"] == (
        "fewer than two values with at least two trials each")


# --- the executor carries the closed values; the whole compiled route --------------------------


def _compiled_project(tmp_path: Path, studies, protocol):
    from primary_alignment_fixture import approve_synthetic_method_fixture
    from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.primary_analysis_alignment import UNATTENDED_RUN_FILE
    from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs

    reconcile_extracted_rct_designs(protocol, studies)
    project = Project("closed subgroups compiled", output_dir=tmp_path / "project")
    project.save_json("protocol.json", protocol)
    project.save_json("subgroup_vocabulary.json", _vocabulary(protocol), subdir="extraction")
    project.save_json("all_extractions.json", studies, subdir="extraction")
    assert migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies).skipped_results == []
    compile_project_method_plan(project, protocol, enforce=True)
    approve_synthetic_method_fixture(project, protocol, studies)
    project.save_json(UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": True})
    return project


def test_the_compiled_route_groups_by_closed_values_and_refuses_one_outside_the_vocabulary(tmp_path: Path):
    from test_multi_arm_continuous import _protocol as tka_protocol
    from test_unattended_primary_analysis_set import _production_studies
    from new_meta.core.pipeline_runner import PipelineRunner

    protocol = tka_protocol().model_copy(update={"subgroup_variables": [ROUTE]})
    studies = _production_studies()   # 22053253, 39673144, 27222617 (IV, topical), 24308672 (two topical doses)
    closed = [["intravenous"], ["topical"], ["intravenous", "topical"], ["topical", "subcutaneous"]]
    for study, values in zip(studies, closed):
        for row, value in zip(study.outcomes, values):
            row.subgroup_values = {ROUTE_ID: value}
    project = _compiled_project(tmp_path, studies, protocol)

    phase = PipelineRunner(project).run_compiled_method_synthesis()
    assert phase.status.value == "succeeded", phase.summary
    payload = project.load_json("synthesis_result.json", subdir="analysis")["engine_payload"]
    assert payload["n_studies"] == 4 and payload["n_contrasts"] == 6
    [route] = payload["moderator_subgroups"]["variables"]
    values = route["values"]
    assert values["intravenous"]["n_studies"] == 2 and values["intravenous"]["pooled"]
    assert values["topical"]["n_studies"] == 3 and values["topical"]["pooled"]
    assert values["topical"]["n_contrasts"] == 3
    # 27222617 gives both routes against one control: the test is run and marked approximate.
    assert route["between"]["df"] == 1 and route["between"]["approximate"] is True and route["not_run_reason"] == ""
    # The 500 mg arm's value is outside the vocabulary: refused at the executor, never regrouped.
    refused_id = "result:24308672:1"
    assert route["unassigned"] == [refused_id]
    audit = project.load_json("method_input_audit.json", subdir="analysis")
    assert audit["subgroup_values_refused"] == {refused_id: [
        {"variable_id": ROUTE_ID, "value": "subcutaneous", "reason": "value_outside_vocabulary"}]}
    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "primary_timepoints_merged")
    contrasts = warning["context"]["studies"]["study:27222617"]["contrasts"]
    assert sorted(item["subgroup_values"][ROUTE_ID] for item in contrasts) == ["intravenous", "topical"]

    # The manuscript facts carry the engine's numbers, per variable and value.
    from new_meta.core.manuscript_facts import _compiled_subgroup_facts
    effects, analyses = _compiled_subgroup_facts(project.load_json("synthesis_result.json", subdir="analysis"),
                                                 protocol=protocol, project=project)
    assert {item["subgroup_value"]: item["pooled_effect"] for item in effects} == {
        "intravenous": values["intravenous"]["estimate"], "topical": values["topical"]["estimate"]}
    assert effects[0]["analysis_group"] == ROUTE and effects[0]["subgroup_value_definition"]
    [analysis] = analyses
    assert analysis["between_value_test"] == route["between"] and analysis["unassigned_results"] == 1
    assert [item["value"] for item in analysis["values"]] == ["intravenous", "topical", "combined"]


# --- siblings ----------------------------------------------------------------------------------


def test_manuscript_facts_say_why_a_subgroup_analysis_was_not_run(tmp_path: Path):
    from new_meta.core.manuscript_facts import _compiled_subgroup_facts

    result = run_complex_rct(_records(CLOSED), subgroup_variables=_route_spec())
    effects, analyses = _compiled_subgroup_facts({"engine_payload": result.model_dump(mode="json")},
                                                 protocol=_protocol(), project=Project("facts", output_dir=tmp_path))
    assert [(item["subgroup_value"], item["n_studies"]) for item in effects] == [("topical", 2)]
    assert effects[0]["outcome_name"] == f"{_protocol().pico.outcome_primary} — topical"
    assert analyses[0]["not_run_reason"] == "fewer than two values with at least two trials each"
    assert analyses[0]["between_value_test"] is None


def test_pairwise_subgroups_are_the_closed_values_of_each_study_s_selected_row(tmp_path: Path):
    from new_meta.main import _closed_value_subgroup_results
    from new_meta.schemas.study import OutcomeData, StudyCharacteristics

    protocol = _protocol()
    project = Project("pairwise subgroups", output_dir=tmp_path)
    routes = {"S1": "intravenous", "S2": "intravenous", "S3": "topical", "S4": "topical", "S5": "not_reported"}
    studies = [ExtractedStudy(characteristics=StudyCharacteristics(study_id=sid, pmid=sid),
                              outcomes=[OutcomeData(outcome_name="Total blood loss", subgroup=f"{route} route, as worded by {sid}",
                                                    subgroup_values={ROUTE_ID: route})])
               for sid, route in routes.items()]
    effects = [StudyEffect(study_id=sid, study_label=sid, yi=-200.0 - 30 * n, vi=900.0 + 50 * n, se=math.sqrt(900.0 + 50 * n),
                           subgroup=f"{routes[sid]} route, as worded by {sid}")
               for n, sid in enumerate(routes)]
    project.save_json("effect_selection_audit.json", [
        {"row_id": f"{sid}:0", "study_id": sid, "outcome_index": 0, "decision": "selected_within_study",
         "in_final_primary_analysis": True} for sid in routes], subdir="analysis")

    # No vocabulary: the free-text labels group nothing, and the warning says why.
    assert _closed_value_subgroup_results(project, protocol, studies, effects) == {}
    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "subgroup_analysis_not_run")
    assert warning["context"]["variables"] == {ROUTE: "subgroup analysis not run: no closed subgroup values"}

    project.save_json("subgroup_vocabulary.json", _vocabulary(protocol), subdir="extraction")
    results = _closed_value_subgroup_results(project, protocol, studies, effects)
    assert list(results) == [ROUTE]
    pooled = {item.outcome_name.rsplit(" — ", 1)[1]: item for item in results[ROUTE]}
    assert sorted(pooled) == ["intravenous", "topical"] and all(item.n_studies == 2 for item in pooled.values())
    assert pooled["topical"].subgroup_q_between is not None
    assert not [item for item in project.load_json("pipeline_warnings.json") if item["code"] == "subgroup_analysis_not_run"]


def test_pairwise_subgroup_analysis_leaves_out_a_study_without_a_value():
    studies = [StudyEffect(study_id=str(n), study_label=str(n), yi=float(n), vi=1.0, se=1.0,
                           subgroup=("a" if n < 2 else "b" if n < 4 else None)) for n in range(6)]
    names = sorted(item.outcome_name for item in subgroup_analysis(studies, "MD", "x"))
    assert names == ["x — a", "x — b"]   # no "Overall" group of the unvalued studies


def test_a_row_takes_its_own_result_level_risk_of_bias_not_the_best_worded_one():
    from new_meta.core.effect_selection import build_rob_lookup, rob_for_study
    from new_meta.core.extraction_ledger import result_entity_id
    from new_meta.schemas.risk_of_bias import ResultRoBAssessment, RoBTargetEffect

    study = _studies()["39673144"]
    second = study.outcomes[0].model_copy(deep=True)
    second.treatment_arm = "Group C: 3 g intra-articular TXA (tranexamic acid)"
    study.outcomes.append(second)   # the 1 g and 3 g arms: same name, window and label
    assessments = [
        ResultRoBAssessment(assessment_id=f"rob:{index}", result_id=result_entity_id(study, index),
                            study_id="39673144", outcome_name=row.outcome_name, timepoint=str(row.timepoint or ""),
                            subgroup=str(row.subgroup or ""), tool_used="RoB 2", tool_version="2019",
                            target_effect=RoBTargetEffect.ASSIGNMENT, overall_judgment=judgment)
        for index, (row, judgment) in enumerate(zip(study.outcomes, ["Some concerns", "High risk"]))
    ]
    lookup = build_rob_lookup(list(reversed(assessments)))
    assert rob_for_study(study, None, lookup, outcome=study.outcomes[0]).overall_judgment == "Some concerns"
    assert rob_for_study(study, None, lookup, outcome=study.outcomes[1]).overall_judgment == "High risk"
