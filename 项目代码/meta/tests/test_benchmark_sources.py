from pathlib import Path
import json

from new_meta.core.benchmark_review import build_benchmark_review_payload
from new_meta.core.benchmark_sources import attach_benchmark_sources_to_project
from new_meta.core.project import Project


def test_attach_benchmark_source_stages_file_and_marks_review_task(tmp_path: Path) -> None:
    project = Project("benchmark source upload", output_dir=tmp_path)
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
                        "trial_id": "codex",
                        "trial_name": "CoDEX",
                        "registration_id": "NCT04327401",
                        "publication_pmids": ["32876695"],
                        "publication_dois": ["10.1001/jama.2020.17021"],
                    }
                ],
            },
        },
        subdir="benchmark",
    )
    upload = tmp_path / "codex-supplement.pdf"
    upload.write_bytes(b"%PDF supplement")

    result = attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id="full_text:codex",
        trial_id="codex",
        trial_name="CoDEX",
        source_kind="supplement",
        user_id="u1",
    )

    manifest = project.load_json("benchmark_source_manifest.json", subdir="benchmark")
    payload = build_benchmark_review_payload(project)
    task = payload["source_acquisition_tasks"][0]

    assert result["ok"] is True
    assert result["attached"] == 1
    assert result["manifest_path"].endswith("benchmark_source_manifest.json")
    assert manifest["sources"][0]["task_id"] == "full_text:codex"
    assert manifest["sources"][0]["trial_id"] == "codex"
    assert manifest["sources"][0]["source_kind"] == "supplement"
    assert manifest["sources"][0]["uploaded_by"] == "u1"
    assert Path(manifest["sources"][0]["local_path"]).parent == project.base_dir / "benchmark" / "sources" / "codex"
    assert task["status"] == "source_uploaded_needs_review"
    assert task["uploaded_sources"][0]["filename"] == "codex-supplement.pdf"
    assert payload["summary"]["source_acquisition_tasks"] == 1
    assert payload["summary"]["attached_source_tasks"] == 1


def test_attach_benchmark_source_records_parse_preview(tmp_path: Path) -> None:
    project = Project("benchmark source preview", output_dir=tmp_path)
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
        },
        subdir="benchmark",
    )
    upload = tmp_path / "steroids-sari-registry.pdf"
    upload.write_bytes(b"%PDF registry")

    result = attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id="primary_source:steroids_sari",
        trial_id="steroids_sari",
        trial_name="Steroids-SARI",
        source_kind="registry_results",
        parse_func=lambda _: {
            "full_text": "[PAGE 1]\nMortality 13/24 and 13/23 in trial registry results.",
            "tables": ["| arm | deaths | total |\n| steroid | 13 | 24 |"],
            "page_map": [{"page_number": 1, "start_char": 0, "end_char": 60}],
        },
    )

    source = result["sources"][0]
    payload = build_benchmark_review_payload(project)
    task_source = payload["source_acquisition_tasks"][0]["uploaded_sources"][0]
    expected_preview = "[PAGE 1]\nMortality 13/24 and 13/23 in trial registry results."

    assert source["parse_status"] == "ok"
    assert source["parsed_path"].endswith(".json")
    assert (project.base_dir / source["parsed_path"]).exists()
    parsed = json.loads((project.base_dir / source["parsed_path"]).read_text(encoding="utf-8"))
    assert parsed["full_text"] == expected_preview
    assert source["text_chars"] == len(expected_preview)
    assert source["page_count"] == 1
    assert source["table_count"] == 1
    assert source["text_preview"] == expected_preview
    assert task_source["parse_status"] == "ok"
    assert task_source["parsed_path"] == source["parsed_path"]
    assert task_source["text_chars"] == len(expected_preview)
    assert task_source["table_count"] == 1
    assert task_source["text_preview"].startswith("[PAGE 1]\nMortality")


def test_benchmark_review_suggests_count_quote_candidates_from_parsed_source(tmp_path: Path) -> None:
    project = Project("benchmark source quote candidates", output_dir=tmp_path)
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

    payload = build_benchmark_review_payload(project)
    task = payload["source_acquisition_tasks"][0]
    candidate = task["uploaded_sources"][0]["quote_candidates"][0]

    assert candidate["candidate_type"] == "primary_counts"
    assert candidate["matched_values"] == ["13", "24", "23"]
    assert "13 deaths among 24 participants" in candidate["quote"]
    assert candidate["source_location"] == "uploaded benchmark source"
    assert candidate["suggested_override"]["type"] == "extraction_override"
    assert set(candidate["suggested_override"]["values"]) == {
        "events_intervention",
        "total_intervention",
        "events_control",
        "total_control",
        "source_quote",
        "source_location",
    }


def test_benchmark_review_does_not_match_counts_scattered_across_long_source(tmp_path: Path) -> None:
    project = Project("benchmark source scattered counts", output_dir=tmp_path)
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "covid_benchmark",
            "summary_card": {
                "benchmark_id": "covid_benchmark",
                "status": "blocked",
                "passed": False,
                "missing_primary_full_texts": [
                    {"trial_id": "covid_steroid", "trial_name": "COVID STEROID"},
                ],
            },
            "primary_analysis": {
                "missing": [
                    {
                        "trial_id": "covid_steroid",
                        "trial_name": "COVID STEROID",
                        "expected_events_intervention": 6,
                        "expected_total_intervention": 15,
                        "expected_events_control": 2,
                        "expected_total_control": 14,
                    }
                ]
            },
        },
        subdir="benchmark",
    )
    upload = tmp_path / "eudract-like.html"
    upload.write_text(
        "EudraCT 2020-001395-15 registration header. " + ("filler " * 200) +
        "All-cause mortality at day 28. Hydrocortisone analysed 16 subjects with 6 deaths; "
        "placebo analysed 14 subjects with 2 deaths.",
        encoding="utf-8",
    )
    attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id="primary_source:covid_steroid",
        trial_id="covid_steroid",
        trial_name="COVID STEROID",
        source_kind="registry_results",
    )

    payload = build_benchmark_review_payload(project)
    source = payload["source_acquisition_tasks"][0]["uploaded_sources"][0]
    assert source.get("quote_candidates") in (None, [])


def test_benchmark_review_count_quote_stays_on_the_matching_trial_sentence(tmp_path: Path) -> None:
    project = Project("benchmark source tight quote", output_dir=tmp_path)
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
    upload = tmp_path / "figure2.txt"
    upload.write_text(
        "COVID STEROID: deaths/total were 6/15 in the steroid arm and 2/14 in the no-steroid arm. "
        "REMAP-CAP: deaths/total were 26/105 in the steroid arm and 29/92 in the no-steroid arm. "
        "Steroids-SARI: deaths/total were 13/24 in the steroid arm and 13/23 in the no-steroid arm. "
        "Dexamethasone subgroup fixed effect: 166/459 deaths/total in steroid arms and 361/823 in no-steroid arms.",
        encoding="utf-8",
    )
    attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id="primary_source:steroids_sari",
        trial_id="steroids_sari",
        trial_name="Steroids-SARI",
        source_kind="benchmark_appendix",
    )

    payload = build_benchmark_review_payload(project)
    candidate = payload["source_acquisition_tasks"][0]["uploaded_sources"][0]["quote_candidates"][0]

    assert "Steroids-SARI" in candidate["quote"]
    assert "13/24" in candidate["quote"]
    assert "13/23" in candidate["quote"]
    assert "subgroup fixed effect" not in candidate["quote"]


def test_attach_benchmark_source_records_parse_failure_without_dropping_file(tmp_path: Path) -> None:
    project = Project("benchmark source parse failure", output_dir=tmp_path)
    upload = tmp_path / "broken.pdf"
    upload.write_bytes(b"%PDF broken")

    result = attach_benchmark_sources_to_project(
        project,
        [str(upload)],
        task_id="primary_source:broken",
        trial_id="broken",
        parse_func=lambda _: (_ for _ in ()).throw(RuntimeError("scan failed")),
    )
    source = result["sources"][0]

    assert result["attached"] == 1
    assert source["status"] == "uploaded_needs_review"
    assert source["parse_status"] == "failed"
    assert source["parse_error"] == "scan failed"
    assert "parsed_path" not in source
