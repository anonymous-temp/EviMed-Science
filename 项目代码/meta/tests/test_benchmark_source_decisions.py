from pathlib import Path

from new_meta.core.benchmark_review import build_benchmark_review_payload
from new_meta.core.benchmark_source_decisions import save_benchmark_source_decision
from new_meta.core.benchmark_sources import attach_benchmark_sources_to_project
from new_meta.core.project import Project


def _project_with_candidate(tmp_path: Path) -> Project:
    project = Project("benchmark source decision", output_dir=tmp_path)
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
    upload = tmp_path / "steroids-sari-registry.txt"
    upload.write_text(
        "Registry results: 13 deaths among 24 participants assigned methylprednisolone, "
        "and 13 deaths among 23 participants assigned usual care.",
        encoding="utf-8",
    )
    attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id="primary_source:steroids_sari",
        trial_id="steroids_sari",
        trial_name="Steroids-SARI",
        source_kind="registry_results",
    )
    return project


def test_benchmark_source_decision_marks_candidate_as_accepted(tmp_path: Path) -> None:
    project = _project_with_candidate(tmp_path)
    payload = build_benchmark_review_payload(project)
    task = payload["source_acquisition_tasks"][0]
    source = task["uploaded_sources"][0]
    candidate = source["quote_candidates"][0]

    saved = save_benchmark_source_decision(
        project,
        task_id=task["task_id"],
        trial_id=task["trial_id"],
        source=source,
        candidate=candidate,
        decision="accepted",
        reason="Reviewer checked the uploaded registry result.",
        updated_by="tester",
        expected_revision=0,
    )
    refreshed = build_benchmark_review_payload(project)
    refreshed_task = refreshed["source_acquisition_tasks"][0]
    refreshed_candidate = refreshed_task["uploaded_sources"][0]["quote_candidates"][0]
    manifest = project.load_json("benchmark_source_decisions.json", subdir="benchmark")

    assert saved.current_revision == 1
    assert manifest["current_revision"] == 1
    assert manifest["decisions"][0]["decision"] == "accepted"
    assert manifest["decisions"][0]["candidate_id"] == candidate["candidate_id"]
    assert refreshed["summary"]["source_decision_revision"] == 1
    assert refreshed["summary"]["accepted_source_candidates"] == 1
    assert refreshed_task["status"] == "source_candidate_accepted_needs_override"
    assert refreshed_candidate["review_decision"]["decision"] == "accepted"
    assert refreshed_candidate["review_decision"]["reason"] == "Reviewer checked the uploaded registry result."


def test_benchmark_source_decision_rejects_stale_revision(tmp_path: Path) -> None:
    project = _project_with_candidate(tmp_path)
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
        expected_revision=0,
    )

    try:
        save_benchmark_source_decision(
            project,
            task_id=task["task_id"],
            trial_id=task["trial_id"],
            source=source,
            candidate=candidate,
            decision="rejected",
            expected_revision=0,
        )
    except RuntimeError as exc:
        assert "stale benchmark source decision revision" in str(exc)
    else:
        raise AssertionError("stale benchmark source decision writes must be rejected")


def test_benchmark_source_decision_survives_quote_context_regeneration(tmp_path: Path) -> None:
    project = _project_with_candidate(tmp_path)
    payload = build_benchmark_review_payload(project)
    task = payload["source_acquisition_tasks"][0]
    source = task["uploaded_sources"][0]
    candidate = source["quote_candidates"][0]
    original_candidate_id = candidate["candidate_id"]

    save_benchmark_source_decision(
        project,
        task_id=task["task_id"],
        trial_id=task["trial_id"],
        source=source,
        candidate=candidate,
        decision="accepted",
        expected_revision=0,
    )
    parsed_path = project.base_dir / source["parsed_path"]
    parsed = parsed_path.read_text(encoding="utf-8")
    parsed_path.write_text(
        parsed.replace(
            "Registry results:",
            "Registry results confirmed in a reviewer-shortened quote:",
        ),
        encoding="utf-8",
    )

    refreshed = build_benchmark_review_payload(project)
    refreshed_candidate = refreshed["source_acquisition_tasks"][0]["uploaded_sources"][0]["quote_candidates"][0]

    assert refreshed_candidate["candidate_id"] != original_candidate_id
    assert refreshed["summary"]["accepted_source_candidates"] == 1
    assert refreshed_candidate["review_decision"]["decision"] == "accepted"
    assert refreshed_candidate["review_decision"]["candidate_id"] == original_candidate_id
