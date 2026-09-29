"""Release gates read what the stages write today.

Production ma-001 (job meta-20260928185649, 2026-09-28) ran the compiled-method
route, which writes analysis/synthesis_result.json and never meta_results.json.
Three checks read only meta_results.json and went silent on it: the risk-of-bias
completeness gate passed unchecked, source coverage never marked a record as used
in the primary analysis, and the benchmark compared no pooled effect. The
adapter listed analysis/meta_analysis.json, a file no route writes. And when the
delivered manuscript was the blocked stub, the citation-contract gate reported
"16 rows missing" instead of the manuscript having no reference list.
"""
from __future__ import annotations

import json

PRIMARY = ["result:29410968:0", "result:29410968:1", "result:39673144:0"]


def _domain(name):
    return {"domain": name, "judgment": "Low risk", "support": "Computer-generated sequence.",
            "source_page": 1, "source_section": "Methods", "source_quote": "via a computer-generated method."}


def _assessment(result_id, status="complete"):
    return {"study_id": result_id.split(":")[1], "tool_used": "RoB 2", "tool_version": "RoB 2 (2019)",
            "assessment_id": f"rob:{result_id}", "result_id": result_id, "outcome_name": "Total blood loss (mL)",
            "assessment_status": status, "overall_judgment": "Low risk", "is_synthetic": False,
            "domains": [_domain(name) for name in ("Randomization process", "Deviations", "Missing data",
                                                   "Measurement", "Selection of the reported result")],
            "requires_adjudication": status == "draft"}


def _project(tmp_path, assessments):
    from new_meta.core.project import Project
    project = Project("compiled gates", output_dir=tmp_path)
    project.save_json("synthesis_result.json", {"input_result_ids": PRIMARY, "n_studies": 2,
        "primary_estimates": [{"measure": "MD", "estimate": -251.05519396348726, "ci_lower": -345.34285150005326,
                               "ci_upper": -156.76753642692123}],
        "heterogeneity": {"tau_squared": 0.0, "i_squared": 0.0}}, subdir="analysis")
    project.save_json("rob_result_assessments.json", assessments, subdir="risk_of_bias")
    return project


def test_compiled_route_risk_of_bias_completeness_is_checked(tmp_path):
    from new_meta.core.artifact_package import _build_risk_of_bias_completeness_review
    ready = _build_risk_of_bias_completeness_review(_project(tmp_path / "a", [_assessment(i) for i in PRIMARY]))
    assert ready["passed"] and ready["summary"]["primary_contributing_results"] == 3
    assert ready["summary"]["primary_contributing_studies"] == 2
    # The release gate reads it: 3 formal assessments for 3 results of 2 trials is complete.
    from new_meta.core.artifact_package_submission import _risk_of_bias_completeness_is_complete
    assert _risk_of_bias_completeness_is_complete(ready["summary"])
    blocked = _build_risk_of_bias_completeness_review(_project(tmp_path / "b", [
        _assessment(PRIMARY[0]), _assessment(PRIMARY[1], "draft")]))
    assert not blocked["passed"]
    assert {(item["result_id"], item["code"]) for item in blocked["issues"]} == {
        (PRIMARY[1], "primary_result_rob_pending_adjudication"), (PRIMARY[2], "primary_result_missing_formal_rob")}


def test_compiled_pooled_effect_reaches_the_benchmark_comparison():
    from new_meta.core.benchmark_manifest import _compiled_primary_as_meta_results
    primary = _compiled_primary_as_meta_results({
        "input_result_ids": PRIMARY, "n_studies": 2,
        "primary_estimates": [{"measure": "MD", "estimate": -251.06, "ci_lower": -345.34, "ci_upper": -156.77}],
        "heterogeneity": {"tau_squared": 0.0}})["primary_outcome"]
    assert (primary["pooled_effect"], primary["effect_measure"], primary["n_studies"]) == (-251.06, "MD", 2)


def test_a_skipped_contract_names_the_missing_reference_list(tmp_path):
    from new_meta.core.quality_gates import _check_citation_contract
    manuscript = tmp_path / "manuscript"
    manuscript.mkdir()
    (manuscript / "claim_map.json").write_text(json.dumps([{"id": "intro-objective", "claim": "x"}]))
    (manuscript / "citation_contract.json").write_text(json.dumps({"schema_version": 1, "status": "skipped",
                                                                   "items": []}))
    (manuscript / "final_claim_map_citation_plan.json").write_text(json.dumps({"status": "skipped",
                                                                              "reason": "no_reference_entries"}))
    check = _check_citation_contract(tmp_path)
    assert check["status"] == "fail" and check["cause"] == "no_reference_entries"
    assert "no numbered reference list" in check["message"]
