"""A verified row whose own trial cannot be identified is left out, not a stop for the synthesis.

Local replay of production ma-001 (2026-09-29): once Wang 2015 verified, its
verifier listed the study cohort as one trial unit with role "uncertain" and no
registration or name, and the unattended compiled synthesis stopped for a
person to "clarify source-backed trial contributions" - with four verified
trials waiting. Unattended, that row is now left out and named
(trial_identity_unresolved); overlapping trial units still need a person.
"""
from __future__ import annotations

import json
from pathlib import Path

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ma001_wang2015_verified_row.json").read_text())


def test_an_unidentifiable_verified_trial_is_left_out_unattended(tmp_path, monkeypatch):
    import new_meta.core.primary_analysis_alignment as alignment
    from new_meta.core.extraction_ledger import result_entity_id
    from new_meta.core.project import Project
    from new_meta.schemas.protocol import ResearchProtocol
    from new_meta.schemas.study import ExtractedStudy

    study = ExtractedStudy.model_validate(FIXTURE["study"])
    units = study.outcomes[0].primary_analysis_alignment.assessment.verification.trial_units
    assert [unit.role for unit in units] == ["uncertain"]
    project = Project("trial identity", output_dir=tmp_path)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    project.save_json(alignment.UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": True})
    project.save_json("full_text_screening.json", [{"paper": {"pmid": "26550418"}, "decision": "include",
                                                     "publication_role": "primary_publication"}], subdir="screening")
    protocol = ResearchProtocol.model_validate({
        "research_question": "TXA in TKA", "study_design": "RCT", "review_family": "intervention_rct",
        "pico": {"population": "Adults undergoing TKA", "intervention": "Tranexamic acid",
                 "comparator": "Placebo", "outcome_primary": "Total blood loss (mL)"}})
    monkeypatch.setattr(alignment, "alignment_status", lambda *args: {"status": "match", "reason": "match"})
    result_id = result_entity_id(study, 0)
    left_out = alignment.unattended_unverified_results(project, protocol, [result_id])
    assert left_out == {result_id: alignment.TRIAL_IDENTITY_UNRESOLVED}

    alignment.report_unverified_results_left_out(project, left_out)
    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "unverified_results_left_out")
    assert "could not be told apart" in warning["message"]
