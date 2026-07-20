from pathlib import Path
from uuid import uuid4

from start import (
    META_ROOT,
    _apply_benchmark_source_candidates_payload,
    _attach_benchmark_source_payload,
    _save_benchmark_source_decision_payload,
)
from new_meta.core.benchmark_review import build_benchmark_review_payload
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_attach_benchmark_source_payload_returns_updated_review() -> None:
    project = Project(
        "benchmark source web",
        output_dir=META_ROOT / "output" / "pytest_benchmark_source" / uuid4().hex,
    )
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
                        "trial_id": "covid_steroid",
                        "trial_name": "COVID STEROID",
                        "registration_id": "NCT04348305",
                        "aliases": ["Hydrocortisone for COVID-19 and Severe Hypoxia"],
                    }
                ],
            },
        },
        subdir="benchmark",
    )
    upload = project.base_dir / "incoming_registry_result.pdf"
    upload.write_bytes(b"%PDF registry")

    result = _attach_benchmark_source_payload(
        {
            "project_dir": str(project.base_dir),
            "task_id": "primary_source:covid_steroid",
            "trial_id": "covid_steroid",
            "trial_name": "COVID STEROID",
            "source_kind": "registry_results",
        },
        [str(upload)],
        user_id="u1",
    )

    task = result["benchmark"]["source_acquisition_tasks"][0]
    assert result["ok"] is True
    assert result["attached"] == 1
    assert result["type"] == "benchmark_source_upload"
    assert task["status"] == "source_uploaded_needs_review"
    assert task["uploaded_sources"][0]["source_kind"] == "registry_results"
    assert result["evidence_readiness"] is None


def test_save_benchmark_source_decision_payload_persists_review_state() -> None:
    project = Project(
        "benchmark source decision web",
        output_dir=META_ROOT / "output" / "pytest_benchmark_source_decision" / uuid4().hex,
    )
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "covid_benchmark",
            "summary_card": {
                "benchmark_id": "covid_benchmark",
                "status": "blocked",
                "passed": False,
                "missing_primary_full_texts": [
                    {"trial_id": "steroids_sari", "trial_name": "Steroids-SARI"},
                ],
            },
            "primary_analysis": {
                "missing": [
                    {
                        "trial_id": "steroids_sari",
                        "trial_name": "Steroids-SARI",
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
    upload = project.base_dir / "registry.txt"
    upload.write_text("13 deaths among 24 participants and 13 deaths among 23 controls.", encoding="utf-8")
    _attach_benchmark_source_payload(
        {
            "project_dir": str(project.base_dir),
            "task_id": "primary_source:steroids_sari",
            "trial_id": "steroids_sari",
            "trial_name": "Steroids-SARI",
            "source_kind": "registry_results",
        },
        [str(upload)],
        user_id="u1",
    )
    review = build_benchmark_review_payload(project)
    task = review["source_acquisition_tasks"][0]
    source = task["uploaded_sources"][0]
    candidate = source["quote_candidates"][0]

    result = _save_benchmark_source_decision_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "task_id": task["task_id"],
            "trial_id": task["trial_id"],
            "source": source,
            "candidate": candidate,
            "decision": "accepted",
            "reason": "Looks source-backed.",
        },
        user_id="u1",
    )

    refreshed_task = result["benchmark"]["source_acquisition_tasks"][0]
    refreshed_candidate = refreshed_task["uploaded_sources"][0]["quote_candidates"][0]
    assert result["ok"] is True
    assert result["type"] == "benchmark_source_decision"
    assert result["current_revision"] == 1
    assert refreshed_task["status"] == "source_candidate_accepted_needs_override"
    assert refreshed_candidate["review_decision"]["decision"] == "accepted"


def test_apply_benchmark_source_candidates_payload_updates_extractions_and_clears_downstream() -> None:
    project = Project(
        "benchmark source apply web",
        output_dir=META_ROOT / "output" / "pytest_benchmark_source_apply" / uuid4().hex,
    )
    project.save_json(
        "protocol.json",
        ResearchProtocol(
            research_question="Steroids for mortality",
            pico=PICO(
                population="critically ill adults",
                intervention="steroids",
                comparator="usual care",
                outcome_primary="28-day all-cause mortality",
            ),
            effect_measure="RR",
        ),
    )
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "covid_benchmark",
            "summary_card": {
                "benchmark_id": "covid_benchmark",
                "status": "blocked",
                "passed": False,
                "missing_primary_full_texts": [
                    {"trial_id": "steroids_sari", "trial_name": "Steroids-SARI"},
                ],
            },
            "primary_analysis": {
                "missing": [
                    {
                        "trial_id": "steroids_sari",
                        "trial_name": "Steroids-SARI",
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
    for step in ["extraction", "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)
    upload = project.base_dir / "registry.txt"
    upload.write_text("13 deaths among 24 participants and 13 deaths among 23 controls.", encoding="utf-8")
    _attach_benchmark_source_payload(
        {
            "project_dir": str(project.base_dir),
            "task_id": "primary_source:steroids_sari",
            "trial_id": "steroids_sari",
            "trial_name": "Steroids-SARI",
            "source_kind": "registry_results",
        },
        [str(upload)],
        user_id="u1",
    )
    review = build_benchmark_review_payload(project)
    task = review["source_acquisition_tasks"][0]
    source = task["uploaded_sources"][0]
    candidate = source["quote_candidates"][0]
    _save_benchmark_source_decision_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "task_id": task["task_id"],
            "trial_id": task["trial_id"],
            "source": source,
            "candidate": candidate,
            "decision": "accepted",
        },
        user_id="u1",
    )

    result = _apply_benchmark_source_candidates_payload(
        {
            "project_dir": str(project.base_dir),
            "candidate_ids": [candidate["candidate_id"]],
            "expected_revision": 0,
        },
        user_id="u1",
    )

    extractions = project.load_json("all_extractions.json", subdir="extraction")
    assert result["ok"] is True
    assert result["applied"] == 1
    assert result["created_studies"] == 1
    assert result["current_revision"] == 1
    assert result["cleared_checkpoints"] == ["effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]
    assert project.is_step_done("extraction") is True
    assert project.is_step_done("effect_sizes") is False
    assert extractions[0]["outcomes"][0]["events_intervention"] == 13
    assert result["extraction_review"]["summary"]["extraction_source_cards"] == 1
