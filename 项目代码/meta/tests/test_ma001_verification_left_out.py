"""Why three of five included ma-001 trials were left out, and what each now reports.

Production acceptance run ma-001 (job meta-20260928185649, tranexamic acid in
total knee arthroplasty, 2026-09-28) included five RCTs and pooled two:

- Wang 2015: the verifier quoted the right Table 2 row every round, but the
  numeric tokenizer read "1136.3 ± 224.52 -12.8856" (control mean ± SD, then the
  t statistic) as one interval, so the control mean and SD were "not anchored"
  in three rounds and the row ended "verification_not_completed".
- Yang 2020: the source writes its registry number with U+2010 hyphens
  ("ChiCTR‐INR‐16010287"); the verifier typed ASCII hyphens, the identity was
  refused, and a clinical judgment the verifier had stated (attrition read as
  postrandomization selection) was reported as "verification_issue_history_required".
- Zhang 2019: a correct clinical exclusion - every arm, the "double placebo"
  one included, received intravenous TXA - reported as bookkeeping.
- Ye 2024, 3 g arm: a real abstract-versus-results conflict (568.70 vs 567.7
  mL), reported as "verification_not_completed".

Fixture: the verifier records and source passages cut from that run.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ma001_verification_left_out.json").read_text())


def test_table_columns_are_not_merged_into_one_interval():
    from new_meta.core.extraction_verification import numeric_value_in_quote, quote_is_anchored
    wang = FIXTURE["wang2015"]
    for finding in wang["findings"]:
        assert quote_is_anchored(finding["quote"], finding["source_location"], wang["table_excerpt"])
        assert numeric_value_in_quote(finding["reported_value"], finding["quote"], finding["field"],
                                      plus_minus_sd=True), finding["field"]
    # What production recorded for the same response, now gone.
    assert {item["field"] for item in wang["recorded_reasons"]} == {"mean_control", "sd_control"}


@pytest.mark.parametrize(("text", "tokens"), [
    ("1136.3 ± 224.52 -12.8856", ["1136.3 ± 224.52", "-12.8856"]),
    ("10-20", ["10-20"]),
    ("10 - 20", ["10 - 20"]),
    ("(-15.2 - -9.4)", ["-15.2 - -9.4"]),
    ("12/50", ["12/50"]),
])
def test_a_dash_after_a_space_signs_the_next_number(text, tokens):
    from new_meta.core.primary_analysis_alignment import _NUMERIC_TOKEN, _normalized_quote
    assert [match.group() for match in _NUMERIC_TOKEN.finditer(_normalized_quote(text))] == tokens


def test_typographic_hyphens_anchor_an_ascii_registry_number():
    from new_meta.core.extraction_verification import quote_is_anchored
    yang = FIXTURE["yang2020"]
    unit = yang["trial_units"][0]
    assert "‐" in unit["quote"] and "‐" not in unit["registry_id"]
    assert quote_is_anchored(unit["registry_id"], unit["source_location"], unit["quote"])
    assert quote_is_anchored(unit["quote"], unit["source_location"], yang["registration_excerpt"])
    assert any(item["code"] == "trial_identifier_not_anchored" for item in yang["recorded_reasons"])


def test_en_dashes_stay_distinct_from_hyphens():
    from new_meta.core.primary_analysis_alignment import _normalized_quote
    assert _normalized_quote("5.2–7.1") != _normalized_quote("5.2-7.1")
    assert _normalized_quote("−3.1") == _normalized_quote("-3.1")


def test_each_left_out_row_gets_its_decisive_reason():
    from new_meta.core.verification_outcome import (
        CLINICAL_MISMATCH, NUMERIC_QUOTE_NOT_ANCHORED, SOURCE_NUMERIC_CONFLICT, classify,
    )
    zhang = FIXTURE["zhang2019"]
    classified = classify(zhang["final_reasons"], zhang["retained_clinical_judgments"])
    assert classified["reason"] == CLINICAL_MISMATCH
    assert classified["detail"][0]["dimension"] == "contrast"
    assert "intravenous" in classified["detail"][0]["rationale"].lower()

    yang = FIXTURE["yang2020"]
    classified = classify(yang["recorded_reasons"], yang["retained_clinical_judgments"])
    assert classified["reason"] == CLINICAL_MISMATCH
    assert classified["detail"][0] == {**classified["detail"][0], "field": "selection_timing",
                                       "verdict": "randomized_total_effect_required"}

    ye = FIXTURE["ye2024_3g"]
    classified = classify(ye["final_reasons"])
    assert classified["reason"] == SOURCE_NUMERIC_CONFLICT
    assert classified["detail"][0]["observed_values"] == {"results_text": 567.7, "abstract": 568.7}

    assert classify(FIXTURE["wang2015"]["recorded_reasons"])["reason"] == NUMERIC_QUOTE_NOT_ANCHORED


def test_the_engines_own_stop_after_a_nonmatch_is_a_clinical_finding():
    from new_meta.core.verification_outcome import CLINICAL_MISMATCH, classify
    reasons = [{"code": "verification_clinical_nonmatch_retained", "error_type": "LLMOutputError"}]
    assert classify(reasons)["reason"] == CLINICAL_MISMATCH


def test_the_checker_prompt_separates_attrition_from_postrandomization_selection():
    from new_meta.prompts.extraction_prompts import EXTRACTION_CHECK_PROMPT
    assert "attrition" in EXTRACTION_CHECK_PROMPT and "missing outcome data" in EXTRACTION_CHECK_PROMPT


def test_the_left_out_warning_names_each_reason(tmp_path):
    from new_meta.core.primary_analysis_alignment import report_unverified_results_left_out
    from new_meta.core.project import Project
    project = Project("left out reasons", output_dir=tmp_path)
    report_unverified_results_left_out(project, {
        "result:31348286:0": "clinical_mismatch", "result:39673144:1": "source_numeric_conflict",
        "result:33094562:0": "clinical_mismatch"})
    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "unverified_results_left_out")
    assert "not to be the review's comparison" in warning["message"]
    assert "conflicting numbers" in warning["message"]
    assert "did not complete or did not match" not in warning["message"]


def test_a_group_size_written_as_a_word_is_anchored():
    """Local ma-001 run, 2026-09-29 (PMID 26403773): "There were fourteen patients
    in group A" was refused for n_intervention = 14."""
    from new_meta.core.extraction_verification import numeric_value_in_quote
    quote = ("There were fourteen patients in group A (test population) and thirteen patients in "
             "group B (control population).")
    assert numeric_value_in_quote(14, quote, "n_intervention")
    assert numeric_value_in_quote(13, quote, "n_control")
    assert not numeric_value_in_quote(15, quote, "n_intervention")
    assert not numeric_value_in_quote(14, quote, "mean_intervention")
