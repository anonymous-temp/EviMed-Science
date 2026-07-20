from __future__ import annotations

from pathlib import Path

from new_meta.core.benchmark_review import build_benchmark_review_payload
from new_meta.core.benchmark_source_apply import apply_accepted_benchmark_source_candidates
from new_meta.core.benchmark_source_decisions import save_benchmark_source_decision
from new_meta.core.benchmark_sources import attach_benchmark_sources_to_project
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _mortality_protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Systemic corticosteroids for COVID-19 mortality",
        pico=PICO(
            population="critically ill adults with COVID-19",
            intervention="systemic corticosteroids",
            comparator="usual care or placebo",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
    )


def _project_with_accepted_candidate(
    tmp_path: Path,
    *,
    trial_id: str = "steroids_sari",
    trial_name: str = "Steroids-SARI",
    task_id: str = "primary_source:steroids_sari",
    publication_pmids: list[str] | None = None,
    publication_dois: list[str] | None = None,
) -> tuple[Project, str]:
    project = Project("benchmark source apply", output_dir=tmp_path)
    project.save_json("protocol.json", _mortality_protocol())
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "covid_benchmark",
            "summary_card": {
                "benchmark_id": "covid_benchmark",
                "status": "blocked",
                "passed": False,
                "missing_primary_full_texts": [
                    {
                        "trial_id": trial_id,
                        "trial_name": trial_name,
                        "registration_id": "NCT04244591",
                        "publication_pmids": publication_pmids or [],
                        "publication_dois": publication_dois or [],
                    },
                ],
            },
            "primary_analysis": {
                "missing": [
                    {
                        "trial_id": trial_id,
                        "trial_name": trial_name,
                        "registration_id": "NCT04244591",
                        "expected_events_intervention": 13,
                        "expected_total_intervention": 24,
                        "expected_events_control": 13,
                        "expected_total_control": 23,
                    }
                ]
            },
        },
        subdir="benchmark",
    )
    upload = tmp_path / "source.txt"
    upload.write_text(
        "Figure 2 reports deaths/total were 13/24 in the steroid arm "
        "and 13/23 in the no-steroid arm.",
        encoding="utf-8",
    )
    attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id=task_id,
        trial_id=trial_id,
        trial_name=trial_name,
        source_kind="benchmark_appendix",
    )
    payload = build_benchmark_review_payload(project)
    task = payload["source_acquisition_tasks"][0]
    source = task["uploaded_sources"][0]
    candidate = source["quote_candidates"][0]
    save_benchmark_source_decision(
        project,
        task_id=task["task_id"],
        trial_id=task["trial_id"],
        source=source,
        candidate=candidate,
        decision="accepted",
        reason="Reviewer checked the source figure.",
        updated_by="tester",
        expected_revision=0,
    )
    return project, candidate["candidate_id"]


def test_apply_accepted_benchmark_candidate_creates_manual_extraction_stub(tmp_path: Path) -> None:
    project, candidate_id = _project_with_accepted_candidate(tmp_path)

    result = apply_accepted_benchmark_source_candidates(
        project,
        candidate_ids=[candidate_id],
        updated_by="tester",
    )
    extractions = project.load_json("all_extractions.json", subdir="extraction")
    manifest = project.load_json("benchmark_source_applications.json", subdir="benchmark")

    assert result["ok"] is True
    assert result["created_studies"] == 1
    assert result["updated_outcomes"] == 0
    assert result["skipped_already_applied"] == 0
    assert len(extractions) == 1
    study = extractions[0]
    outcome = study["outcomes"][0]
    assert study["characteristics"]["study_id"] == "benchmark_source:steroids_sari"
    assert study["characteristics"]["source_type"] == "benchmark_source_review"
    assert study["characteristics"]["metadata_source"] == "benchmark_source_decision"
    assert outcome["outcome_name"] == "28-day all-cause mortality"
    assert outcome["events_intervention"] == 13
    assert outcome["total_intervention"] == 24
    assert outcome["events_control"] == 13
    assert outcome["total_control"] == 23
    assert outcome["source_quote_verified"] is True
    assert outcome["manual_adjudication"] is True
    assert outcome["user_override_applied"] is True
    assert manifest["current_revision"] == 1
    assert manifest["applications"][0]["candidate_id"] == candidate_id
    assert manifest["applications"][0]["action"] == "created_manual_study"

    second = apply_accepted_benchmark_source_candidates(
        project,
        candidate_ids=[candidate_id],
        updated_by="tester",
    )
    assert second["applied"] == 0
    assert second["skipped_already_applied"] == 1
    assert len(project.load_json("all_extractions.json", subdir="extraction")) == 1


def test_apply_accepted_benchmark_candidate_updates_existing_extraction_by_publication_id(
    tmp_path: Path,
) -> None:
    project, candidate_id = _project_with_accepted_candidate(
        tmp_path,
        trial_id="codex",
        trial_name="CoDEX",
        task_id="full_text:codex",
        publication_pmids=["32876695"],
        publication_dois=["10.1001/jama.2020.17021"],
    )
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id="32876695",
                    pmid="32876695",
                    doi="10.1001/jama.2020.17021",
                    title="CoDEX trial",
                    source_type="pubmed",
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day all-cause mortality",
                        outcome_type="dichotomous",
                        total_intervention=151,
                        total_control=148,
                        source_quote="Mortality was mentioned without arm-level events.",
                        source_quote_verified=True,
                    )
                ],
            )
        ],
        subdir="extraction",
    )

    result = apply_accepted_benchmark_source_candidates(
        project,
        candidate_ids=[candidate_id],
        updated_by="tester",
    )
    extractions = project.load_json("all_extractions.json", subdir="extraction")
    manifest = project.load_json("benchmark_source_applications.json", subdir="benchmark")

    assert result["ok"] is True
    assert result["created_studies"] == 0
    assert result["updated_outcomes"] == 1
    assert len(extractions) == 1
    outcome = extractions[0]["outcomes"][0]
    assert outcome["events_intervention"] == 13
    assert outcome["total_intervention"] == 24
    assert outcome["events_control"] == 13
    assert outcome["total_control"] == 23
    assert outcome["manual_adjudication"] is True
    assert manifest["applications"][0]["action"] == "updated_existing_outcome"
    assert manifest["applications"][0]["study_id"] == "32876695"
    assert manifest["applications"][0]["outcome_index"] == 0
    assert manifest["applications"][0]["previous_values"]["total_intervention"] == 151
    assert manifest["applications"][0]["previous_values"]["events_intervention"] is None


def test_apply_accepted_benchmark_candidate_survives_quote_context_regeneration(tmp_path: Path) -> None:
    project, candidate_id = _project_with_accepted_candidate(tmp_path)
    review = build_benchmark_review_payload(project)
    parsed_path = project.base_dir / review["source_acquisition_tasks"][0]["uploaded_sources"][0]["parsed_path"]
    parsed = parsed_path.read_text(encoding="utf-8")
    parsed_path.write_text(
        parsed.replace(
            "Registry results:",
            "Registry results confirmed in a reviewer-shortened quote:",
        ),
        encoding="utf-8",
    )

    result = apply_accepted_benchmark_source_candidates(
        project,
        candidate_ids=[candidate_id],
        updated_by="tester",
    )

    assert result["applied"] == 1
    assert result["skipped_not_found"] == 0
    assert project.load_json("all_extractions.json", subdir="extraction")[0]["outcomes"][0]["events_intervention"] == 13


def test_apply_count_discrepancy_candidate_updates_explicit_row_id(tmp_path: Path) -> None:
    project = Project("benchmark source row id", output_dir=tmp_path)
    project.save_json("protocol.json", _mortality_protocol())
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "covid_benchmark",
            "summary_card": {"benchmark_id": "covid_benchmark", "status": "blocked", "passed": False},
            "primary_analysis": {
                "matched": {
                    "recovery": {
                        "row_id": "RECOVERY:1",
                        "study_id": "RECOVERY",
                        "trial_name": "RECOVERY",
                        "title": "RECOVERY trial",
                        "events_intervention": 94,
                        "total_intervention": 324,
                        "events_control": 278,
                        "total_control": 683,
                        "expected_events_intervention": 95,
                        "expected_total_intervention": 324,
                        "expected_events_control": 283,
                        "expected_total_control": 683,
                        "count_mismatches": {
                            "events_intervention": {"observed": 94, "expected": 95},
                            "events_control": {"observed": 278, "expected": 283},
                        },
                    }
                }
            },
        },
        subdir="benchmark",
    )
    project.save_json(
        "all_extractions.json",
        [
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id="RECOVERY",
                    title="RECOVERY trial",
                    authors=["RECOVERY"],
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="28-day all-cause mortality",
                        outcome_type="dichotomous",
                        events_intervention=454,
                        total_intervention=2104,
                        events_control=1065,
                        total_control=4321,
                    ),
                    OutcomeData(
                        outcome_name="28-day all-cause mortality",
                        outcome_type="dichotomous",
                        subgroup="invasive mechanical ventilation",
                        events_intervention=94,
                        total_intervention=324,
                        events_control=278,
                        total_control=683,
                    ),
                ],
            )
        ],
        subdir="extraction",
    )
    upload = tmp_path / "figure2.txt"
    upload.write_text(
        "RECOVERY: deaths/total were 95/324 in the steroid arm and 283/683 in the no-steroid arm.",
        encoding="utf-8",
    )
    attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id="primary_count_discrepancy:recovery",
        trial_id="recovery",
        trial_name="RECOVERY",
        source_kind="benchmark_appendix",
    )
    review = build_benchmark_review_payload(project)
    task = review["source_acquisition_tasks"][0]
    source = task["uploaded_sources"][0]
    candidate = source["quote_candidates"][0]
    save_benchmark_source_decision(
        project,
        task_id=task["task_id"],
        trial_id=task["trial_id"],
        source=source,
        candidate=candidate,
        decision="accepted",
        expected_revision=0,
    )

    result = apply_accepted_benchmark_source_candidates(project, updated_by="tester")
    updated = project.load_json("all_extractions.json", subdir="extraction")[0]["outcomes"]

    assert result["updated_outcomes"] == 1
    assert updated[0]["events_intervention"] == 454
    assert updated[1]["events_intervention"] == 95
    assert updated[1]["events_control"] == 283
    assert result["applications"][0]["outcome_index"] == 1
