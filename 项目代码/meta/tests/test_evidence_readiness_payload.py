from pathlib import Path

from start import (
    META_STEP_SUMMARY,
    _load_evidence_readiness_payload,
    _load_extraction_review_payload,
    _save_evidence_gap_validation,
)
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does treatment improve mortality?",
        pico=PICO(
            population="critically ill adults",
            intervention="treatment",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
        effect_measure="RR",
    )


def test_step4_summary_surfaces_fulltext_parse_cache_hits() -> None:
    summary = META_STEP_SUMMARY[4]({
        "n_user_pdfs": 1,
        "n_ta_included": 3,
        "n_extracted": 2,
        "n_fulltext_used": 2,
        "n_ta_no_pdf": 1,
        "n_pdf_cache_hits": 1,
        "n_fulltext_parse_cache_hits": 2,
        "n_extraction_outcomes": 0,
    })

    assert "全文解析缓存命中：3 篇" in summary


def test_load_evidence_readiness_payload_updates_context(tmp_path: Path) -> None:
    project = Project("readiness payload", output_dir=tmp_path)
    project.save_json(
        "manuscript_facts.json",
        {
            "report_type": "evidence_gap",
            "primary_effect": {"n_studies": 3, "pooled_effect": 0.8},
            "primary_population": {"selected_total_participants": 1535},
            "text_sources": {
                "abstract_only_count": 1,
                "warnings": [
                    {
                        "pmid": "S1",
                        "doi": "10.1000/example",
                        "title": "Trial",
                        "text_availability": "abstract_only",
                        "warning": "Only abstract text was available.",
                    }
                ],
            },
            "evidence_readiness": {
                "status": "blocked",
                "blocker_codes": [
                    "abstract_only_primary_effect",
                    "primary_timepoint_not_source_verified",
                    "primary_counts_not_source_verified",
                ],
                "blockers": [
                    {"code": "abstract_only_primary_effect", "row_id": "S1:0", "message": "abstract only"},
                    {
                        "code": "primary_timepoint_not_source_verified",
                        "row_id": "S1:0",
                        "message": "target day missing",
                    },
                    {
                        "code": "primary_counts_not_source_verified",
                        "row_id": "S1:0",
                        "missing_values": ["total_intervention=324"],
                        "message": "count source missing",
                    },
                ],
                "warnings": [{"code": "unresolved_extraction_review_rows", "message": "review needed"}],
                "selected_primary_rows": [
                    {
                        "row_id": "S1:0",
                        "study_id": "S1",
                        "doi": "10.1000/example",
                        "title": "Trial",
                        "outcome_name": "28-day mortality",
                        "source_location": "Table 2",
                        "source_quote": "mortality was reported without a day label",
                        "source_quote_verified": True,
                        "events_intervention": 94,
                        "total_intervention": 324,
                        "events_control": 278,
                        "total_control": 683,
                    }
                ],
                "extraction_audit_summary": {"rows_requiring_review": 1},
            },
        },
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_validation.json",
        {
            "passed": False,
            "issues": [
                {"severity": "error", "kind": "evidence_readiness_blocker"},
                {"severity": "warning", "kind": "evidence_readiness_warning"},
            ],
        },
        subdir="manuscript",
    )
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "mini_benchmark",
            "summary_card": {
                "benchmark_id": "mini_benchmark",
                "status": "blocked",
                "passed": False,
                "published_anchor": {"effect_measure": "OR", "effect": 0.66},
                "observed_primary": {"effect_measure": "RR", "effect": 0.73},
                "failing_gates": [
                    {
                        "gate": "primary_full_text_recall",
                        "label": "Primary full-text recall",
                        "passed": False,
                    }
                ],
                "missing_primary_full_texts": [
                    {"trial_id": "trial_b", "trial_name": "Trial B"},
                ],
                "next_actions": [{"type": "upload_full_texts", "message": "Upload PDFs."}],
            },
        },
        subdir="benchmark",
    )
    project.add_warning(
        "pdf_parsing",
        "Failed to parse one PDF",
        code="pdf_parse_failed",
        context={"file": "trial.pdf"},
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {
                "outcomes": 1,
                "rows_requiring_review": 1,
                "conflict_rows": 1,
            },
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "study_label": "Smith 2024",
                    "title": "Trial",
                    "outcome_name": "28-day mortality",
                    "outcome_type": "dichotomous",
                    "value_summary": "events_i=None, total_i=324",
                    "source_location": "Table 2",
                    "source_page": 5,
                    "source_quote": "29.3%",
                    "source_quote_verified": True,
                    "extraction_confidence": "medium",
                    "requires_review": True,
                    "conflicts": [
                        {
                            "field": "events_intervention",
                            "message": "Count fields require explicit whole-number counts.",
                            "sources": ["schema_count_validation"],
                        }
                    ],
                }
            ],
        },
        subdir="extraction",
    )

    ctx = {}
    payload = _load_evidence_readiness_payload(project, ctx)

    assert payload["report_type"] == "evidence_gap"
    assert payload["status"] == "blocked"
    assert payload["action_required"] is True
    assert payload["validation"]["error_count"] == 1
    assert payload["validation"]["warning_count"] == 1
    assert payload["selected_primary_rows"][0]["row_id"] == "S1:0"
    assert payload["fulltext_upload_rows"][0]["row_id"] == "S1:0"
    assert payload["fulltext_upload_rows"][0]["pmid"] == "S1"
    assert payload["fulltext_upload_rows"][0]["doi"] == "10.1000/example"
    assert payload["fulltext_upload_rows"][0]["requires_user_full_text"] is True
    assert payload["fulltext_upload_rows"][0]["suggested_upload"]["type"] == "fulltext_upload"
    assert payload["fulltext_upload_rows"][0]["suggested_upload"]["project_dir"] == str(project.base_dir)
    assert payload["primary_population"]["selected_total_participants"] == 1535
    assert payload["benchmark"]["status"] == "blocked"
    assert payload["benchmark"]["summary_card"]["benchmark_id"] == "mini_benchmark"
    assert payload["benchmark"]["failing_gates"][0]["gate"] == "primary_full_text_recall"
    assert payload["benchmark"]["missing_primary_full_texts"][0]["trial_name"] == "Trial B"
    assert payload["benchmark"]["summary"]["source_acquisition_tasks"] == 1
    assert payload["benchmark"]["source_acquisition_tasks"][0]["task_type"] == "primary_source_request"
    assert payload["pipeline_warning_count"] == 1
    assert payload["pipeline_warnings"][0]["code"] == "pdf_parse_failed"
    assert payload["extraction_review_queue"][0]["needs_user_count_verification"] is True
    assert payload["count_conflict_rows"][0]["row_id"] == "S1:0"
    assert payload["timepoint_adjudication_rows"][0]["row_id"] == "S1:0"
    assert payload["timepoint_adjudication_rows"][0]["requires_user_adjudication"] is True
    assert payload["timepoint_adjudication_rows"][0]["suggested_overrides"][0]["field"] == "timepoint_adjudication_note"
    assert payload["primary_count_verification_rows"][0]["row_id"] == "S1:0"
    assert payload["primary_count_verification_rows"][0]["missing_values"] == ["total_intervention=324"]
    assert payload["primary_count_verification_rows"][0]["suggested_overrides"][0]["field"] == "source_quote"
    assert payload["source_context_summary"]["source_context_missing_cards"] == 1
    assert payload["selected_primary_source_context"]["selected_primary_source_cards"] == 1
    assert payload["selected_primary_source_context"]["selected_primary_source_context_available_cards"] == 0
    assert payload["selected_primary_source_context"]["selected_primary_source_context_missing_cards"] == 1
    assert payload["selected_primary_source_context"]["selected_primary_source_context_coverage"] == 0.0
    assert ctx["n_evidence_blockers"] == 3
    assert ctx["n_evidence_warnings"] == 1
    assert ctx["n_pipeline_warnings"] == 1
    assert ctx["n_timepoint_adjudication_rows"] == 1
    assert ctx["n_primary_count_verification_rows"] == 1
    assert ctx["n_fulltext_upload_rows"] == 1
    assert ctx["benchmark_status"] == "blocked"
    assert ctx["n_benchmark_failing_gates"] == 1
    assert ctx["manuscript_validation_passed"] is False
    assert ctx["n_selected_primary_source_context_available"] == 0
    assert ctx["n_selected_primary_source_context_missing"] == 1


def test_load_extraction_review_payload_builds_frontend_review_queue(tmp_path: Path) -> None:
    project = Project("extraction review payload", output_dir=tmp_path)
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 1, "rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S2:0",
                    "study_id": "S2",
                    "outcome_index": 0,
                    "outcome_name": "Mortality",
                    "timepoint": "21 days",
                    "accepted_timepoint": "21-day mortality",
                    "timepoint_adjudication_note": "Accepted closest endpoint.",
                    "requires_review": True,
                    "conflicts": [
                        {
                            "field": "events_control",
                            "message": "Count fields require explicit whole-number counts.",
                            "sources": ["schema_count_validation"],
                        }
                    ],
                }
            ],
        },
        subdir="extraction",
    )

    ctx = {}
    payload = _load_extraction_review_payload(project, ctx)

    assert payload["summary"]["count_conflict_rows"] == 1
    assert payload["review_rows"][0]["row_id"] == "S2:0"
    assert payload["review_rows"][0]["timepoint"] == "21 days"
    assert payload["review_rows"][0]["timepoint_adjudication_note"] == "Accepted closest endpoint."
    assert payload["conflict_rows"][0]["conflicts"][0]["field"] == "events_control"
    assert payload["count_conflict_rows"][0]["needs_user_count_verification"] is True
    assert ctx["n_count_conflict_rows"] == 1


def test_load_extraction_review_payload_builds_source_cards_with_edit_actions(tmp_path: Path) -> None:
    project = Project("extraction source cards", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id="S3",
                    pmid="S3",
                    doi="10.1000/source-card",
                    title="Source Card Trial",
                    source_type="user_upload",
                    pdf_path="/tmp/source-card.pdf",
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        events_intervention=4,
                        total_intervention=50,
                        events_control=9,
                        total_control=50,
                        source_location="Table 2",
                        source_page=5,
                        source_section="Results",
                        source_quote="Mortality was 4/50 vs 9/50 at 28 days.",
                        source_quote_verified=True,
                        source_quote_match="Mortality was 4/50 vs 9/50 at 28 days.",
                        extraction_confidence="medium",
                    )
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json(
        "extraction_overrides.json",
        {"schema_version": 1, "current_revision": 3, "overrides": []},
        subdir="extraction",
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 1, "rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S3:0",
                    "study_id": "S3",
                    "outcome_index": 0,
                    "study_label": "Smith 2024",
                    "title": "Source Card Trial",
                    "outcome_name": "28-day mortality",
                    "outcome_type": "dichotomous",
                    "value_summary": "I events/total=4/50; C events/total=9/50",
                    "source_location": "Table 2",
                    "source_page": 5,
                    "source_section": "Results",
                    "source_quote": "Mortality was 4/50 vs 9/50 at 28 days.",
                    "source_quote_verified": True,
                    "source_quote_match": "Mortality was 4/50 vs 9/50 at 28 days.",
                    "extraction_confidence": "medium",
                    "requires_review": True,
                    "conflicts": [
                        {
                            "field": "events_control",
                            "message": "Please confirm control events.",
                            "sources": ["manual_review"],
                        }
                    ],
                }
            ],
        },
        subdir="extraction",
    )

    payload = _load_extraction_review_payload(project, {})
    card = payload["source_cards"][0]

    assert payload["summary"]["source_cards"] == 1
    assert payload["summary"]["review_cards"] == 1
    assert card["row_id"] == "S3:0"
    assert card["study"]["pdf_path"] == "/tmp/source-card.pdf"
    assert card["source"]["page"] == 5
    assert card["source"]["quote_verified"] is True
    assert card["override"]["current_revision"] == 3
    values = {item["field"]: item for item in card["values"]}
    assert values["events_intervention"]["value"] == 4
    assert values["events_control"]["conflicts"][0]["message"] == "Please confirm control events."
    assert values["events_control"]["suggested_override"]["field"] == "events_control"
    assert values["source_quote"]["suggested_override"]["value"] == "Mortality was 4/50 vs 9/50 at 28 days."
    assert payload["review_cards"][0]["row_id"] == "S3:0"


def test_load_extraction_review_payload_includes_persisted_source_cards_missing_from_audit(tmp_path: Path) -> None:
    project = Project("frontend persisted source card", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", pmid="12345", title="Persisted Outcome Trial"),
                outcomes=[
                    OutcomeData(outcome_name="background outcome", outcome_type="dichotomous"),
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        events_intervention=11,
                        total_intervention=75,
                        events_control=20,
                        total_control=73,
                        source_quote="11/75 deaths and 20/73 deaths.",
                        source_quote_verified=True,
                        extraction_confidence="high",
                    ),
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 2},
            "rows": [
                {
                    "row_id": "12345:0",
                    "study_id": "12345",
                    "outcome_index": 0,
                    "outcome_name": "background outcome",
                    "requires_review": False,
                    "conflicts": [],
                }
            ],
        },
        subdir="extraction",
    )

    ctx = {}
    payload = _load_extraction_review_payload(project, ctx)

    assert {card["row_id"] for card in payload["source_cards"]} == {"12345:0", "12345:1"}
    assert payload["summary"]["extraction_source_cards"] == 2
    assert ctx["n_extraction_source_cards"] == 2


def test_save_evidence_gap_validation_persists_review_payload(tmp_path: Path) -> None:
    project = Project("gate gap", output_dir=tmp_path)

    class ReportStateLike:
        n_direct_eligible = 0
        n_meta_eligible = 0

    manuscript = _save_evidence_gap_validation(
        project=project,
        protocol=_protocol(),
        manuscript="# Evidence Gap\n\nNo direct evidence.",
        extracted_studies=[],
        rob_results=[],
        prisma_data={"identification": {"records_identified": 5}},
        search_query="mortality treatment",
        report_state=ReportStateLike(),
    )
    payload = _load_evidence_readiness_payload(project, {})

    assert "Evidence readiness warning" in manuscript
    assert project.load_json("manuscript_facts.json", subdir="manuscript")["report_type"] == "evidence_gap"
    assert project.load_json("manuscript_validation.json", subdir="manuscript")["passed"] is False
    assert payload["blocker_codes"] == ["insufficient_primary_effects", "evidence_gate_evidence_gap"]
