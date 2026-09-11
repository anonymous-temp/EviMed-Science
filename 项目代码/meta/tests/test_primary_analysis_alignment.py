"""Source-bound clinical alignment admission, independent of numeric extraction."""
import json
import hashlib
from pathlib import Path

import pytest
from pydantic import ValidationError

from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


NUMERIC_SOURCE = (
    "Trial S1 was registered as NCT00000001 and reported 5/100 versus 10/100 events, "
    "with alternative follow-up analyses reporting 6/100 and 7/100 versus 10/100. "
    "Independent trial S2 was registered as NCT00000002 and reported 6/100 versus 10/100 events. "
    "A separately reported HR was 0.66 (95% CI 0.42 to 1.04)."
)
SOURCE = (
    "Participants all had chronic kidney disease. Drug was compared with placebo. "
    "The primary endpoint was a sustained 50% eGFR decline or kidney failure. "
    + NUMERIC_SOURCE
)


def alignment_fixture(tmp_path):
    project = Project("clinical alignment", output_dir=tmp_path)
    source = project.base_dir / "papers" / "trial.txt"
    source.parent.mkdir(exist_ok=True)
    source.write_text(SOURCE)
    protocol = ResearchProtocol(
        research_question="Drug versus placebo for CKD progression",
        pico=PICO(population="Adults with CKD", intervention="Drug", comparator="Placebo",
                  outcome_primary="Sustained eGFR decline of at least 50% or kidney failure"),
        effect_measure="RR", primary_outcome_type="dichotomous",
    )
    study = ExtractedStudy(characteristics=StudyCharacteristics(study_id="S1", title="Trial", year=2025), outcomes=[
        OutcomeData(outcome_name="Renal composite endpoint", outcome_type="dichotomous",
                    events_intervention=5, total_intervention=100, events_control=10, total_control=100,
                    source_quote="The primary endpoint was a sustained 50% eGFR decline or kidney failure.",
                    source_location="Results", source_quote_verified=True),
    ])
    return project, protocol, study, source


def assessment_payload(*, source_outcome=None, study_id="S1", **statuses):
    quotes = {
        "outcome": "The primary endpoint was a sustained 50% eGFR decline or kidney failure.",
        "population": "Participants all had chronic kidney disease.",
        "contrast": "Drug was compared with placebo.",
    }
    assessment = {"outcome_index": 0, **{
        name: {"status": statuses.get(name, "match"), "rationale": "The source supports the judgment.",
               "quote": quote, "source_location": "Methods and Results"}
        for name, quote in quotes.items()
    }}
    from verification_fixture import verification_payload
    from new_meta.core.extraction_verification import numeric_fields
    outcome = source_outcome or OutcomeData(outcome_name="Renal composite endpoint",outcome_type="dichotomous",
        events_intervention=5,total_intervention=100,events_control=10,total_control=100)
    assessment["verification"] = verification_payload(outcome, assessment,
        numeric_quotes={field: NUMERIC_SOURCE for field in numeric_fields(outcome)},
        registry_id="NCT00000002" if study_id == "S2" else "NCT00000001", trial_quote=NUMERIC_SOURCE)
    return assessment


def stamp_fixture(tmp_path, **statuses):
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    project, protocol, study, source = alignment_fixture(tmp_path)
    record_checked_alignments(project, protocol, study, [assessment_payload(**statuses)],
                              source_text=SOURCE, source_path=source)
    return project, protocol, study, source


@pytest.mark.parametrize("dimension", ["outcome", "population", "contrast"])
def test_explicit_dimension_mismatch_excludes_without_mutating_source(tmp_path, dimension):
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, _ = stamp_fixture(tmp_path, **{dimension: "mismatch"})
    raw = study.outcomes[0].model_dump(exclude={"primary_analysis_alignment"})
    result = alignment_status(project, protocol, study, 0)
    assert result["status"] == "mismatch"
    assert result["dimensions"][dimension] == "mismatch"
    assert study.outcomes[0].model_dump(exclude={"primary_analysis_alignment"}) == raw


def test_current_verified_semantic_paraphrase_matches(tmp_path):
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, _ = stamp_fixture(tmp_path)
    assert study.outcomes[0].outcome_name != protocol.pico.outcome_primary
    assert alignment_status(project, protocol, study, 0)["status"] == "match"


@pytest.mark.parametrize("mutation", ["protocol", "row", "source", "proof", "manifest"])
def test_changed_protocol_row_source_or_provenance_requires_input(tmp_path, mutation):
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, source = stamp_fixture(tmp_path)
    if mutation == "protocol":
        protocol.pico.outcome_primary = "Sustained 30% eGFR decline"
    elif mutation == "row":
        study.outcomes[0].events_intervention = 6
    elif mutation == "source":
        source.write_text(SOURCE.replace("50%", "30%"))
    elif mutation == "proof":
        study.outcomes[0].primary_analysis_alignment.assessor = "human"
    else:
        for path in (project.base_dir / "extraction" / "primary_alignment").glob("*.json"):
            path.unlink()
    assert alignment_status(project, protocol, study, 0)["status"] == "unknown"


@pytest.mark.parametrize("change", ["missing", "uncertain", "partial_quote", "forged_threshold", "duplicate", "out_of_range"])
def test_unchecked_unanchored_or_ambiguous_judgment_requires_input(tmp_path, change):
    from new_meta.core.primary_analysis_alignment import alignment_status, record_checked_alignments
    project, protocol, study, source = alignment_fixture(tmp_path)
    assessments = [assessment_payload()]
    if change == "missing":
        assessments = []
    elif change == "uncertain":
        assessments[0]["population"]["status"] = "uncertain"
    elif change == "partial_quote":
        assessments[0]["outcome"]["quote"] += " The trial excluded kidney failure."
    elif change == "forged_threshold":
        assessments[0]["outcome"]["quote"] = assessments[0]["outcome"]["quote"].replace("50%", "30%")
    elif change == "duplicate":
        assessments *= 2
    else:
        assessments[0]["outcome_index"] = 20
    record_checked_alignments(project, protocol, study, assessments, source_text=SOURCE, source_path=source)
    assert alignment_status(project, protocol, study, 0)["status"] == "unknown"


def test_model_assessment_cannot_self_stamp_assessor_or_verified_flag():
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    for field, value in [("assessor", "human"), ("verified", True), ("protocol_sha256", "a" * 64)]:
        with pytest.raises(ValidationError):
            PrimaryAlignmentAssessment.model_validate({**assessment_payload(), field: value})


def test_selector_admits_verified_paraphrase_and_blocks_unchecked_rows(tmp_path):
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study, _ = stamp_fixture(tmp_path)
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    runner = PipelineRunner(project)
    matched = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert matched.status.value == "succeeded"
    assert len(matched.data["effects"]) == 1
    study.outcomes[0].primary_analysis_alignment = None
    blocked = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert blocked.status.value == "needs_input"
    assert blocked.error_code == "primary_analysis_alignment_required"
    assert blocked.data.get("effects", []) == []
    assert not project.is_step_done("effect_sizes")


def test_selector_excludes_explicit_wrong_threshold_without_fuzzy_override(tmp_path):
    from new_meta.core.pipeline_runner import PipelineRunner
    project, protocol, study, _ = stamp_fixture(tmp_path, outcome="mismatch")
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study])
    assert result.status.value == "succeeded"
    assert result.data["effects"] == []
    assert result.data["selection_audit"][0]["reason"] == "primary_alignment_mismatch"


def test_quote_normalization_preserves_word_boundaries_and_normalizes_whitespace():
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["outcome"]["quote"] = "Participants had a notable renal decline."
    source = SOURCE + " Participants had a not able renal decline."
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), source)
    data["outcome"]["quote"] = "The primary endpoint was a sustained 50% eGFR decline or kidney failure."
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE.replace("kidney failure", "kidney  fa\ufb01lure").replace(" ", "\n")) is False
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE.replace(" ", "\n  "))


def test_alignment_writes_refuse_symlinked_parent_without_writing_outside(tmp_path):
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    project, protocol, study, source = alignment_fixture(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    extraction = project.base_dir / "extraction"
    extraction.rmdir()
    extraction.symlink_to(outside, target_is_directory=True)
    with pytest.raises((OSError, ValueError)):
        record_checked_alignments(project, protocol, study, [assessment_payload()], source_text=SOURCE, source_path=source)
    assert list(outside.iterdir()) == []


def test_boolean_outcome_index_cannot_select_a_row():
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    with pytest.raises(ValidationError):
        PrimaryAlignmentAssessment.model_validate({**assessment_payload(), "outcome_index": True})


def test_generic_review_acceptance_is_not_alignment_authority(tmp_path):
    from new_meta.core.extraction_review import ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, _ = alignment_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    save_extraction_review_decision(project, ExtractionReviewDecision(row_id="S1:0", updated_by="human"))
    assert alignment_status(project, protocol, study, 0)["status"] == "unknown"


def test_explicit_human_dimensions_require_current_versions_and_trusted_identity(tmp_path):
    from new_meta.core.extraction_review import ExtractionReviewDecision, OverrideConflictError, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, _ = stamp_fixture(tmp_path, population="uncertain")
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    version = alignment_status(project, protocol, study, 0)
    decision = ExtractionReviewDecision(
        row_id="S1:0", updated_by="forged-admin", alignment_assessment=assessment_payload(),
        alignment_protocol_sha256=version["protocol_sha256"], alignment_row_sha256=version["row_sha256"],
        alignment_source_sha256=version["source_sha256"],
    )
    with pytest.raises(ValueError, match="authenticated"):
        save_extraction_review_decision(project, decision)
    bad = decision.model_copy(update={"alignment_row_sha256": "0" * 64})
    with pytest.raises(OverrideConflictError):
        save_extraction_review_decision(project, bad, alignment_assessor_id="reviewer-a")
    save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")
    saved = ExtractedStudy.model_validate(project.load_json("all_extractions.json", subdir="extraction")[0])
    assert alignment_status(project, protocol, saved, 0)["status"] == "match"
    assert saved.outcomes[0].primary_analysis_alignment.assessor_id == "reviewer-a"


def test_existing_checker_receives_full_pico_and_cannot_supply_provenance(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, source = alignment_fixture(tmp_path)
    agent = DataExtractionAgent()
    calls = []

    def check_call(messages, schema, **kwargs):
        calls.append((messages[-1]["content"], schema, kwargs))
        return ExtractionCheckResult(data_issues=[], score=9, primary_analysis_alignment=[assessment_payload()])

    monkeypatch.setattr(agent.llm, "structured_output", check_call)
    checked = agent._verify_alignment(study, {"pdf_path": str(source)}, {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol, project)
    assert alignment_status(project, protocol, checked, 0)["status"] == "match"
    assert len(calls) == 1
    for text in (protocol.pico.population, protocol.pico.intervention, protocol.pico.comparator, protocol.pico.outcome_primary):
        assert text in calls[0][0]
    schema = calls[0][1].model_json_schema()
    assert "assessor" not in json.dumps(schema)
    assert "primary_analysis_alignment" not in OutcomeData.model_json_schema()["properties"]


def test_refinement_discards_previous_judgments_and_exhaustion_stays_unknown(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, source = alignment_fixture(tmp_path)
    agent = DataExtractionAgent()
    monkeypatch.setattr("new_meta.agents.data_extraction_agent.MAX_CHECK_ROUNDS", 1)
    monkeypatch.setattr(agent, "_check_extraction", lambda *_: ExtractionCheckResult(data_issues=[], score=4, primary_analysis_alignment=[]))
    checked = agent._verify_alignment(study, {"pdf_path": str(source)}, {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol, project)
    assert alignment_status(project, protocol, checked, 0)["status"] == "unknown"


def test_new_extraction_reconciliation_and_selection_preserve_a_current_proof(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study, source = alignment_fixture(tmp_path)
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "_extract_single", lambda *_: study)
    monkeypatch.setattr(agent, "_check_extraction", lambda *_: ExtractionCheckResult(data_issues=[], score=9, primary_analysis_alignment=[assessment_payload()]))
    rows = agent.run([{"pmid": "S1", "pdf_path": str(source)}], {"S1": {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}}, protocol, project)
    assert alignment_status(project, protocol, rows[0], 0)["status"] == "match"
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=rows, rob_results=[rob])
    assert result.status.value == "succeeded"
    assert len(result.data["effects"]) == 1


def test_new_selection_binding_does_not_revalidate_an_old_pool(tmp_path):
    from types import SimpleNamespace
    from new_meta.core.primary_analysis_alignment import (PrimaryAlignmentRequired, require_current_cached_alignment, save_pool_binding)
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study, _ = stamp_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    require_current_cached_alignment(project, effects=result.data["effects"])
    old_pool = SimpleNamespace(model_dump=lambda **_: {"primary_outcome": {"pooled_effect": 1.257, "studies": ["unreviewed-old-row"]}})
    with pytest.raises(PrimaryAlignmentRequired):
        require_current_cached_alignment(project, meta_results=old_pool)
    new_pool = SimpleNamespace(model_dump=lambda **_: {"primary_outcome": {"pooled_effect": 0.5, "studies": ["S1"]}})
    save_pool_binding(project, new_pool)
    require_current_cached_alignment(project, meta_results=new_pool)
    with pytest.raises(PrimaryAlignmentRequired):
        require_current_cached_alignment(project, meta_results=old_pool)
    study.outcomes[0].events_intervention = 6
    project.save_json("all_extractions.json", [study], subdir="extraction")
    with pytest.raises(PrimaryAlignmentRequired):
        require_current_cached_alignment(project, meta_results=new_pool)


def test_cli_cache_loader_stops_before_exposing_unbound_effects(tmp_path):
    from new_meta.main import _load_cached_study_effects
    from new_meta.core.release_contract import ReleaseBlockedError
    project, _, _, _ = alignment_fixture(tmp_path)
    project.save_json("effect_sizes.json", [], subdir="analysis")
    with pytest.raises(ReleaseBlockedError):
        _load_cached_study_effects(project)
    assert project.load_json("release_decision.json", subdir="package")["ready_for_submission"] is False
    assert project.load_json("primary_alignment_status.json", subdir="analysis")["status"] == "needs_input"


def test_source_change_during_existing_checker_does_not_create_current_proof(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, source = alignment_fixture(tmp_path)
    agent = DataExtractionAgent()
    def changed_source(*_args):
        source.write_text(SOURCE.replace("50%", "30%"))
        return ExtractionCheckResult(data_issues=[], score=9, primary_analysis_alignment=[assessment_payload()])
    monkeypatch.setattr(agent, "_check_extraction", changed_source)
    checked = agent._verify_alignment(study, {"pdf_path": str(source)}, {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol, project)
    assert alignment_status(project, protocol, checked, 0)["status"] == "unknown"


def test_bound_selected_effects_can_be_pooled_and_reloaded(tmp_path):
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    from new_meta.main import _run_meta_analysis_from_effects, _load_cached_meta_results
    project, protocol, study, source = stamp_fixture(tmp_path)
    other = study.model_copy(deep=True)
    other.characteristics.study_id = "S2"
    other.characteristics.title = "Independent trial"
    other.outcomes[0].events_intervention = 6
    other.outcomes[0].primary_analysis_alignment = None
    record_checked_alignments(project, protocol, other, [assessment_payload(source_outcome=other.outcomes[0], study_id="S2")], source_text=SOURCE, source_path=source)
    studies = [study, other]
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", studies, subdir="extraction")
    rob = [StudyRoB(study_id=key, overall_judgment="Low risk", tool_used="RoB 2", domains=[]) for key in ["S1", "S2"]]
    phase = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=studies, rob_results=rob)
    assert phase.status.value == "succeeded"
    assert len(phase.data["effects"]) == 2
    pooled = _run_meta_analysis_from_effects(project, protocol=protocol, extracted_studies=studies, study_effects=phase.data["effects"])
    cached = _load_cached_meta_results(project)
    assert cached.primary_outcome.pooled_effect == pooled.primary_outcome.pooled_effect
    assert cached.primary_outcome.n_studies == 2


@pytest.mark.parametrize("change", ["missing", "protocol"])
def test_missing_or_stale_proof_has_a_current_human_review_context(tmp_path, change):
    from new_meta.core.primary_analysis_alignment import ensure_review_context, alignment_status
    from new_meta.core.extraction_review import ExtractionReviewDecision, save_extraction_review_decision
    project, protocol, study, source = stamp_fixture(tmp_path)
    if change == "missing":
        study.outcomes[0].primary_analysis_alignment = None
        project.save_json("parsed_papers.json", {"S1": {"full_text": SOURCE, "_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}}, subdir="papers")
        project.save_json("pdf_download_results.json", [{"pmid": "S1", "pdf_path": str(source)}])
    else:
        protocol.pico.population = "Adults with chronic kidney disease"
    version = ensure_review_context(project, protocol, study, 0)
    assert version["status"] == "unknown"
    assert version["protocol_sha256"]
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    decision = ExtractionReviewDecision(
        row_id="S1:0", alignment_assessment=assessment_payload(),
        alignment_protocol_sha256=version["protocol_sha256"], alignment_row_sha256=version["row_sha256"],
        alignment_source_sha256=version["source_sha256"],
    )
    if change == "missing":
        with pytest.raises(ValueError, match="issue provenance"):
            save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")
        assert alignment_status(project, protocol, study, 0)["reason"] == "verification_issue_history_required"
        return
    save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")
    updated = ExtractedStudy.model_validate(project.load_json("all_extractions.json", subdir="extraction")[0])
    assert alignment_status(project, protocol, updated, 0)["status"] == "match"


def test_changed_document_cannot_reuse_old_parser_text(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, source = alignment_fixture(tmp_path)
    source.write_text(SOURCE.replace("50%", "30%"))
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "_check_extraction", lambda *_: pytest.fail("stale parsed text must not reach checker"))
    result = agent._verify_alignment(study, {"pdf_path": str(source)},
                                    {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol, project)
    assert alignment_status(project, protocol, result, 0)["status"] == "unknown"


@pytest.mark.parametrize("dimension, source_sentence, label", [
    ("outcome", "The endpoint was a 30% eGFR decline in the overall population.", "30% eGFR decline"),
    ("outcome", "The endpoint was initiation of dialysis alone.", "Dialysis initiation"),
    ("population", "Participants with eGFR below 55 were excluded; most had no chronic kidney disease.", "Kidney progression"),
    ("contrast", "The estimate compared patients with versus without postrandomization diuretic intensification.", "Kidney progression"),
])
def test_compatible_hr_is_excluded_for_verified_clinical_dimension_mismatch(tmp_path, dimension, source_sentence, label):
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    project, protocol, study, source = alignment_fixture(tmp_path)
    protocol.effect_measure = "HR"
    protocol.primary_outcome_type = "time_to_event"
    study.outcomes = [OutcomeData(
        outcome_name=label, outcome_type="time-to-event", reported_effect_measure="HR",
        effect_size=0.66, ci_lower=0.42, ci_upper=1.04, source_quote=source_sentence,
        source_location="Results", source_quote_verified=True,
    )]
    assessment = assessment_payload(source_outcome=study.outcomes[0], **{dimension: "mismatch"})
    previous_quote = assessment[dimension]["quote"]
    assessment[dimension]["quote"] = source_sentence
    assessment[dimension]["rationale"] = f"The source {dimension} differs from the review's prespecified PICO."
    if dimension == "outcome":
        assessment["verification"]["source_endpoint_definition"]["quote"] = source_sentence
        assessment["verification"]["endpoint_relation"] = "different"
    if dimension == "contrast":
        assessment["verification"]["estimand_support"]["quote"] = source_sentence
        assessment["verification"]["randomized_comparison"] = False
    current_source = SOURCE.replace(previous_quote, source_sentence)
    source.write_text(current_source)
    record_checked_alignments(project, protocol, study, [assessment], source_text=current_source, source_path=source)
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study])
    assert result.status.value == "succeeded"
    assert result.data["effects"] == []
    row = result.data["selection_audit"][0]
    assert row["decision"] == "excluded"
    assert row["reason"] == "primary_alignment_mismatch"
    assert row["alignment"]["dimensions"][dimension] == "mismatch"
    assert row["source_quote"] == source_sentence


def test_source_verification_change_invalidates_cached_admission(tmp_path):
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.core.primary_analysis_alignment import cached_alignment_is_current
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study, _ = stamp_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert cached_alignment_is_current(project)
    study.outcomes[0].source_quote_verified = False
    project.save_json("all_extractions.json", [study], subdir="extraction")
    assert not cached_alignment_is_current(project)


def test_review_cards_do_not_authorize_adjudication_without_issue_provenance(tmp_path):
    from new_meta.core.extraction_review import build_extraction_source_cards, ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, source = alignment_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    project.save_json("extraction_audit.json", {"rows": [{"row_id": "S1:0", "study_id": "S1", "outcome_index": 0, "outcome_name": study.outcomes[0].outcome_name}]}, subdir="extraction")
    project.save_json("parsed_papers.json", {"S1": {"full_text": SOURCE, "_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}}, subdir="papers")
    project.save_json("pdf_download_results.json", [{"pmid": "S1", "pdf_path": str(source)}])
    cards = build_extraction_source_cards(project)
    versions = cards[0]["review_action"]["alignment_expected_versions"]
    assert all(versions.values())
    with pytest.raises(ValueError, match="issue provenance"):
        save_extraction_review_decision(project, ExtractionReviewDecision(row_id="S1:0", alignment_assessment=assessment_payload(), **versions), alignment_assessor_id="reviewer-a")
    updated = ExtractedStudy.model_validate(project.load_json("all_extractions.json", subdir="extraction")[0])
    assert alignment_status(project, protocol, updated, 0)["reason"] == "verification_issue_history_required"


def test_cli_primary_selection_stops_on_needs_input_before_reading_effects(tmp_path):
    from new_meta.main import _require_cli_primary_selection
    from new_meta.core.primary_analysis_alignment import needs_input_phase
    from new_meta.core.release_contract import ReleaseBlockedError
    project, _, _, _ = alignment_fixture(tmp_path)
    phase = needs_input_phase(project, [{"row_id": "S1:0"}])
    phase.data = {}  # Accessing effects before the status check would raise KeyError.
    with pytest.raises(ReleaseBlockedError):
        _require_cli_primary_selection(project, phase)
    assert not project.is_step_done("effect_sizes")
    assert project.load_json("release_decision.json", subdir="package")["status"] == "blocked"


def test_web_downstream_returns_typed_alignment_need_without_pool_or_writer(tmp_path, monkeypatch):
    import start
    import new_meta.main as main_module
    from new_meta.agents.writing_agent import WritingAgent
    project, protocol, study, _ = alignment_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    project.save_json("extraction_audit.json", {"rows": []}, subdir="extraction")
    monkeypatch.setattr(start, "_resolve_project_dir", lambda *_args, **_kwargs: project.base_dir)
    forbidden = lambda *_args, **_kwargs: pytest.fail("Unresolved clinical alignment must stop before downstream execution")
    monkeypatch.setattr(main_module, "_run_meta_analysis_from_effects", forbidden)
    monkeypatch.setattr(main_module, "_run_grade_from_cached_meta", forbidden)
    monkeypatch.setattr(WritingAgent, "run", forbidden)
    from protocol_scope_fixture import approve_synthetic_protocol_scope
    approve_synthetic_protocol_scope(project)
    response = start._run_downstream_after_overrides_payload({"project_dir": str(project.base_dir)})
    assert response["ok"] is False
    assert response["error"] == "primary_analysis_alignment_required"
    assert response["execution"]["status"] == "needs_input"
    assert response["decisions"][0]["row_ids"] == ["S1:0"]
    assert not project.is_step_done("meta_analysis")
    assert not project.get_path("draft.md", subdir="manuscript").exists()


def test_full_quote_accepts_pdf_ligature_without_losing_word_boundaries():
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    sentence = "The clinical office assessed the final kidney endpoint."
    data["outcome"]["quote"] = sentence
    source = SOURCE + "\n" + sentence.replace("office", "o\ufb03ce")
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), source)


def test_alignment_reader_refuses_hardlinked_and_oversize_source(tmp_path):
    import os
    from new_meta.core.primary_analysis_alignment import _read_scoped
    project, _, _, source = alignment_fixture(tmp_path)
    relative = source.relative_to(project.base_dir).as_posix()
    with pytest.raises(ValueError, match="bounded"):
        _read_scoped(project, relative, max_bytes=8)
    os.link(source, project.base_dir / "linked.txt")
    with pytest.raises(ValueError, match="bounded"):
        _read_scoped(project, relative)


def test_alignment_rationale_must_not_be_blank():
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["population"]["rationale"] = "   "
    with pytest.raises(ValidationError):
        PrimaryAlignmentAssessment.model_validate(data)


def test_unpooled_narrative_is_not_subject_to_numeric_cache_gate(tmp_path, monkeypatch):
    import new_meta.main as main_module
    project, protocol, study, _ = alignment_fixture(tmp_path)
    class ReachedWritingStage(Exception):
        pass
    monkeypatch.setattr(main_module, "_require_cli_current_alignment", lambda *_args, **_kwargs: pytest.fail("No pool exists to validate"))
    monkeypatch.setattr(main_module, "ReferenceManager", lambda: (_ for _ in ()).throw(ReachedWritingStage()))
    with pytest.raises(ReachedWritingStage):
        main_module._write_manuscript_from_artifacts(
            project, None, None, protocol=protocol, search_query="", extracted_studies=[study],
            rob_results=[], included_papers=[], prisma_data={}, lang="en", meta_results=None, grade_profile=None,
        )


def test_independent_checker_can_confirm_source_backed_single_arm_not_applicable_contrast(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, protocol, study, source = alignment_fixture(tmp_path)
    protocol.pico.population = "Adults"
    protocol.pico.intervention = protocol.pico.comparator = "Not applicable"
    protocol.pico.outcome_primary = "Kidney disease prevalence"
    protocol.effect_measure = "PROP"
    protocol.primary_outcome_type = "proportion"
    statement = "This was a single-arm kidney disease prevalence survey of adults with no treatment comparison."
    study.outcomes = [OutcomeData(outcome_name="Kidney disease prevalence", outcome_type="proportion",
                                 source_quote=statement, source_location="Study design")]
    source.write_text(statement)
    data = {"outcome_index": 0, **{name: {
        "status": "match", "rationale": "The source establishes a descriptive single-arm population; an intervention comparison is not applicable to this protocol.",
        "quote": statement, "source_location": "Study design",
    } for name in ("outcome", "population", "contrast")}}
    from verification_fixture import verification_payload
    data["verification"] = verification_payload(study.outcomes[0], data, randomized=False)
    agent = DataExtractionAgent()
    prompts = []
    def checked(messages, *_args, **_kwargs):
        prompts.append(messages[-1]["content"])
        return ExtractionCheckResult(data_issues=[], score=9, primary_analysis_alignment=[data])
    monkeypatch.setattr(agent.llm, "structured_output", checked)
    verified = agent._verify_alignment(study, {"pdf_path": str(source)},
        {"full_text": statement, "_source_sha256": hashlib.sha256(statement.encode()).hexdigest()}, protocol, project)
    assert "single-arm prevalence/incidence" in prompts[0]
    assert alignment_status(project, protocol, verified, 0)["status"] == "match"


@pytest.mark.parametrize("mutation", ["synthesis", "protocol", "source_rows", "selected_set", "missing_binding"])
def test_completed_web_compiled_cache_requires_current_pool_and_source_binding(tmp_path, monkeypatch, mutation):
    import start
    from new_meta.core.project import PIPELINE_STEPS
    from test_complex_rct_delivery import _prepared_project
    project, _, _, _, _, phase = _prepared_project(tmp_path)
    assert phase.status.value == "succeeded"
    for step in PIPELINE_STEPS:
        project.save_checkpoint(step)
    package = project.get_path("metaagent_export.zip", subdir="package")
    package.write_bytes(b"existing package")
    monkeypatch.setattr(start, "_resolve_project_dir", lambda *_args, **_kwargs: project.base_dir)
    from protocol_scope_fixture import approve_synthetic_protocol_scope
    approve_synthetic_protocol_scope(project)
    ready = start._resume_project_payload({"project_dir": str(project.base_dir)})
    assert ready["ok"] is True and ready["skipped"] is True
    if mutation == "synthesis":
        data = project.load_json("synthesis_result.json", subdir="analysis")
        data["primary_estimates"][0]["estimate"] = 7.0
        project.save_json("synthesis_result.json", data, subdir="analysis")
    elif mutation == "protocol":
        data = project.load_json("protocol.json")
        data["pico"]["population"] = "A different population"
        project.save_json("protocol.json", data)
        from new_meta.core.method_planning import ProtocolInputRequired
        def scope_refusal(self, topic, protocol):
            raise ProtocolInputRequired("Changed population requires clarification", code="protocol_scope_input_required", protocol=protocol)
        monkeypatch.setattr("new_meta.agents.research_planner.ResearchPlanner.check_scope", scope_refusal)
    elif mutation == "source_rows":
        data = project.load_json("all_extractions.json", subdir="extraction")
        data[0]["outcomes"][0]["effect_size"] = 7.0
        project.save_json("all_extractions.json", data, subdir="extraction")
    elif mutation == "selected_set":
        data = project.load_json("analysis_set.json", subdir="analysis")
        data["result_ids"] = []
        project.save_json("analysis_set.json", data, subdir="analysis")
    else:
        project.get_path("primary_alignment_method_pool.json", subdir="analysis").unlink()
    refused = start._resume_project_payload({"project_dir": str(project.base_dir)})
    assert refused["ok"] is False
    assert refused["error"] == ("protocol_scope_input_required" if mutation == "protocol" else "cached_compiled_alignment_stale")
    refresh = start._refresh_review_decision_artifacts(project)
    assert refresh["artifacts_refreshed"] is False
    assert refresh["execution"]["error_code"] == ("protocol_scope_unverified" if mutation == "protocol" else "cached_compiled_alignment_stale")
    assert package.read_bytes() == b"existing package"


def competing_fixture(tmp_path, *, identical=False, different_timepoint=False, reverse=False):
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    project, protocol, study, source = alignment_fixture(tmp_path)
    second = study.outcomes[0].model_copy(deep=True)
    if not identical:
        second.events_intervention = 6
    if different_timepoint:
        study.outcomes[0].timepoint = "12 weeks"
        second.timepoint = "52 weeks"
    study.outcomes.append(second)
    if reverse:
        study.outcomes.reverse()
    assessments = [{**assessment_payload(source_outcome=outcome), "outcome_index": index} for index, outcome in enumerate(study.outcomes)]
    record_checked_alignments(project, protocol, study, assessments, source_text=SOURCE, source_path=source)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    return project, protocol, study


@pytest.mark.parametrize("reverse", [False, True])
def test_distinct_same_study_effects_need_primary_choice_independent_of_order(tmp_path, reverse):
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path, reverse=reverse)
    study.outcomes[0].manual_adjudication = True  # Generic acceptance is not a primary choice.
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert result.status.value == "needs_input"
    assert result.data["effects"] == []
    assert set(result.data["row_ids"]) == {"S1:0", "S1:1"}
    assert all(row["reason"] == "primary_result_choice_required" for row in result.data["selection_audit"])


def test_identical_effect_and_clinical_estimand_dedupes_without_choice(tmp_path):
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path, identical=True)
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert result.status.value == "succeeded"
    assert len(result.data["effects"]) == 1


def test_same_estimate_at_different_timepoints_is_not_an_identical_duplicate(tmp_path):
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path, identical=True, different_timepoint=True)
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert result.status.value == "needs_input"


def test_existing_review_surface_resolves_primary_choice_and_rejects_stale_candidates(tmp_path):
    import math
    from new_meta.core.extraction_review import build_extraction_source_cards, ExtractionReviewDecision, OverrideConflictError, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path)
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    runner = PipelineRunner(project)
    initial = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert initial.error_code == "primary_result_choice_required"
    generic = ExtractionReviewDecision(row_id="S1:0", updated_by="human", note="Values reviewed")
    save_extraction_review_decision(project, generic)
    assert runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob]).status.value == "needs_input"
    cards = build_extraction_source_cards(project)
    chosen_card = next(card for card in cards if card["row_id"] == "S1:1")
    assert set(chosen_card["review_action"]["primary_choice_action"]["candidate_row_ids"]) == {"S1:0", "S1:1"}
    versions = chosen_card["review_action"]["alignment_expected_versions"]
    decision = ExtractionReviewDecision(row_id="S1:1", primary_analysis_choice="include", note="Use the prespecified primary analysis", **versions)
    with pytest.raises(ValueError, match="authenticated"):
        save_extraction_review_decision(project, decision)
    save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")
    resolved = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert resolved.status.value == "succeeded"
    assert math.exp(resolved.data["effects"][0].yi) == pytest.approx(0.6)
    assert next(row for row in resolved.data["selection_audit"] if row["in_final_primary_analysis"])["row_id"] == "S1:1"
    refreshed_cards = build_extraction_source_cards(project)
    first_versions = next(card for card in refreshed_cards if card["row_id"] == "S1:0")["review_action"]["alignment_expected_versions"]
    save_extraction_review_decision(project, ExtractionReviewDecision(
        row_id="S1:0", primary_analysis_choice="include", note="Use the revised prespecified primary row", **first_versions,
    ), alignment_assessor_id="reviewer-a")
    chosen_again = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert math.exp(chosen_again.data["effects"][0].yi) == pytest.approx(0.5)
    stored = project.load_json("extraction_review_decisions.json", subdir="extraction")
    assert sum(item.get("primary_analysis_choice") == "include" for item in stored["decisions"]) == 1
    extra = study.outcomes[0].model_copy(deep=True)
    extra.events_intervention = 7
    study.outcomes.append(extra)
    record_checked_alignments(project, protocol, study,
        [{**assessment_payload(source_outcome=study.outcomes[index]), "outcome_index": index} for index in range(3)], source_text=SOURCE,
        source_path=project.base_dir / "papers" / "trial.txt",
        issue_histories={index: ([], True) for index in range(3)})
    project.save_json("all_extractions.json", [study], subdir="extraction")
    stale = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert stale.error_code == "primary_result_choice_required"
    with pytest.raises(OverrideConflictError):
        save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")


def test_reconciled_identical_duplicates_ignore_generated_bookkeeping_ids(tmp_path):
    from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path, identical=True)
    study.characteristics.study_design = "parallel RCT"
    for outcome in study.outcomes:
        outcome.outcome_name = protocol.pico.outcome_primary
        outcome.treatment_arm = protocol.pico.intervention
        outcome.reference_arm = protocol.pico.comparator
    reconcile_extracted_rct_designs(protocol, [study])
    assert study.outcomes[0].contrast_id != study.outcomes[1].contrast_id
    record_checked_alignments(project, protocol, study,
        [{**assessment_payload(source_outcome=study.outcomes[index]), "outcome_index": index} for index in range(2)], source_text=SOURCE,
        source_path=project.base_dir / "papers" / "trial.txt")
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert result.status.value == "succeeded"
    assert len(result.data["effects"]) == 1


@pytest.mark.parametrize("field, value", [("reported_effect_adjusted", True), ("treatment_arm", "Drug high dose")])
def test_same_numbers_with_different_adjustment_or_contrast_need_choice(tmp_path, field, value):
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path, identical=True)
    setattr(study.outcomes[1], field, value)
    record_checked_alignments(project, protocol, study,
        [{**assessment_payload(source_outcome=study.outcomes[index]), "outcome_index": index} for index in range(2)], source_text=SOURCE,
        source_path=project.base_dir / "papers" / "trial.txt")
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert result.error_code == "primary_result_choice_required"


@pytest.mark.parametrize("excluded_reason", ["source", "data"])
def test_review_cannot_choose_a_clinically_matched_but_unselectable_row(tmp_path, excluded_reason):
    from new_meta.core.extraction_review import build_extraction_source_cards, ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path)
    if excluded_reason == "source":
        study.outcomes[1].source_quote_verified = False
    else:
        study.outcomes[1].events_intervention = None
        study.outcomes[1].total_intervention = None
        study.outcomes[1].events_control = None
        study.outcomes[1].total_control = None
        record_checked_alignments(project, protocol, study,
            [{**assessment_payload(source_outcome=study.outcomes[index]), "outcome_index": index} for index in range(2)], source_text=SOURCE,
            source_path=project.base_dir / "papers" / "trial.txt")
    project.save_json("all_extractions.json", [study], subdir="extraction")
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    card = next(card for card in build_extraction_source_cards(project) if card["row_id"] == "S1:1")
    assert "primary_choice_action" not in card["review_action"]
    decision = ExtractionReviewDecision(row_id="S1:1", primary_analysis_choice="include", note="Attempt to select excluded row",
                                       **card["review_action"]["alignment_expected_versions"])
    with pytest.raises(ValueError, match="not currently selectable"):
        save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")


def test_stale_chosen_row_never_silently_falls_back_to_another_row(tmp_path):
    from new_meta.core.extraction_review import build_extraction_source_cards, ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path)
    runner = PipelineRunner(project)
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    versions = next(card for card in build_extraction_source_cards(project) if card["row_id"] == "S1:1")["review_action"]["alignment_expected_versions"]
    save_extraction_review_decision(project, ExtractionReviewDecision(row_id="S1:1", primary_analysis_choice="include", note="Prespecified primary result", **versions), alignment_assessor_id="reviewer-a")
    study.outcomes[1].source_quote_verified = False
    project.save_json("all_extractions.json", [study], subdir="extraction")
    result = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert result.error_code == "primary_result_choice_required"
    assert result.data["effects"] == []
    cards = build_extraction_source_cards(project)
    available = next(card for card in cards if card["row_id"] == "S1:0")
    unavailable = next(card for card in cards if card["row_id"] == "S1:1")
    assert available["review_action"]["primary_choice_action"]["candidate_row_ids"] == ["S1:0"]
    assert "primary_choice_action" not in unavailable["review_action"]


@pytest.mark.parametrize("source, quote", [
    ("All participants received 250 mg daily versus placebo for one year.", "50 mg daily versus placebo for one year."),
    ("All participants received 0.5 mg daily versus placebo for one year.", "5 mg daily versus placebo for one year."),
    ("The change was -5 units after one year of treatment.", "5 units after one year of treatment."),
    ("The observed ratio was 1.25 after treatment.", "The observed ratio was 1.2"),
    ("All participants received metoprolol daily versus placebo for one year.", "toprolol daily versus placebo for one year."),
    ("The treatment reduced hospitalizations after one year.", "The treatment reduced hospital"),
    ("The change was −5 units after one year of treatment.", "5 units after one year of treatment."),
    ("The observed ratio was 1.2e-5 after treatment.", "The observed ratio was 1.2"),
])
def test_quote_anchor_refuses_clipped_numeric_and_word_tokens(source, quote):
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["outcome"]["quote"] = quote
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)


@pytest.mark.parametrize("source, quote", [
    ("Reported: 50 mg daily versus placebo for one year; follow-up continued.", "50 mg daily versus placebo for one year"),
    ("Reported: (0.5 mg daily versus placebo for one year).", "0.5 mg daily versus placebo for one year"),
    ("The change was -5 units after one year of treatment.", "-5 units after one year of treatment"),
    ("The observed ratio was 1.25 after treatment.", "The observed ratio was 1.25"),
    ("The clinical oﬃce reported:\u00a0the\u2009primary endpoint was unchanged.", "the primary endpoint was unchanged"),
    ("说明：主要终点包括持续肾功能下降或者发生肾衰竭。", "主要终点包括持续肾功能下降或者发生肾衰竭"),
    ("First 250 mg daily versus placebo for one year; then 50 mg daily versus placebo for one year.", "50 mg daily versus placebo for one year"),
])
def test_quote_anchor_preserves_complete_phrases_and_unicode(source, quote):
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["outcome"]["quote"] = quote
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)


def test_fifo_source_is_rejected_without_blocking_open(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path
    fifo = tmp_path / "source.fifo"
    os.mkfifo(fifo)
    script = '''
from pathlib import Path
from types import SimpleNamespace
from new_meta.core.primary_analysis_alignment import _read_scoped
import sys
try:
    _read_scoped(SimpleNamespace(base_dir=Path(sys.argv[1])), "source.fifo")
except ValueError as error:
    assert "regular file" in str(error)
else:
    raise AssertionError("FIFO must not be accepted")
'''
    try:
        result = subprocess.run([sys.executable, "-c", script, str(tmp_path)],
                                cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=3)
    except subprocess.TimeoutExpired:
        pytest.fail("FIFO open blocked before regular-file validation")
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("damage", ["missing", "malformed", "invalid_id", "hash", "assessor", "context", "malformed_manifest"])
def test_invalid_active_choice_receipt_cannot_fall_back_to_another_row(tmp_path, damage):
    from new_meta.core.extraction_review import build_extraction_source_cards, ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path)
    runner = PipelineRunner(project)
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    versions = next(card for card in build_extraction_source_cards(project) if card["row_id"] == "S1:1")["review_action"]["alignment_expected_versions"]
    save_extraction_review_decision(project, ExtractionReviewDecision(
        row_id="S1:1", primary_analysis_choice="include", note="Prespecified primary result", **versions,
    ), alignment_assessor_id="reviewer-a")
    manifest = project.load_json("extraction_review_decisions.json", subdir="extraction")
    receipt = project.base_dir / "extraction" / "primary_alignment" / f"primary-choice-{manifest['decisions'][0]['primary_choice_proof_id']}.json"
    if damage == "missing":
        receipt.unlink()
    elif damage == "malformed":
        receipt.write_text("not JSON")
    elif damage in {"hash", "assessor", "context"}:
        value = json.loads(receipt.read_text())
        value[{"hash": "reason", "assessor": "assessor", "context": "context_sha256"}[damage]] = "invalid"
        receipt.write_text(json.dumps(value))
    elif damage == "invalid_id":
        manifest["decisions"][0]["primary_choice_proof_id"] = "invalid"
        project.save_json("extraction_review_decisions.json", manifest, subdir="extraction")
    else:
        project.get_path("extraction_review_decisions.json", subdir="extraction").write_text("not JSON")
    study.outcomes[1].source_quote_verified = False
    project.save_json("all_extractions.json", [study], subdir="extraction")
    result = runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert result.error_code == "primary_result_choice_required"
    assert result.data["effects"] == []


@pytest.mark.parametrize("source, quote", [
    ("The dose was 1/2 mg daily versus placebo for one year.", "2 mg daily versus placebo for one year."),
    ("The dose was 5–10 mg daily versus placebo for one year.", "10 mg daily versus placebo for one year."),
])
def test_quote_anchor_keeps_fraction_and_range_tokens_complete(source, quote):
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["outcome"]["quote"] = quote
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)
    data["outcome"]["quote"] = source
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)


def test_generic_review_acceptance_does_not_change_primary_choice_cache_binding(tmp_path):
    from new_meta.core.extraction_review import ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import cached_alignment_is_current
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study, _ = stamp_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert cached_alignment_is_current(project)
    save_extraction_review_decision(project, ExtractionReviewDecision(row_id="S1:0", note="Reviewed values", updated_by="reviewer-a"))
    assert cached_alignment_is_current(project)


@pytest.mark.parametrize("source, clipped, complete", [
    ("Threshold: >50 mg daily versus placebo for one year.", "50 mg daily versus placebo for one year.", ">50 mg daily versus placebo for one year."),
    ("Threshold: ≤ 50 mg daily versus placebo for one year.", "50 mg daily versus placebo for one year.", "≤ 50 mg daily versus placebo for one year."),
    ("Approximate dose: ≈ 50 mg daily versus placebo for one year.", "50 mg daily versus placebo for one year.", "≈ 50 mg daily versus placebo for one year."),
    ("The change was - 5 units after one year of treatment.", "5 units after one year of treatment.", "- 5 units after one year of treatment."),
    ("The change was 5±2 units after one year of treatment.", "2 units after one year of treatment.", "5±2 units after one year of treatment."),
    ("The change was 5 +/- 2 units after one year of treatment.", "2 units after one year of treatment.", "5 +/- 2 units after one year of treatment."),
])
def test_quote_anchor_retains_numeric_qualifiers_and_uncertainty(source, clipped, complete):
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["outcome"]["quote"] = clipped
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)
    data["outcome"]["quote"] = complete
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)


def test_nfkc_fraction_cannot_be_clipped_to_its_denominator():
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    source = "The dose was ½ mg daily versus placebo for one year."
    data = assessment_payload()
    data["outcome"]["quote"] = "2 mg daily versus placebo for one year."
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)
    data["outcome"]["quote"] = "½ mg daily versus placebo for one year."
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)


def test_missing_active_choice_receipt_invalidates_an_already_bound_cache(tmp_path):
    from new_meta.core.extraction_review import build_extraction_source_cards, ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import cached_alignment_is_current
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, study = competing_fixture(tmp_path)
    runner = PipelineRunner(project)
    rob = StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])
    runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    versions = next(card for card in build_extraction_source_cards(project) if card["row_id"] == "S1:1")["review_action"]["alignment_expected_versions"]
    decision = ExtractionReviewDecision(row_id="S1:1", primary_analysis_choice="include", note="Prespecified primary row", **versions)
    save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")
    runner.run_primary_effect_selection(protocol=protocol, extracted_studies=[study], rob_results=[rob])
    assert cached_alignment_is_current(project)
    (project.base_dir / "extraction" / "primary_alignment" / f"primary-choice-{decision.primary_choice_proof_id}.json").unlink()
    assert not cached_alignment_is_current(project)


def test_normal_review_refresh_reaches_package_stage_for_a_genuinely_bound_pool(tmp_path, monkeypatch):
    import start
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    from new_meta.main import _run_meta_analysis_from_effects
    project, protocol, study, source = stamp_fixture(tmp_path)
    second = study.model_copy(deep=True)
    second.characteristics.study_id = "S2"
    second.outcomes[0].events_intervention = 6
    second.outcomes[0].primary_analysis_alignment = None
    record_checked_alignments(project, protocol, second, [assessment_payload(source_outcome=second.outcomes[0], study_id="S2")], source_text=SOURCE, source_path=source)
    studies = [study, second]
    project.save_json("protocol.json", protocol)
    from protocol_scope_fixture import approve_synthetic_protocol_scope
    approve_synthetic_protocol_scope(project)
    project.save_json("all_extractions.json", studies, subdir="extraction")
    rob = [StudyRoB(study_id=key, overall_judgment="Low risk", tool_used="RoB 2", domains=[]) for key in ["S1", "S2"]]
    project.save_json("rob_results.json", rob, subdir="risk_of_bias")
    selection = PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=studies, rob_results=rob)
    pooled = _run_meta_analysis_from_effects(project, protocol=protocol, extracted_studies=studies, study_effects=selection.data["effects"])
    before = project.get_path("meta_results.json", subdir="analysis").read_bytes()
    project.save_text("draft.md", "Diagnostic draft requiring quality review", subdir="manuscript")
    project.save_checkpoint("manuscript")
    monkeypatch.setattr(start, "_resolve_project_dir", lambda *_args, **_kwargs: project.base_dir)
    observed = []
    def facts(**kwargs):
        observed.append(kwargs["meta_results"].primary_outcome.pooled_effect)
        return {"report_type": "meta", "evidence_readiness": {"status": "blocked"}}
    monkeypatch.setattr("new_meta.core.manuscript_facts.build_manuscript_facts", facts)
    monkeypatch.setattr("new_meta.core.manuscript_facts.validate_and_repair_manuscript", lambda text, _: (text, {"passed": False, "issues": []}))
    monkeypatch.setattr("new_meta.core.artifact_package.create_artifact_package", lambda _: project.get_path("review.zip", subdir="package"))
    result = start._save_extraction_review_decision_payload({"project_dir": str(project.base_dir), "decision": {
        "row_id": "S1:0", "decision": "accepted", "note": "Reviewed displayed source values",
    }}, user_id="reviewer-a")
    assert result["artifacts_refreshed"] is True
    assert observed == [pooled.primary_outcome.pooled_effect]
    assert project.get_path("meta_results.json", subdir="analysis").read_bytes() == before
    assert result["requires_rerun"] is True  # Refreshing diagnostics does not make this draft publication-ready.


@pytest.mark.parametrize("source, clipped, whole", [
    ("The variation was ±5 units after one year.", "5 units after one year.", "±5 units after one year."),
    ("The variation was +/-5 units after one year.", "-5 units after one year.", "+/-5 units after one year."),
    ("The variation was ± 5 units after one year.", "5 units after one year.", "± 5 units after one year."),
])
def test_quote_anchor_preserves_standalone_plus_minus_prefix(source, clipped, whole):
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["outcome"]["quote"] = clipped
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)
    data["outcome"]["quote"] = whole
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)


@pytest.mark.parametrize("source, altered, intact", [
    ("The measured count was 10³ cells per mL in the cohort.", "The measured count was 103 cells per mL in the cohort.", "The measured count was 10³ cells per mL in the cohort."),
    ("The measured count was 10^3 cells per mL in the cohort.", "3 cells per mL in the cohort.", "10^3 cells per mL in the cohort."),
    ("The measured count was 2×10^3 cells per mL in the cohort.", "3 cells per mL in the cohort.", "2×10^3 cells per mL in the cohort."),
    ("The measured count was 2×10³ cells per mL in the cohort.", "10³ cells per mL in the cohort.", "2×10³ cells per mL in the cohort."),
    ("The measured count was 10⁻³ cells per mL in the cohort.", "The measured count was 10−3 cells per mL in the cohort.", "10⁻³ cells per mL in the cohort."),
    ("The measured count was 10¹² cells per mL in the cohort.", "The measured count was 1012 cells per mL in the cohort.", "10¹² cells per mL in the cohort."),
])
def test_quote_anchor_preserves_scientific_powers_before_nfkc(source, altered, intact):
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    data = assessment_payload()
    data["outcome"]["quote"] = altered
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)
    data["outcome"]["quote"] = intact
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)


def test_quote_anchor_does_not_clip_nfkc_double_prime_to_single_prime():
    from new_meta.core.primary_analysis_alignment import _anchored
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    source = "The measured angle was 5″ at the final assessment."
    data = assessment_payload()
    data["outcome"]["quote"] = "The measured angle was 5′"
    assert not _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)
    data["outcome"]["quote"] = "The measured angle was 5″"
    assert _anchored(PrimaryAlignmentAssessment.model_validate(data), SOURCE + " " + source)
