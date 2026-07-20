from pathlib import Path

from new_meta.core.benchmark_review import build_benchmark_review_payload
from new_meta.core.project import Project


def test_benchmark_review_builds_source_acquisition_tasks(tmp_path: Path) -> None:
    project = Project("benchmark review tasks", output_dir=tmp_path)
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "covid_benchmark",
            "project_dir": str(project.base_dir),
            "summary_card": {
                "benchmark_id": "covid_benchmark",
                "status": "blocked",
                "passed": False,
                "failing_gates": [
                    {
                        "gate": "primary_publication_recall",
                        "label": "Primary publication recall",
                        "passed": False,
                    },
                    {
                        "gate": "primary_full_text_recall",
                        "label": "Primary full-text recall",
                        "passed": False,
                    },
                    {
                        "gate": "primary_analysis",
                        "label": "Primary analysis rows",
                        "passed": False,
                    },
                ],
                "missing_primary_full_texts": [
                    {
                        "trial_id": "codex",
                        "trial_name": "CoDEX",
                        "registration_id": "NCT04327401",
                        "aliases": ["Effect of Dexamethasone on Days Alive and Ventilator-Free"],
                        "publication_pmids": ["32876695"],
                        "publication_dois": ["10.1001/jama.2020.17021"],
                    },
                    {
                        "trial_id": "covid_steroid",
                        "trial_name": "COVID STEROID",
                        "registration_id": "NCT04348305",
                        "aliases": ["Hydrocortisone for COVID-19 and Severe Hypoxia"],
                        "publication_pmids": [],
                        "publication_dois": [],
                    },
                ],
                "next_actions": [{"type": "upload_full_texts", "message": "Upload source files."}],
            },
            "primary_analysis": {
                "matched": {
                    "recovery": {
                        "row_id": "10.1101/2020.06.22.20137273:3",
                        "study_id": "10.1101/2020.06.22.20137273",
                        "trial_name": "RECOVERY",
                        "title": "Effect of Dexamethasone in Hospitalized Patients with COVID-19",
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
                },
                "missing": [
                    {
                        "trial_id": "codex",
                        "trial_name": "CoDEX",
                        "registration_id": "NCT04327401",
                        "expected_events_intervention": 69,
                        "expected_total_intervention": 128,
                        "expected_events_control": 76,
                        "expected_total_control": 128,
                    },
                    {
                        "trial_id": "steroids_sari",
                        "trial_name": "Steroids-SARI",
                        "registration_id": "NCT04244591",
                        "expected_events_intervention": 13,
                        "expected_total_intervention": 24,
                        "expected_events_control": 13,
                        "expected_total_control": 23,
                    },
                ],
                "timepoint_mismatches": [
                    {
                        "trial_id": "cape_covid",
                        "trial_name": "CAPE COVID",
                        "row_id": "32876689:0",
                        "reason": "primary_timepoint_not_matched",
                        "expected_primary_timepoint": "28-day all-cause mortality",
                        "accepted_timepoints": ["21-day treatment failure"],
                    }
                ],
            },
        },
        subdir="benchmark",
    )

    payload = build_benchmark_review_payload(project)

    assert payload is not None
    tasks = payload["source_acquisition_tasks"]
    by_id = {task["task_id"]: task for task in tasks}
    assert payload["summary"]["source_acquisition_tasks"] == 5

    codex = by_id["full_text:codex"]
    assert codex["task_type"] == "full_text_upload"
    assert codex["priority"] == "high"
    assert codex["trial_id"] == "codex"
    assert codex["accepted_file_hints"] == [
        "32876695",
        "10.1001/jama.2020.17021",
        "NCT04327401",
        "CoDEX",
        "Effect of Dexamethasone on Days Alive and Ventilator-Free",
    ]
    assert codex["suggested_upload"]["type"] == "fulltext_upload"
    assert codex["suggested_upload"]["trial_id"] == "codex"

    covid_steroid = by_id["primary_source:covid_steroid"]
    assert covid_steroid["task_type"] == "primary_source_request"
    assert covid_steroid["status"] == "missing_primary_publication_or_results"
    assert covid_steroid["accepted_file_hints"] == [
        "NCT04348305",
        "COVID STEROID",
        "Hydrocortisone for COVID-19 and Severe Hypoxia",
    ]

    steroids_sari = by_id["primary_counts:steroids_sari"]
    assert steroids_sari["task_type"] == "primary_count_source"
    assert steroids_sari["expected_counts"] == {
        "events_intervention": 13,
        "total_intervention": 24,
        "events_control": 13,
        "total_control": 23,
    }

    recovery = by_id["primary_count_discrepancy:recovery"]
    assert recovery["task_type"] == "primary_count_discrepancy"
    assert recovery["row_id"] == "10.1101/2020.06.22.20137273:3"
    assert recovery["observed_counts"]["events_intervention"] == 94
    assert recovery["expected_counts"] == {
        "events_intervention": 95,
        "total_intervention": 324,
        "events_control": 283,
        "total_control": 683,
    }
    assert recovery["suggested_override"]["fields"] == [
        "events_intervention",
        "total_intervention",
        "events_control",
        "total_control",
    ]

    cape = by_id["timepoint:32876689:0"]
    assert cape["task_type"] == "timepoint_adjudication_source"
    assert cape["row_id"] == "32876689:0"
    assert cape["expected_primary_timepoint"] == "28-day all-cause mortality"
    assert cape["accepted_timepoints"] == ["21-day treatment failure"]


def test_benchmark_review_builds_protocol_adjudication_task_for_effect_model_mismatch(tmp_path: Path) -> None:
    project = Project("benchmark protocol adjudication", output_dir=tmp_path)
    project.save_json(
        "benchmark_report.json",
        {
            "benchmark_id": "covid_benchmark",
            "project_dir": str(project.base_dir),
            "summary_card": {
                "benchmark_id": "covid_benchmark",
                "status": "failed",
                "passed": False,
                "published_anchor": {
                    "effect_measure": "OR",
                    "model_preference": "fixed",
                    "effect": 0.66,
                    "ci_lower": 0.53,
                    "ci_upper": 0.82,
                },
                "observed_primary": {
                    "effect_measure": "RR",
                    "model_preference": "random",
                    "effect": 0.73,
                    "ci_lower": 0.62,
                    "ci_upper": 0.86,
                },
                "failing_gates": [
                    {
                        "gate": "pooled_effect",
                        "label": "Published pooled effect",
                        "passed": False,
                        "expected": {
                            "effect_measure": "OR",
                            "model_preference": "fixed",
                            "effect": 0.66,
                            "ci_lower": 0.53,
                            "ci_upper": 0.82,
                        },
                        "observed": {
                            "effect_measure": "RR",
                            "model_preference": "random",
                            "effect": 0.73,
                            "ci_lower": 0.62,
                            "ci_upper": 0.86,
                        },
                        "failure_reasons": [
                            "effect_measure_mismatch",
                            "model_preference_mismatch",
                            "pooled_effect_mismatch",
                        ],
                    }
                ],
                "next_actions": [
                    {
                        "type": "review_effect_model",
                        "message": "Check effect measure, selected studies, and pooling inputs against the published anchor.",
                    }
                ],
            },
            "pooled_effect": {
                "expected_effect_measure": "OR",
                "observed_effect_measure": "RR",
                "expected_model_preference": "fixed",
                "observed_model_preference": "random",
                "expected_effect": 0.66,
                "observed_effect": 0.73,
                "expected_ci_lower": 0.53,
                "observed_ci_lower": 0.62,
                "expected_ci_upper": 0.82,
                "observed_ci_upper": 0.86,
                "failure_reasons": [
                    "effect_measure_mismatch",
                    "model_preference_mismatch",
                    "pooled_effect_mismatch",
                ],
            },
        },
        subdir="benchmark",
    )

    payload = build_benchmark_review_payload(project)

    assert payload is not None
    assert payload["summary"]["protocol_adjudication_tasks"] == 1
    task = payload["protocol_adjudication_tasks"][0]
    assert task["task_type"] == "protocol_effect_model_adjudication"
    assert task["status"] == "needs_protocol_decision"
    assert task["failure_reasons"] == [
        "effect_measure_mismatch",
        "model_preference_mismatch",
        "pooled_effect_mismatch",
    ]
    assert task["published_anchor"]["effect_measure"] == "OR"
    assert task["published_anchor"]["model_preference"] == "fixed"
    assert task["observed_primary"]["effect_measure"] == "RR"
    assert task["observed_primary"]["model_preference"] == "random"
    assert task["suggested_protocol_patch"] == {
        "type": "protocol_override",
        "project_dir": str(project.base_dir),
        "fields": {
            "effect_measure": "OR",
            "model_preference": "fixed",
        },
        "reason": "Align protocol effect measure/model with the published benchmark anchor before rerunning downstream analysis.",
    }
