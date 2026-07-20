from pathlib import Path

import pytest

from new_meta.agents.data_extraction_agent import DataExtractionAgent
from new_meta.core.extraction_review import (
    ExtractionOverride,
    ExtractionReviewDecision,
    OverrideConflictError,
    apply_extraction_overrides,
    apply_extraction_review_decisions_to_audit,
    build_extraction_source_cards,
    has_count_conflict,
    load_extraction_review_decisions,
    load_extraction_overrides,
    save_extraction_review_decision,
    save_extraction_override,
    summarize_selected_primary_source_context,
)
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics
from new_meta.tools.registry_seed import seed_to_record


def _protocol(effect_measure: str = "MD") -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does treatment improve HbA1c?",
        pico=PICO(
            population="type 2 diabetes",
            intervention="treatment",
            comparator="placebo",
            outcome_primary="HbA1c",
        ),
        effect_measure=effect_measure,
    )


def test_extraction_audit_surfaces_confidence_traceability_and_review_flags() -> None:
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Trial",
            authors=["Smith J"],
            year=2024,
        ),
        outcomes=[
            OutcomeData(
                outcome_name="HbA1c",
                outcome_type="continuous",
                mean_intervention=7.0,
                mean_control=8.0,
                effect_size=-3.0,
                source_quote="HbA1c changed by -1.0 percentage points",
                source_quote_verified=False,
            )
        ],
    )
    agent = DataExtractionAgent()
    agent._finalize_outcome_review_fields(study, _protocol())

    audit = agent._build_extraction_audit([study])

    assert audit["summary"]["outcomes"] == 1
    assert audit["summary"]["source_quotes_unverified"] == 1
    assert audit["summary"]["confidence"]["low"] == 1
    assert audit["summary"]["rows_requiring_review"] == 1
    assert audit["summary"]["conflict_rows"] == 1

    row = audit["rows"][0]
    assert row["row_id"] == "S1:0"
    assert row["outcome_index"] == 0
    assert row["extraction_confidence"] == "low"
    assert row["requires_review"] is True
    assert row["conflicts"][0]["field"] == "effect_size"


def test_source_quote_verification_tolerates_pdf_side_column_insertion() -> None:
    source_text = (
        "The primary outcome event occurred in 415 of 2997 "
        "Drs. Anker and Butler contributed equally to this article. "
        "patients (13.8%) in the empagliflozin group and in 511 of 2991 patients "
        "(17.1%) in the placebo group (hazard ratio, 0.79; 95% confidence "
        "interval [CI], 0.69 to 0.90; This article was published on August 27, "
        "P<0.001)."
    )
    quote = (
        "a primary outcome event occurred in 415 of 2997 patients (13.8%) in the "
        "empagliflozin group and in 511 of 2991 patients (17.1%) in the placebo "
        "group (hazard ratio, 0.79; 95% confidence interval [CI], 0.69 to 0.90; "
        "P<0.001)"
    )

    pos, match = DataExtractionAgent._find_quote(source_text, quote)

    assert pos >= 0
    assert "415 of 2997" in match
    assert "hazard ratio, 0.79" in match


def test_count_fallback_requires_all_arm_counts_in_one_local_source_window() -> None:
    outcome = OutcomeData(
        events_intervention=10,
        total_intervention=100,
        events_control=20,
        total_control=200,
    )
    local = (
        "Treatment had 10 events among 100 participants; control had 20 events "
        "among 200 participants."
    )
    scattered = (
        "The introduction cited 10 prior reviews and 100 registry records. "
        + ("Unrelated background text. " * 150)
        + "A later appendix listed 20 centers and 200 screened reports."
    )

    assert DataExtractionAgent._counts_evidenced_in_source(outcome, local) is True
    assert DataExtractionAgent._counts_evidenced_in_source(outcome, scattered) is False


def test_metadata_only_registry_seed_is_not_extracted(tmp_path: Path) -> None:
    project = Project("metadata-only extraction", output_dir=tmp_path)
    paper = seed_to_record({
        "nct_id": "NCT04244591",
        "title": "Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure",
        "brief_summary": "Randomized trial metadata without outcome counts.",
        "year": 2020,
    })

    result = DataExtractionAgent()._extract_single(paper, {}, _protocol(effect_measure="RR"), project)
    warnings = project.load_json("pipeline_warnings.json")

    assert result is None
    assert warnings[0]["code"] == "metadata_only_extraction_skipped"
    assert warnings[0]["context"]["trial_registration"] == "NCT04244591"


def test_abstract_only_record_is_never_used_for_quantitative_extraction(
    tmp_path: Path,
) -> None:
    project = Project("abstract-only extraction", output_dir=tmp_path)
    paper = {
        "pmid": "12345",
        "title": "Trial abstract",
        "abstract": "Ten of 50 participants had the primary outcome.",
        "fulltext_path": "/tmp/12345.abstract.txt",
        "fulltext_source": "europe_pmc_abstract",
        "text_availability": "abstract_only",
    }
    agent = DataExtractionAgent()
    agent.call_llm_structured = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("the LLM must not extract quantitative data from an abstract")
    )

    result = agent._extract_single(
        paper,
        {"full_text": "Ten of 50 participants had the primary outcome."},
        _protocol(effect_measure="RR"),
        project,
    )
    warnings = project.load_json("pipeline_warnings.json")

    assert result is None
    assert warnings[0]["code"] == "abstract_only_extraction_skipped"


def test_extraction_overrides_apply_with_revision_checks(tmp_path: Path) -> None:
    project = Project("override test", output_dir=tmp_path)
    first = save_extraction_override(
        project,
        ExtractionOverride(
            study_id="PMID1",
            outcome_index=0,
            outcome_name="HbA1c",
            field="mean_intervention",
            value=6.8,
            updated_by="tester",
        ),
        expected_revision=0,
    )
    assert first.current_revision == 1

    with pytest.raises(OverrideConflictError):
        save_extraction_override(
            project,
            ExtractionOverride(
                study_id="PMID1",
                outcome_index=0,
                outcome_name="HbA1c",
                field="mean_intervention",
                value=6.7,
                updated_by="tester",
            ),
            expected_revision=0,
        )

    study = ExtractedStudy(
        characteristics=StudyCharacteristics(study_id="PMID1"),
        outcomes=[OutcomeData(outcome_name="HbA1c", mean_intervention=7.1)],
    )
    applied = apply_extraction_overrides([study], load_extraction_overrides(project))

    assert applied == 1
    assert study.outcomes[0].mean_intervention == 6.8
    assert study.outcomes[0].user_override_applied is True
    assert study.outcomes[0].override_revision == 1


def test_extraction_source_cards_use_shared_contract(tmp_path: Path) -> None:
    project = Project("source card core", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id="SGLT2",
                    pmid="12345",
                    title="SGLT2 Trial",
                    source_type="user_upload",
                    pdf_path="/tmp/sglt2.pdf",
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="primary composite",
                        outcome_type="time_to_event",
                        hazard_ratio=0.8,
                        hr_ci_lower=0.73,
                        hr_ci_upper=0.87,
                        source_location="Table 2",
                        source_page=5,
                        source_quote="hazard ratio, 0.80; 95% CI, 0.73 to 0.87",
                        source_quote_verified=True,
                        extraction_confidence="high",
                    )
                ],
            )
        ],
        subdir="extraction",
    )
    project.save_json(
        "extraction_overrides.json",
        {"schema_version": 1, "current_revision": 7, "overrides": []},
        subdir="extraction",
    )
    audit_row = {
        "row_id": "12345:0",
        "study_id": "12345",
        "outcome_index": 0,
        "study_label": "Trial 2022",
        "outcome_name": "primary composite",
        "outcome_type": "time_to_event",
        "source_quote_verified": True,
        "requires_review": True,
        "conflicts": [
            {
                "field": "total_intervention",
                "message": "Count fields require explicit whole-number counts.",
                "sources": ["schema_count_validation"],
            }
        ],
    }
    project.save_json(
        "extraction_audit.json",
        {"summary": {"outcomes": 1}, "rows": [audit_row]},
        subdir="extraction",
    )

    cards = build_extraction_source_cards(project)

    assert has_count_conflict(audit_row) is True
    assert len(cards) == 1
    card = cards[0]
    assert card["row_id"] == "12345:0"
    assert card["study"]["pdf_path"] == "/tmp/sglt2.pdf"
    assert card["source"]["quote_verified"] is True
    assert card["source_anchor"] == {
        "kind": "pdf_text_quote",
        "pdf_path": "/tmp/sglt2.pdf",
        "page": 5,
        "section": None,
        "location": "Table 2",
        "quote": "hazard ratio, 0.80; 95% CI, 0.73 to 0.87",
        "quote_match": None,
        "highlight_text": "hazard ratio, 0.80; 95% CI, 0.73 to 0.87",
        "verified": True,
        "can_open_pdf": True,
        "needs_manual_location": False,
    }
    assert card["trust"] == {
        "status": "needs_review",
        "quote_verified": True,
        "confidence": "high",
        "requires_review": True,
        "has_conflicts": True,
        "review_reasons": ["conflicts_present", "count_conflict"],
    }
    assert card["override"]["current_revision"] == 7
    assert card["review_action"]["current_revision"] == 0
    assert card["review_action"]["save_message_type"] == "extraction_review_decision"
    assert card["review_action"]["suggested_decision"]["row_id"] == "12345:0"
    assert card["review_action"]["suggested_decision"]["decision"] == "accepted"
    assert "count_conflict" in card["review_reasons"]
    values = {item["field"]: item for item in card["values"]}
    assert values["hazard_ratio"]["label"] == "hazard ratio"
    assert values["hazard_ratio"]["editable"] is True
    assert values["hazard_ratio"]["suggested_override"]["study_id"] == "12345"


def test_extraction_source_cards_include_source_context_from_parsed_full_text(tmp_path: Path) -> None:
    project = Project("source context", output_dir=tmp_path)
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
                        outcome_name="mortality",
                        outcome_type="dichotomous",
                        events_intervention=11,
                        total_intervention=75,
                        events_control=20,
                        total_control=73,
                        source_quote="11 of 75 patients died vs 20 of 73 patients.",
                        source_quote_match="11 of 75 patients died vs 20 of 73 patients.",
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
                    "[PAGE 5]\nBefore the table. "
                    "11 of 75 patients died vs 20 of 73 patients. "
                    "After the table."
                ),
                "page_map": [{"page_number": 5, "start_char": 0, "end_char": 95}],
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
                    "outcome_name": "mortality",
                    "source_quote": "11 of 75 patients died vs 20 of 73 patients.",
                    "source_quote_match": "11 of 75 patients died vs 20 of 73 patients.",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": False,
                    "conflicts": [],
                }
            ],
        },
        subdir="extraction",
    )
    [card] = build_extraction_source_cards(project)

    context = card["source_context"]
    assert context["available"] is True
    assert context["page"] == 5
    assert context["match_text"] == "11 of 75 patients died vs 20 of 73 patients."
    assert "Before the table." in context["prefix"]
    assert "After the table." in context["suffix"]
    assert context["source_file"] == "papers/parsed_papers.json"


def test_source_context_recovers_verified_row_from_numeric_context_window(tmp_path: Path) -> None:
    project = Project("numeric source context", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", pmid="12345", title="Numeric Context Trial"),
                outcomes=[
                    OutcomeData(
                        outcome_name="All-cause mortality at day 28",
                        outcome_type="dichotomous",
                        events_intervention=6,
                        total_intervention=16,
                        events_control=2,
                        total_control=14,
                        effect_size=2.63,
                        ci_lower=0.74,
                        ci_upper=16.03,
                        source_quote=(
                            "End point values Hydrocortisone Placebo Number of subjects analysed "
                            "16 14 Units: Number 6 2 ... Point estimate 2.63 Confidence interval 0.74 to 16.03"
                        ),
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
                    "[PAGE 9]\nThe trial report described no significant differences in all-cause "
                    "mortality at 28 and 90 days. At 28 days, 16 patients were allocated to "
                    "hydrocortisone and 14 were allocated to placebo, RR 2.63, 95% CI 0.74 "
                    "to 16.03, P=.19. Additional respiratory-support outcomes followed."
                ),
                "page_map": [{"page_number": 9, "start_char": 0, "end_char": 308}],
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
                    "outcome_name": "All-cause mortality at day 28",
                    "outcome_type": "dichotomous",
                    "source_quote": (
                        "End point values Hydrocortisone Placebo Number of subjects analysed "
                        "16 14 Units: Number 6 2 ... Point estimate 2.63 Confidence interval 0.74 to 16.03"
                    ),
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": False,
                    "conflicts": [],
                }
            ],
        },
        subdir="extraction",
    )
    [card] = build_extraction_source_cards(project)

    context = card["source_context"]
    assert context["available"] is True
    assert context["match_strategy"] == "numeric_context"
    assert context["page"] == 9
    assert "mortality at 28" in context["match_text"]
    assert "RR 2.63" in context["match_text"]
    assert "0.74 to 16.03" in context["match_text"]


def test_source_context_does_not_match_numbers_without_outcome_context(tmp_path: Path) -> None:
    project = Project("numeric source context guard", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", pmid="12345", title="Guard Trial"),
                outcomes=[
                    OutcomeData(
                        outcome_name="Kansas City Cardiomyopathy Questionnaire score",
                        outcome_type="continuous",
                        mean_intervention=5.9,
                        mean_control=3.4,
                        source_quote="KCCQ score changed by 5.9 vs 3.4 points.",
                        source_quote_verified=True,
                        extraction_confidence="medium",
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
                    "[PAGE 3]\nBaseline body-mass index was 29.77±5.8 and 29.90±5.9. "
                    "An unrelated exploratory analysis reported a range from 1.5 to 3.4."
                ),
                "page_map": [{"page_number": 3, "start_char": 0, "end_char": 150}],
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
                    "outcome_name": "Kansas City Cardiomyopathy Questionnaire score",
                    "outcome_type": "continuous",
                    "source_quote": "KCCQ score changed by 5.9 vs 3.4 points.",
                    "source_quote_verified": True,
                    "extraction_confidence": "medium",
                    "requires_review": True,
                    "conflicts": [],
                }
            ],
        },
        subdir="extraction",
    )
    [card] = build_extraction_source_cards(project)

    assert card["source_context"]["available"] is False
    assert card["source_context"]["match_strategy"] == "unavailable"


def test_source_context_does_not_treat_bundled_benchmark_meta_as_primary_source(tmp_path: Path) -> None:
    project = Project("known source context", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id="codex",
                    pmid="32876695",
                    title="CoDEX Randomized Clinical Trial",
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day mortality",
                        outcome_type="dichotomous",
                        events_intervention=69,
                        total_intervention=128,
                        events_control=76,
                        total_control=128,
                        source_location="WHO REACT Working Group. JAMA 2020 Figure 2",
                        source_section="Figure 2",
                        source_quote=(
                            "CoDEX (NCT04327401): deaths/total were 69/128 in the steroid arm "
                            "and 76/128 in the no-steroid arm."
                        ),
                        source_quote_match=(
                            "CoDEX (NCT04327401): deaths/total were 69/128 in the steroid arm "
                            "and 76/128 in the no-steroid arm."
                        ),
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
            "summary": {"outcomes": 1},
            "rows": [
                {
                    "row_id": "32876695:0",
                    "study_id": "32876695",
                    "outcome_index": 0,
                    "outcome_name": "28-day mortality",
                    "outcome_type": "dichotomous",
                    "source_location": "WHO REACT Working Group. JAMA 2020 Figure 2",
                    "source_section": "Figure 2",
                    "source_quote": (
                        "CoDEX (NCT04327401): deaths/total were 69/128 in the steroid arm "
                        "and 76/128 in the no-steroid arm."
                    ),
                    "source_quote_match": (
                        "CoDEX (NCT04327401): deaths/total were 69/128 in the steroid arm "
                        "and 76/128 in the no-steroid arm."
                    ),
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                    "requires_review": False,
                    "conflicts": [],
                }
            ],
        },
        subdir="extraction",
    )
    project.save_json(
        "parsed_papers.json",
        {
            "32876695": {
                "full_text": "The CoDEX trial article full text does not contain the WHO REACT Figure 2 arm-level row.",
                "page_map": [{"page_number": 1, "start_char": 0, "end_char": 88}],
            }
        },
        subdir="papers",
    )

    [card] = build_extraction_source_cards(project)

    context = card["source_context"]
    assert context["available"] is False
    assert context["match_strategy"] == "secondary_meta_source_rejected"
    assert context["source_file"] == "new_meta/data/known_source_evidence.json"
    assert context["source_url"] == "https://jamanetwork.com/journals/jama/fullarticle/2770279"
    assert context["match_text"].startswith("CoDEX (NCT04327401)")


def test_extraction_source_cards_include_persisted_outcomes_missing_from_audit(tmp_path: Path) -> None:
    project = Project("source cards include persisted outcomes", output_dir=tmp_path)
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
                        source_quote="11/75 deaths in the steroid arm and 20/73 in the no-steroid arm.",
                        source_quote_match="11/75 deaths in the steroid arm and 20/73 in the no-steroid arm.",
                        source_location="Figure 2",
                        source_quote_verified=True,
                        extraction_confidence="high",
                    ),
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
                    "[PAGE 2]\nFigure 2 reported 11/75 deaths in the steroid arm "
                    "and 20/73 in the no-steroid arm."
                ),
                "page_map": [{"page_number": 2, "start_char": 0, "end_char": 98}],
            }
        },
        subdir="papers",
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

    cards = build_extraction_source_cards(project)
    by_row = {card["row_id"]: card for card in cards}

    assert set(by_row) == {"12345:0", "12345:1"}
    selected_card = by_row["12345:1"]
    assert selected_card["source"]["location"] == "Figure 2"
    assert selected_card["values"][0]["suggested_override"]["outcome_index"] == 1
    assert selected_card["source_context"]["available"] is True
    assert selected_card["source_context"]["match_strategy"] == "quote"


def test_explicit_extraction_source_card_rows_are_not_augmented_from_persisted_outcomes(tmp_path: Path) -> None:
    project = Project("source card explicit rows", output_dir=tmp_path)
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(study_id="S1", pmid="12345", title="Persisted Outcome Trial"),
                outcomes=[
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

    cards = build_extraction_source_cards(
        project,
        rows=[
            {
                "row_id": "manual:0",
                "study_id": "manual",
                "outcome_index": 0,
                "outcome_name": "manual row",
                "requires_review": False,
                "conflicts": [],
            }
        ],
    )

    assert [card["row_id"] for card in cards] == ["manual:0"]


def test_extraction_source_cards_deduplicate_repeated_audit_row_ids(tmp_path: Path) -> None:
    project = Project("source card dedupe", output_dir=tmp_path)
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 2},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "outcome_name": "mortality",
                    "source_quote": "First source quote.",
                    "requires_review": False,
                    "conflicts": [],
                },
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "outcome_name": "mortality duplicate",
                    "source_quote": "Duplicate source quote.",
                    "requires_review": False,
                    "conflicts": [],
                },
            ],
        },
        subdir="extraction",
    )

    cards = build_extraction_source_cards(project)

    assert [card["row_id"] for card in cards] == ["S1:0"]
    assert cards[0]["source"]["quote"] == "First source quote."


def test_selected_primary_source_context_summary_focuses_on_rows_used_in_analysis() -> None:
    cards = [
        {
            "row_id": "S1:0",
            "study_id": "S1",
            "study": {"title": "Verified Trial"},
            "outcome": {"name": "28-day mortality"},
            "source": {"quote_verified": True},
            "requires_review": False,
            "source_context": {"available": True},
        },
        {
            "row_id": "S2:0",
            "study_id": "S2",
            "study": {"title": "Missing Trial"},
            "outcome": {"name": "28-day mortality"},
            "source": {"quote_verified": True},
            "requires_review": False,
            "source_context": {"available": False},
        },
        {
            "row_id": "S3:0",
            "study_id": "S3",
            "study": {"title": "Not Used Trial"},
            "outcome": {"name": "secondary outcome"},
            "source": {"quote_verified": True},
            "requires_review": False,
            "source_context": {"available": True},
        },
    ]

    summary = summarize_selected_primary_source_context(
        cards,
        [
            {"row_id": "S1:0"},
            {"row_id": "S2:0"},
            {"row_id": "S4:0"},
        ],
    )

    assert summary["selected_primary_source_cards"] == 2
    assert summary["selected_primary_source_context_available_cards"] == 1
    assert summary["selected_primary_source_context_missing_cards"] == 2
    assert summary["selected_primary_source_context_coverage"] == 0.3333
    assert [card["row_id"] for card in summary["missing_selected_primary_source_context_cards"]] == ["S2:0", "S4:0"]
    assert summary["missing_selected_primary_source_context_cards"][1]["missing_reason"] == "selected_primary_source_card_missing"


def test_extraction_review_decision_resolves_review_and_conflict_rows(tmp_path: Path) -> None:
    project = Project("review decision", output_dir=tmp_path)
    audit = {
        "summary": {
            "outcomes": 1,
            "rows_requiring_review": 1,
            "conflict_rows": 1,
            "source_quotes_verified": 0,
            "source_quotes_unverified": 1,
        },
        "rows": [
            {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_index": 0,
                "outcome_name": "mortality",
                "requires_review": True,
                "source_quote_verified": False,
                "conflicts": [
                    {
                        "field": "events_intervention",
                        "message": "Count fields require explicit whole-number counts.",
                    }
                ],
            }
        ],
    }
    saved = save_extraction_review_decision(
        project,
        ExtractionReviewDecision(
            row_id="S1:0",
            study_id="S1",
            outcome_index=0,
            decision="accepted",
            note="Checked against Table 2.",
            updated_by="tester",
        ),
        expected_revision=0,
    )

    resolved = apply_extraction_review_decisions_to_audit(
        audit,
        load_extraction_review_decisions(project),
    )

    assert saved.current_revision == 1
    assert resolved["summary"]["rows_requiring_review"] == 0
    assert resolved["summary"]["conflict_rows"] == 0
    assert resolved["summary"]["review_decisions_accepted"] == 1
    row = resolved["rows"][0]
    assert row["requires_review"] is False
    assert row["conflicts"] == []
    assert row["resolved_conflicts"][0]["field"] == "events_intervention"
    assert row["review_decision"]["decision"] == "accepted"
