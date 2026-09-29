"""One bounded retry for every evidence stage whose model output can be unusable.

2026-09-28 (ma-001): verification had its own three-attempt loop, study-level
risk of bias turned any failure into "Full text not available", title/abstract
screening forwarded a failed call with only an exception name, evidence
understanding built a card from the extraction and reported status "ok", and
extraction followed two failures with a looser "fill in what you can" prompt.
Each now goes through core/llm_retry.py and records why an entity has no model
judgment and what was done instead.
"""
from __future__ import annotations

import json

import pytest


def test_unusable_output_is_asked_again_stricter_then_succeeds():
    from new_meta.core.llm_retry import STRICT_OUTPUT_NOTICE, bounded_output_call, strict_suffix
    prompts = []

    def call(attempt):
        prompts.append("ask" + strict_suffix(attempt))
        if attempt < 3:
            raise ValueError("off-schema")
        return "judgment"

    assert bounded_output_call(call, stage="s", entity_id="e", attempts=3) == "judgment"
    assert prompts == ["ask", "ask" + STRICT_OUTPUT_NOTICE, "ask" + STRICT_OUTPUT_NOTICE]


def test_exhaustion_raises_a_classified_error_chained_to_the_last_failure():
    from new_meta.core.llm_retry import MODEL_OUTPUT_UNUSABLE, StageOutputUnusable, bounded_output_call
    calls = []

    def call(attempt):
        calls.append(attempt)
        raise json.JSONDecodeError("bad", "{", 0)

    with pytest.raises(StageOutputUnusable) as caught:
        bounded_output_call(call, stage="risk_of_bias", entity_id="123", attempts=3)
    assert calls == [1, 2, 3]
    assert caught.value.reason == MODEL_OUTPUT_UNUSABLE
    assert (caught.value.stage, caught.value.entity_id, caught.value.attempts) == ("risk_of_bias", "123", 3)
    assert isinstance(caught.value.last_error, json.JSONDecodeError)


def test_transport_errors_and_unrecorded_responses_are_not_re_asked():
    from new_meta.core.llm import LLMOutputError
    from new_meta.core.llm_retry import bounded_output_call, output_unusable

    class ProviderDown(RuntimeError):
        pass

    for error in (ProviderDown("503"), OSError("disk full")):
        calls = []

        def call(attempt, error=error):
            calls.append(attempt)
            raise error

        with pytest.raises(type(error)):
            bounded_output_call(call, stage="s", entity_id="e", attempts=3)
        assert calls == [1]
    # The client wraps a failed durable observation write; that is not the
    # model's output, and a response that could not be recorded is never regenerated.
    try:
        try:
            raise OSError("write failed")
        except OSError as cause:
            raise LLMOutputError("Source-faithful raw response observer failed") from cause
    except LLMOutputError as wrapped:
        assert not output_unusable(wrapped)
    assert output_unusable(LLMOutputError("LLM returned empty text after retries."))


def test_stage_failures_are_recorded_once_per_entity_and_cleared_on_success(tmp_path):
    from new_meta.core.llm_retry import clear_stage_failure, load_stage_failures, record_stage_failure
    from new_meta.core.project import Project
    project = Project("stage failures", output_dir=tmp_path)
    for _ in range(2):
        record_stage_failure(project, stage="risk_of_bias", entity_id="123", consequence="reported as not assessed",
                             error_type="ValueError", attempts=3)
    record_stage_failure(project, stage="risk_of_bias", entity_id="456", consequence="reported as not assessed")
    assert [item["entity_id"] for item in load_stage_failures(project)] == ["123", "456"]
    warnings = [item for item in project.load_json("pipeline_warnings.json") if item["code"] == "model_output_unusable"]
    assert len(warnings) == 1 and warnings[0]["context"]["entities"] == ["123", "456"]
    clear_stage_failure(project, "risk_of_bias", "123")
    clear_stage_failure(project, "risk_of_bias", "456")
    assert load_stage_failures(project) == []
    assert not [item for item in project.load_json("pipeline_warnings.json") if item["code"] == "model_output_unusable"]


def _rob_study():
    from new_meta.schemas.study import ExtractedStudy, StudyCharacteristics
    return ExtractedStudy(characteristics=StudyCharacteristics(
        study_id="S1", pmid="26550418", title="Intra-articular TXA in TKA", study_design="parallel_rct",
        authors=["Wang G"], year=2015), outcomes=[])


def test_a_failed_risk_of_bias_assessment_is_not_reported_as_missing_full_text(tmp_path, monkeypatch):
    from new_meta.agents.rob_agent import RoBAgent
    from new_meta.core.llm_retry import STAGE_OUTPUT_ATTEMPTS, load_stage_failures
    from new_meta.core.project import Project
    from new_meta.schemas.risk_of_bias import StudyRoB

    project = Project("rob failure", output_dir=tmp_path)
    agent = RoBAgent()
    calls = []

    def empty_judgment(prompt, schema, **kwargs):
        calls.append(prompt)
        return StudyRoB(study_id="", tool_used="")  # "{}" validates; it is not a judgment

    monkeypatch.setattr(agent, "call_llm_structured", empty_judgment)
    monkeypatch.setattr(agent, "_shared_cache_path", lambda _project: tmp_path / "rob_cache.json")
    results = agent.run([_rob_study()], {"26550418": {"full_text": "Randomized trial. " * 50}}, project)
    assert len(calls) == STAGE_OUTPUT_ATTEMPTS
    assert results[0].is_synthetic
    supports = {domain.support for domain in results[0].domains}
    assert supports == {"Risk-of-bias assessment could not complete: the model gave no usable judgment in its "
                        "bounded attempts"}
    assert [(item["stage"], item["entity_id"]) for item in load_stage_failures(project)] == [
        ("risk_of_bias", "26550418")]


def test_title_abstract_failures_are_forwarded_named_and_kept_out_of_kappa(tmp_path, monkeypatch):
    from new_meta.agents.screening_agent import ScreeningAgent
    from new_meta.core.llm_retry import load_stage_failures
    from new_meta.core.project import Project

    agent = ScreeningAgent()
    project = Project("ta failure", output_dir=tmp_path)
    paper = {"pmid": "26550418", "title": "TXA in TKA", "abstract": "Randomized trial."}
    row = agent._ta_forward_to_full_text(paper, [{"error": "x"}], "x",
                                         failure={"reason": "model_output_unusable", "error_type": "ValueError",
                                                  "attempts": 3})
    monkeypatch.setattr(agent, "_screen_title_abstract", lambda papers, protocol: [row])
    monkeypatch.setattr(agent, "_retain_known_source_primary_records", lambda rows, protocol: rows)
    included, excluded = agent.screen_title_abstract([paper], object(), project)
    assert included == [paper] and excluded == []
    failure = load_stage_failures(project)[0]
    assert (failure["stage"], failure["entity_id"], failure["reason"]) == (
        "title_abstract_screening", "26550418", "model_output_unusable")

    judged = {"paper": paper, "decision": "exclude"}
    monkeypatch.setattr(agent, "_screen_title_abstract", lambda papers, protocol: [row, judged])
    monkeypatch.setattr(agent, "_screen_ta_with_temp", lambda papers, protocol, temperature: [judged, judged])
    kappas = []
    monkeypatch.setattr(agent, "_cohens_kappa", lambda a, b: kappas.append((a, b)) or 1.0)
    merged = agent._dual_screen_title_abstract([paper, paper], object())
    assert kappas == [(["exclude"], ["exclude"])]  # the failed call is not a vote
    assert merged[0]["decision"] == "exclude"  # the reviewer that judged it speaks for it


def test_route_based_full_text_counts_as_parsed_full_text(tmp_path):
    import hashlib
    from new_meta.core.real_smoke import _check_pdf_or_fulltext

    papers = tmp_path / "papers"
    papers.mkdir()
    text = "[PAGE 1]\nSOURCE: Europe PMC fullTextXML\n\nRandomized trial of tranexamic acid."
    (papers / "28331851.fulltext.txt").write_text(text)
    (papers / "30755381.abstract.txt").write_text("Abstract only.")
    (tmp_path / "pdf_download_results.json").write_text(json.dumps([
        # Production records keep the host's absolute path.
        {"pmid": "28331851", "text_availability": "full_text", "fulltext_route": "europe_pmc_xml",
         "fulltext_source": "europe_pmc_fulltext",
         "fulltext_path": "/data/users/x/projects/y/output/run/papers/28331851.fulltext.txt"},
        {"pmid": "30755381", "text_availability": "abstract_only", "fulltext_route": "europe_pmc_abstract",
         "fulltext_path": str(papers / "30755381.abstract.txt")},
    ]))
    (papers / "parsed_papers.json").write_text(json.dumps({
        "28331851": {"full_text": text, "_source_sha256": hashlib.sha256(text.encode()).hexdigest()},
        "30755381": {"full_text": "Abstract only.", "_source_sha256": "x"},
    }))
    check = _check_pdf_or_fulltext(tmp_path)
    assert check["status"] == "pass"
    assert check["full_texts_by_route"] == {"europe_pmc_xml": 1}

    (papers / "parsed_papers.json").write_text(json.dumps({"30755381": {"full_text": "Abstract only."}}))
    assert _check_pdf_or_fulltext(tmp_path)["status"] == "fail"


def test_an_internally_inconsistent_row_is_left_out_not_fatal(tmp_path):
    """A local ma-001 run (2026-09-29, 29 studies) stopped at the evidence ledger
    because one dichotomous row had more control events than control
    participants; that result is now dropped and named, and the rest migrate."""
    from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
    from new_meta.core.project import Project
    from new_meta.schemas.protocol import ResearchProtocol
    from new_meta.schemas.study import ExtractedStudy

    protocol = ResearchProtocol.model_validate({
        "research_question": "TXA in TKA", "study_design": "RCT", "effect_measure": "RR",
        "pico": {"population": "Adults undergoing TKA", "intervention": "Tranexamic acid",
                 "comparator": "Placebo", "outcome_primary": "Allogeneic transfusion"}})
    study = ExtractedStudy.model_validate({
        "characteristics": {"study_id": "S1", "pmid": "111", "title": "TXA trial", "study_design": "parallel_rct"},
        "outcomes": [
            {"outcome_name": "Allogeneic transfusion", "outcome_type": "dichotomous", "events_intervention": 1,
             "total_intervention": 12, "events_control": 32, "total_control": 13},
            {"outcome_name": "Allogeneic transfusion", "outcome_type": "dichotomous", "events_intervention": 2,
             "total_intervention": 40, "events_control": 9, "total_control": 40},
        ]})
    project = Project("inconsistent row", output_dir=tmp_path)
    report = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=[study])
    assert [item["reason"] for item in report.skipped_results] == ["extracted_numbers_inconsistent"]
    assert "control events cannot exceed total" in report.skipped_results[0]["detail"]


def test_risk_of_bias_quotes_ground_across_pdf_hyphenation_and_run_together_words():
    """Local ma-001 run, 2026-09-29: four result-level risk-of-bias assessments were
    refused as ungrounded although every quote was in the report - the PDF layer
    wrote "triple-\\nblinded" / "con-\\ntrolled" (38846341) and ran words together,
    "Thecalculatedblood" (27222617). Excerpts from those parsed texts."""
    from new_meta.agents.rob_agent import RoBAgent
    hyphenated = ("MATERIALS AND METHODS\nThis study, which is a prospective, randomized, triple-\nblinded "
                  "(patient, surgical team, data collection team) con-\ntrolled trial, was performed in "
                  "Damascus, Syria. It was also registered in clinical trials.")
    assert RoBAgent._quote_occurs("This study, which is a prospective, randomized, triple-blinded (patient, "
                                  "surgical team, data collection team) controlled trial, was performed in "
                                  "Damascus, Syria.", hyphenated)
    run_together = ("Theprimaryoutcomemeasureswerethecalculatedbloodloss\nandtheneed[105_TD$DIFF]forallogeneic"
                    "bloodtransfusion.Thecalculatedblood\nloss was estimated according to Sehat et "
                    "al[106_TD$DIFF].17 as the sum of the\nchangeinbloodvolumeplusthevolumeoftransfusedblood.")
    assert RoBAgent._quote_occurs("The calculatedblood loss was estimated according to Sehat et al[106_TD$DIFF].17 "
                                  "as the sum of the changeinbloodvolumeplusthevolumeoftransfusedblood.", run_together)
    assert not RoBAgent._quote_occurs("The calculated blood loss was estimated by an independent assessor "
                                      "blinded to allocation.", run_together)
