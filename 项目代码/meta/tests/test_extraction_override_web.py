from pathlib import Path
from uuid import uuid4
import json
import zipfile

from start import META_ROOT, _load_extraction_review_payload, _save_extraction_override_payload, _save_extraction_review_decision_payload
from new_meta.core.project import Project
from new_meta.schemas.meta_result import MetaAnalysisResults, PooledEffect, StudyEffect
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _project_under_output() -> Project:
    root = META_ROOT / "output" / "pytest_override_web" / uuid4().hex
    return Project("override web", output_dir=root)


def test_save_extraction_override_payload_persists_and_applies_to_current_extractions() -> None:
    project = _project_under_output()
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(study_id="S1", title="Trial"),
        outcomes=[
            OutcomeData(
                outcome_name="HbA1c",
                outcome_type="continuous",
                mean_intervention=7.1,
                mean_control=8.0,
                n_intervention=50,
                n_control=50,
                source_quote="HbA1c data were reported.",
                source_quote_verified=True,
                extraction_confidence="medium",
            )
        ],
    )
    project.save_json("all_extractions.json", [study], subdir="extraction")
    for step in ["extraction", "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)

    result = _save_extraction_override_payload(
        {
            "type": "extraction_override",
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "override": {
                "study_id": "S1",
                "outcome_index": 0,
                "outcome_name": "HbA1c",
                "field": "mean_intervention",
                "value": 6.8,
                "reason": "User checked Table 2",
                "updated_by": "tester",
            },
        },
        user_id="tester",
    )
    updated = project.load_json("all_extractions.json", subdir="extraction")
    manifest = project.load_json("extraction_overrides.json", subdir="extraction")

    assert result["ok"] is True
    assert result["current_revision"] == 1
    assert result["applied_overrides"] == 1
    assert result["requires_rerun"] is True
    assert result["cleared_checkpoints"] == ["effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]
    assert project.is_step_done("extraction") is True
    assert project.is_step_done("meta_analysis") is False
    assert updated[0]["outcomes"][0]["mean_intervention"] == 6.8
    assert updated[0]["outcomes"][0]["user_override_applied"] is True
    assert manifest["current_revision"] == 1
    assert result["extraction_review"]["summary"]["overrides_applied"] == 1


def test_save_extraction_override_payload_reports_revision_conflict() -> None:
    project = _project_under_output()
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1"),
                outcomes=[OutcomeData(outcome_name="HbA1c", mean_intervention=7.1)],
            )
        ],
        subdir="extraction",
    )
    _save_extraction_override_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "override": {
                "study_id": "S1",
                "outcome_index": 0,
                "field": "mean_intervention",
                "value": 6.8,
            },
        },
        user_id="tester",
    )
    conflict = _save_extraction_override_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "override": {
                "study_id": "S1",
                "outcome_index": 0,
                "field": "mean_control",
                "value": 7.9,
            },
        },
        user_id="tester",
    )

    assert conflict["ok"] is False
    assert conflict["error"] == "revision_conflict"
    assert conflict["current_revision"] == 1


def test_save_extraction_override_payload_accepts_timepoint_adjudication_fields() -> None:
    project = _project_under_output()
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1"),
                outcomes=[OutcomeData(outcome_name="28-day all-cause mortality")],
            )
        ],
        subdir="extraction",
    )

    result = _save_extraction_override_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "override": {
                "study_id": "S1",
                "outcome_index": 0,
                "field": "timepoint_adjudication_note",
                "value": "Accepted closest mortality endpoint after user review.",
            },
        },
        user_id="tester",
    )
    updated = project.load_json("all_extractions.json", subdir="extraction")

    assert result["ok"] is True
    assert result["applied_overrides"] == 1
    assert (
        updated[0]["outcomes"][0]["timepoint_adjudication_note"]
        == "Accepted closest mortality endpoint after user review."
    )
    assert updated[0]["outcomes"][0]["user_override_applied"] is True


def test_save_extraction_override_payload_rejects_unknown_fields() -> None:
    project = _project_under_output()
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1"),
                outcomes=[OutcomeData(outcome_name="HbA1c", mean_intervention=7.1)],
            )
        ],
        subdir="extraction",
    )

    try:
        _save_extraction_override_payload(
            {
                "project_dir": str(project.base_dir),
                "expected_revision": 0,
                "override": {
                    "study_id": "S1",
                    "outcome_index": 0,
                    "field": "not_a_real_outcome_field",
                    "value": 1,
                },
            },
            user_id="tester",
        )
    except ValueError as exc:
        assert "Unsupported extraction override field" in str(exc)
    else:
        raise AssertionError("unknown override fields must be rejected before save")


def test_save_extraction_review_decision_payload_persists_and_updates_review_queue() -> None:
    project = _project_under_output()
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", title="Trial"),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        source_quote="Deaths were reported in Table 2.",
                        source_quote_verified=False,
                        extraction_confidence="low",
                    )
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 1, "rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "study_label": "Trial 2024",
                    "outcome_name": "28-day mortality",
                    "source_quote": "Deaths were reported in Table 2.",
                    "source_quote_verified": False,
                    "extraction_confidence": "low",
                    "requires_review": True,
                    "conflicts": [{"field": "events_intervention", "message": "needs verification"}],
                }
            ],
        },
        subdir="extraction",
    )
    project.save_checkpoint("manuscript")

    result = _save_extraction_review_decision_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "decision": {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_index": 0,
                "decision": "accepted",
                "note": "Reviewer checked source quote.",
            },
        },
        user_id="tester",
    )
    review_payload = _load_extraction_review_payload(project, {})

    assert result["ok"] is True
    assert result["current_revision"] == 1
    assert result["requires_rerun"] is True
    assert result["cleared_checkpoints"] == ["manuscript"]
    assert project.is_step_done("manuscript") is False
    assert result["extraction_review"]["summary"]["rows_requiring_review"] == 0
    assert result["extraction_review"]["summary"]["conflict_rows"] == 0
    assert result["extraction_review"]["summary"]["review_decisions_accepted"] == 1
    assert review_payload["review_rows"] == []


def test_load_extraction_review_payload_includes_source_context_for_web_drawer() -> None:
    project = _project_under_output()
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id="S1",
                    pmid="12345",
                    title="Context Trial",
                    pdf_path="/tmp/context-trial.pdf",
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        events_intervention=10,
                        total_intervention=100,
                        events_control=18,
                        total_control=100,
                        source_quote="10 deaths occurred in treatment and 18 deaths in control.",
                        source_quote_match="10 deaths occurred in treatment and 18 deaths in control.",
                        source_quote_verified=True,
                        extraction_confidence="high",
                    )
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json(
        "parsed_papers.json",
        {
            "12345": {
                "full_text": (
                    "[PAGE 7]\nMortality table context before. "
                    "10 deaths occurred in treatment and 18 deaths in control. "
                    "Mortality table context after."
                ),
                "page_map": [{"page_number": 7, "start_char": 0, "end_char": 132}],
            }
        },
        subdir="papers",
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 1},
            "rows": [
                {
                    "row_id": "12345:0",
                    "study_id": "12345",
                    "outcome_index": 0,
                    "study_label": "Context 2024",
                    "outcome_name": "28-day mortality",
                    "source_quote": "10 deaths occurred in treatment and 18 deaths in control.",
                    "source_quote_match": "10 deaths occurred in treatment and 18 deaths in control.",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": False,
                    "conflicts": [],
                }
            ],
        },
        subdir="extraction",
    )

    payload = _load_extraction_review_payload(project, {})

    card = payload["source_cards"][0]
    assert card["source_context"]["available"] is True
    assert card["source_context"]["page"] == 7
    assert "Mortality table context before." in card["source_context"]["prefix"]
    assert card["source_context"]["match_text"] == "10 deaths occurred in treatment and 18 deaths in control."
    assert "Mortality table context after." in card["source_context"]["suffix"]
    assert payload["summary"]["source_context_available_cards"] == 1
    assert payload["summary"]["source_context_missing_cards"] == 0
    assert payload["summary"]["source_context_coverage"] == 1.0
    assert payload["missing_source_context_cards"] == []


def test_load_extraction_review_payload_lists_missing_source_context_cards() -> None:
    project = _project_under_output()
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", pmid="12345", title="Missing Context Trial"),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        events_intervention=10,
                        total_intervention=100,
                        events_control=18,
                        total_control=100,
                        source_quote="10 deaths and 18 deaths.",
                        source_quote_verified=True,
                        extraction_confidence="high",
                    )
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 1},
            "rows": [
                {
                    "row_id": "12345:0",
                    "study_id": "12345",
                    "outcome_index": 0,
                    "study_label": "Missing Context 2024",
                    "title": "Missing Context Trial",
                    "outcome_name": "28-day mortality",
                    "source_quote": "10 deaths and 18 deaths.",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": False,
                    "conflicts": [],
                }
            ],
        },
        subdir="extraction",
    )

    payload = _load_extraction_review_payload(project, {})

    assert payload["summary"]["source_context_available_cards"] == 0
    assert payload["summary"]["source_context_missing_cards"] == 1
    assert payload["summary"]["source_context_coverage"] == 0.0
    assert payload["missing_source_context_cards"] == [
        {
            "row_id": "12345:0",
            "study_id": "12345",
            "study_label": "Missing Context Trial",
            "outcome_name": "28-day mortality",
            "quote_verified": True,
            "requires_review": False,
            "missing_reason": "source_context_unavailable",
        }
    ]


def test_save_extraction_review_decision_payload_refreshes_readiness_facts_and_package() -> None:
    project = _project_under_output()
    quote_1 = "28-day mortality: 10/100 deaths in intervention and 18/100 deaths in control."
    quote_2 = "28-day mortality: 20/150 deaths in intervention and 28/150 deaths in control."
    protocol = ResearchProtocol(
        research_question="Do corticosteroids reduce mortality?",
        pico=PICO(
            population="Adults with critical illness",
            intervention="Systemic corticosteroids",
            comparator="Usual care",
            outcome_primary="28-day mortality",
        ),
        effect_measure="OR",
        model_preference="random",
    )
    meta_results = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="28-day mortality",
            n_studies=2,
            effect_measure="OR",
            pooled_effect=0.66,
            ci_lower=0.53,
            ci_upper=0.82,
            p_value=0.001,
            studies=[
                StudyEffect(study_id="S1", study_label="Trial 1", yi=-0.4, vi=0.04, se=0.2),
                StudyEffect(study_id="S2", study_label="Trial 2", yi=-0.2, vi=0.05, se=0.2236),
            ],
        )
    )
    project.save_json("protocol.json", protocol)
    project.save_json("meta_results.json", meta_results, subdir="analysis")
    project.save_json("rob_results.json", [], subdir="risk_of_bias")
    project.save_text("search_query.txt", "corticosteroids AND mortality")
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", title="Trial 1"),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        events_intervention=10,
                        total_intervention=100,
                        events_control=18,
                        total_control=100,
                        source_quote=quote_1,
                        source_location="Table 2",
                        source_quote_verified=True,
                        extraction_confidence="high",
                    )
                ],
            ),
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S2", title="Trial 2"),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        events_intervention=20,
                        total_intervention=150,
                        events_control=28,
                        total_control=150,
                        source_quote=quote_2,
                        source_location="Table 2",
                        source_quote_verified=True,
                        extraction_confidence="high",
                    )
                ],
            ),
        ],
        subdir="extraction",
    )
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:0",
                "study_id": "S1",
                "study_label": "Trial 1",
                "outcome_name": "28-day mortality",
                "events_intervention": 10,
                "total_intervention": 100,
                "events_control": 18,
                "total_control": 100,
                "source_quote": quote_1,
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S2:0",
                "study_id": "S2",
                "study_label": "Trial 2",
                "outcome_name": "28-day mortality",
                "events_intervention": 20,
                "total_intervention": 150,
                "events_control": 28,
                "total_control": 150,
                "source_quote": quote_2,
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 2, "rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "study_label": "Trial 1",
                    "outcome_name": "28-day mortality",
                    "outcome_type": "dichotomous",
                    "source_quote": quote_1,
                    "source_location": "Table 2",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": True,
                    "conflicts": [{"field": "events_intervention", "message": "Needs reviewer confirmation."}],
                },
                {
                    "row_id": "S2:0",
                    "study_id": "S2",
                    "outcome_index": 0,
                    "study_label": "Trial 2",
                    "outcome_name": "28-day mortality",
                    "outcome_type": "dichotomous",
                    "source_quote": quote_2,
                    "source_location": "Table 2",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": False,
                    "conflicts": [],
                },
            ],
        },
        subdir="extraction",
    )
    project.save_json(
        "manuscript_facts.json",
        {
            "report_type": "meta",
            "evidence_readiness": {
                "status": "review",
                "blockers": [],
                "warnings": [{"code": "unresolved_extraction_review_rows"}],
                "selected_primary_rows": [],
                "extraction_audit_summary": {"rows_requiring_review": 1, "conflict_rows": 1},
            },
        },
        subdir="manuscript",
    )
    project.save_json("manuscript_validation.json", {"passed": True, "issues": []}, subdir="manuscript")
    project.save_text("draft.md", "## Results\n\nPrimary outcome OR 0.66.", subdir="manuscript")
    project.save_checkpoint("manuscript")

    result = _save_extraction_review_decision_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "decision": {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_index": 0,
                "decision": "accepted",
                "note": "Reviewer checked Table 2.",
            },
        },
        user_id="tester",
    )
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    package_path = Path(result["package_path"])

    assert result["ok"] is True
    assert result["artifacts_refreshed"] is True
    assert result["requires_rerun"] is False
    assert project.is_step_done("manuscript") is True
    assert result["evidence_readiness"]["extraction_audit_summary"]["rows_requiring_review"] == 0
    assert facts["evidence_readiness"]["extraction_audit_summary"]["rows_requiring_review"] == 0
    assert facts["evidence_readiness"]["extraction_audit_summary"]["conflict_rows"] == 0
    assert package_path.exists()
    with zipfile.ZipFile(package_path) as zf:
        review = json.loads(zf.read("review/evidence_readiness_review.json"))
        html = zf.read("review/extraction_review.html").decode("utf-8")
    assert review["summary"]["extraction_review_cards"] == 0
    assert "Trust status" in html


def test_save_extraction_review_decision_payload_keeps_rerun_required_when_refreshed_draft_still_blocked() -> None:
    project = _project_under_output()
    project.save_json(
        "protocol.json",
        ResearchProtocol(
            research_question="Do corticosteroids reduce mortality?",
            pico=PICO(
                population="Adults with critical illness",
                intervention="Systemic corticosteroids",
                comparator="Usual care",
                outcome_primary="28-day mortality",
            ),
            effect_measure="OR",
        ),
    )
    project.save_json(
        "meta_results.json",
        MetaAnalysisResults(
            primary_outcome=PooledEffect(
                outcome_name="28-day mortality",
                n_studies=2,
                effect_measure="OR",
                pooled_effect=0.66,
                ci_lower=0.53,
                ci_upper=0.82,
                p_value=0.001,
                studies=[
                    StudyEffect(study_id="S1", study_label="Trial 1", yi=-0.4, vi=0.04, se=0.2),
                    StudyEffect(study_id="S2", study_label="Trial 2", yi=-0.2, vi=0.05, se=0.2236),
                ],
            )
        ),
        subdir="analysis",
    )
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:0",
                "study_id": "S1",
                "study_label": "Trial 1",
                "outcome_name": "28-day mortality",
                "events_intervention": 10,
                "total_intervention": 100,
                "events_control": 18,
                "total_control": 100,
                "source_quote": "Deaths were reported, but denominators are missing from this quote.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S2:0",
                "study_id": "S2",
                "study_label": "Trial 2",
                "outcome_name": "28-day mortality",
                "events_intervention": 20,
                "total_intervention": 150,
                "events_control": 28,
                "total_control": 150,
                "source_quote": "Deaths were reported, but denominators are missing from this quote.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 1, "rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "outcome_name": "28-day mortality",
                    "source_quote": "Deaths were reported, but denominators are missing from this quote.",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": True,
                    "conflicts": [{"field": "total_intervention", "message": "Needs denominator source."}],
                }
            ],
        },
        subdir="extraction",
    )
    project.save_text("draft.md", "## Results\n\nPrimary outcome OR 0.66.", subdir="manuscript")
    project.save_checkpoint("manuscript")

    result = _save_extraction_review_decision_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "decision": {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_index": 0,
                "decision": "accepted",
                "note": "Review row accepted, but selected source rows are still underverified.",
            },
        },
        user_id="tester",
    )

    assert result["ok"] is True
    assert result["artifacts_refreshed"] is True
    assert result["manuscript_validation"]["passed"] is False
    assert result["requires_rerun"] is True
    assert project.is_step_done("manuscript") is False
