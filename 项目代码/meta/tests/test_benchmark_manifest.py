import json
from pathlib import Path

import pytest

from new_meta.core.benchmark_manifest import (
    BenchmarkManifest,
    BenchmarkProjectReport,
    BenchmarkTrial,
    augment_records_with_manifest_registry,
    benchmark_anchor_summary,
    build_benchmark_summary_card,
    compare_pooled_effect,
    compare_primary_analysis,
    evaluate_project_against_benchmark,
    evaluate_benchmark_recall,
    main as benchmark_manifest_main,
    record_matches_primary_publication,
    record_matches_trial,
    write_project_benchmark_report,
)


MANIFEST_PATH = Path("docs/benchmarks/corticosteroids_covid_2020.manifest.json")
SGLT2_MANIFEST_PATH = Path("docs/benchmarks/sglt2_hfpef_2022.manifest.json")
CURRENT_RUN_SEARCH = Path(
    "output/benchmark_runs/"
    "20260521_005903_Systemic_corticosteroids_compared_with_usual_care/"
    "search_results.json"
)
CURRENT_RUN_PROJECT = Path(
    "output/benchmark_runs/"
    "20260521_005903_Systemic_corticosteroids_compared_with_usual_care"
)


def test_corticosteroids_manifest_encodes_published_anchor_result() -> None:
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    primary = manifest.expected_primary_result

    assert manifest.reference["doi"] == "10.1001/jama.2020.17023"
    assert len(manifest.expected_trials) == 7
    assert primary["n_trials"] == 7
    assert primary["n_participants"] == 1703
    assert primary["aggregate_events_intervention"] == 222
    assert primary["aggregate_total_intervention"] == 678
    assert primary["aggregate_events_control"] == 425
    assert primary["aggregate_total_control"] == 1025
    assert primary["fixed_effect"]["effect"] == 0.66
    assert sum(trial.expected_events_intervention or 0 for trial in manifest.expected_trials) == 222
    assert sum(trial.expected_total_intervention or 0 for trial in manifest.expected_trials) == 678
    assert sum(trial.expected_events_control or 0 for trial in manifest.expected_trials) == 425
    assert sum(trial.expected_total_control or 0 for trial in manifest.expected_trials) == 1025
    cape = next(trial for trial in manifest.expected_trials if trial.trial_id == "cape_covid")
    assert cape.expected_primary_timepoint == "28-day all-cause mortality"
    assert "21-day mortality or respiratory support" in cape.accepted_timepoints
    assert cape.requires_timepoint_adjudication is True


def test_project_benchmark_full_text_recall_counts_related_source_records(tmp_path: Path) -> None:
    project = tmp_path / "project"
    screening_dir = project / "screening"
    screening_dir.mkdir(parents=True)
    (project / "search_results.json").write_text("[]", encoding="utf-8")
    (screening_dir / "full_text_screening.json").write_text(
        json.dumps([
            {
                "decision": "exclude",
                "evidence_role": "design_or_protocol",
                "analysis_route": "related_source_only",
                "paper": {
                    "pmid": "32799933",
                    "doi": "10.1186/s13063-020-04643-1",
                    "title": (
                        "Efficacy of dexamethasone treatment for patients with the acute respiratory "
                        "distress syndrome caused by COVID-19: study protocol for a randomized "
                        "controlled superiority trial."
                    ),
                    "text_availability": "full_text",
                    "fulltext_source": "pdf",
                },
            }
        ]),
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(BenchmarkManifest.load(MANIFEST_PATH), project)

    assert report.primary_full_text_recall is not None
    assert "dexa_covid_19" in report.primary_full_text_recall.matches


def test_sglt2_hfpef_manifest_encodes_published_anchor_result() -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)
    primary = manifest.expected_primary_result

    assert manifest.reference["doi"] == "10.1016/S0140-6736(22)01429-5"
    assert manifest.reference["pmid"] == "36041474"
    assert len(manifest.expected_trials) == 2
    assert primary["n_trials"] == 2
    assert primary["n_participants"] == 12251
    assert primary["effect_measure"] == "HR"
    assert primary["fixed_effect"]["effect"] == 0.80
    assert primary["fixed_effect"]["ci_lower"] == 0.73
    assert primary["fixed_effect"]["ci_upper"] == 0.87
    assert sum(trial.expected_events_intervention or 0 for trial in manifest.expected_trials) == 927
    assert sum(trial.expected_total_intervention or 0 for trial in manifest.expected_trials) == 6128
    assert sum(trial.expected_events_control or 0 for trial in manifest.expected_trials) == 1121
    assert sum(trial.expected_total_control or 0 for trial in manifest.expected_trials) == 6123
    anchor = benchmark_anchor_summary(manifest)
    assert anchor.n_trials == 2
    assert anchor.n_participants == 12251
    assert anchor.effect_measure == "HR"
    assert anchor.effect == 0.80
    assert anchor.ci_lower == 0.73
    assert anchor.ci_upper == 0.87
    assert anchor.expected_trial_ids == ["deliver", "emperor_preserved"]
    assert {trial.timepoint_kind for trial in manifest.expected_trials} == {"time_to_event"}


def test_project_benchmark_report_includes_published_anchor_summary(tmp_path: Path) -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.anchor_summary is not None
    assert report.anchor_summary.effect_measure == "HR"
    assert report.anchor_summary.aggregate_events_intervention == 927
    assert report.anchor_summary.aggregate_total_control == 6123


def test_project_benchmark_compares_pooled_effect_to_published_anchor(tmp_path: Path) -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)
    analysis_dir = tmp_path / "analysis"
    analysis_dir.mkdir()
    (analysis_dir / "meta_results.json").write_text(
        json.dumps({
            "primary_outcome": {
                "outcome_name": "cardiovascular death or first hospitalization for heart failure",
                "n_studies": 2,
                "effect_measure": "HR",
                "pooled_effect": 0.80,
                "ci_lower": 0.73,
                "ci_upper": 0.87,
                "p_value": 0.001,
            }
        }),
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.pooled_effect is not None
    assert report.pooled_effect.passed is True
    assert report.pooled_effect.effect_measure_passed is True
    assert report.pooled_effect.n_studies_passed is True
    assert report.pooled_effect.effect_difference == 0
    assert report.pooled_effect.ci_lower_difference == 0
    assert report.pooled_effect.ci_upper_difference == 0
    assert report.summary_card is not None
    assert report.summary_card["observed_primary"]["effect"] == 0.80


def test_benchmark_summary_card_explains_missing_primary_full_texts(tmp_path: Path) -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)
    records = [
        {
            "pmid": "36027570",
            "doi": "10.1056/NEJMoa2206286",
            "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
            "text_availability": "abstract_only",
            "fulltext_source": "europe_pmc_abstract",
        },
        {
            "pmid": "34449189",
            "doi": "10.1056/NEJMoa2107038",
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "text_availability": "abstract_only",
            "fulltext_source": "europe_pmc_abstract",
        },
    ]
    screening_dir = tmp_path / "screening"
    screening_dir.mkdir()
    (tmp_path / "search_results.json").write_text(json.dumps(records), encoding="utf-8")
    (screening_dir / "full_text_screening.json").write_text(
        json.dumps([{"decision": "include", "paper": record} for record in records]),
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)
    summary = build_benchmark_summary_card(report)

    assert report.summary_card == summary
    assert summary["status"] == "blocked"
    assert summary["passed"] is False
    assert summary["published_anchor"]["effect_measure"] == "HR"
    assert summary["missing_primary_full_texts"][0]["publication_pmids"]
    assert {item["trial_id"] for item in summary["missing_primary_full_texts"]} == {
        "deliver",
        "emperor_preserved",
    }
    assert summary["failing_gates"][0]["gate"] == "primary_full_text_recall"
    assert summary["next_actions"][0]["type"] == "upload_full_texts"


def test_pooled_effect_comparison_flags_effect_measure_mismatch() -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)

    result = compare_pooled_effect(
        manifest,
        {
            "primary_outcome": {
                "n_studies": 2,
                "effect_measure": "RR",
                "pooled_effect": 0.80,
                "ci_lower": 0.73,
                "ci_upper": 0.87,
            }
        },
    )

    assert result.passed is False
    assert result.effect_measure_passed is False
    assert "effect_measure_mismatch" in result.failure_reasons


def test_pooled_effect_comparison_flags_model_preference_mismatch_when_observed_model_present() -> None:
    manifest = BenchmarkManifest.load(MANIFEST_PATH)

    result = compare_pooled_effect(
        manifest,
        {
            "primary_outcome": {
                "n_studies": 7,
                "effect_measure": "OR",
                "model": "random",
                "pooled_effect": 0.66,
                "ci_lower": 0.53,
                "ci_upper": 0.82,
            }
        },
    )

    assert result.passed is False
    assert result.expected_model_preference == "fixed"
    assert result.observed_model_preference == "random"
    assert result.model_preference_passed is False
    assert "model_preference_mismatch" in result.failure_reasons


def test_pooled_effect_comparison_accepts_random_label_when_tau_zero_matches_fixed_anchor() -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)

    result = compare_pooled_effect(
        manifest,
        {
            "primary_outcome": {
                "n_studies": 2,
                "effect_measure": "HR",
                "model": "random",
                "tau_squared": 0.0,
                "pooled_effect": 0.8069,
                "ci_lower": 0.7395,
                "ci_upper": 0.8805,
            }
        },
    )

    assert result.passed is True
    assert result.expected_model_preference == "fixed"
    assert result.observed_model_preference == "random"
    assert result.model_preference_passed is True
    assert "model_preference_mismatch" not in result.failure_reasons
    assert result.compatibility_notes == ["random_model_equivalent_to_fixed_tau_zero"]


def test_pooled_effect_comparison_flags_ci_and_study_count_mismatches() -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)

    result = compare_pooled_effect(
        manifest,
        {
            "primary_outcome": {
                "n_studies": 1,
                "effect_measure": "HR",
                "pooled_effect": 0.92,
                "ci_lower": 0.81,
                "ci_upper": 1.05,
            }
        },
    )

    assert result.passed is False
    assert result.n_studies_passed is False
    assert result.effect_passed is False
    assert result.ci_passed is False
    assert result.effect_difference == pytest.approx(0.12)
    assert "n_studies_mismatch" in result.failure_reasons
    assert "pooled_effect_mismatch" in result.failure_reasons
    assert "pooled_ci_mismatch" in result.failure_reasons


def test_sglt2_hfpef_recall_matches_trials_and_excludes_adjacent_hfref_records() -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)
    records = [
        {"pmid": "36027570", "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction"},
        {"doi": "10.1056/NEJMoa2107038", "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction"},
        {"pmid": "31535829", "title": "Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction"},
        {"pmid": "32865377", "title": "Cardiovascular and Renal Outcomes with Empagliflozin in Heart Failure"},
    ]

    result = evaluate_benchmark_recall(manifest, records)

    assert result.passed is True
    assert result.matched == 2
    assert set(result.matches) == {"deliver", "emperor_preserved"}
    trials = {trial.trial_id: trial for trial in manifest.expected_trials}
    assert not record_matches_trial(records[2], trials["deliver"])
    assert not record_matches_trial(records[3], trials["emperor_preserved"])


def test_sglt2_primary_publication_recall_requires_expected_pmid_or_doi() -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)
    records = [
        {
            "pmid": "37220093",
            "doi": "10.1093/eurheartj/ehad283",
            "title": "Dapagliflozin and diuretic utilization in heart failure with mildly reduced or preserved ejection fraction: the DELIVER trial",
        },
        {
            "pmid": "34449189",
            "doi": "10.1056/NEJMoa2107038",
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
        },
    ]
    trials = {trial.trial_id: trial for trial in manifest.expected_trials}

    search_result = evaluate_benchmark_recall(manifest, records)
    primary_result = evaluate_benchmark_recall(manifest, records, scope="primary_publication")

    assert search_result.matched == 2
    assert primary_result.passed is False
    assert primary_result.matched == 1
    assert {item["trial_id"] for item in primary_result.missing} == {"deliver"}
    assert not record_matches_primary_publication(records[0], trials["deliver"])
    assert record_matches_primary_publication(records[1], trials["emperor_preserved"])


def test_benchmark_recall_matches_by_pmid_doi_registration_and_alias() -> None:
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    trials = {trial.trial_id: trial for trial in manifest.expected_trials}

    assert record_matches_trial({"pmid": "32876695", "title": "unhelpful"}, trials["codex"])
    assert record_matches_trial({"doi": "10.1101/2020.06.22.20137273"}, trials["recovery"])
    assert record_matches_trial(
        {"title": "Protocol for hydrocortisone for COVID-19 and severe hypoxia"},
        trials["covid_steroid"],
    )
    assert record_matches_trial({"trial_registration": "NCT04244591"}, trials["steroids_sari"])
    assert not record_matches_trial(
        {"title": "COVID-19 ARDS commentary", "abstract": "ongoing trials include NCT04244591"},
        trials["steroids_sari"],
    )
    metcovid = {
        "pmid": "32785710",
        "doi": "10.1093/cid/ciaa1177",
        "title": "Methylprednisolone as Adjunctive Therapy for Patients Hospitalized With COVID-19; Metcovid",
    }
    assert not any(record_matches_trial(metcovid, trial) for trial in manifest.expected_trials)


def test_benchmark_recall_fails_below_configured_threshold() -> None:
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    records = [
        {"pmid": "32876695", "title": "CoDEX"},
        {"pmid": "32876697", "title": "REMAP-CAP"},
        {"doi": "10.1001/jama.2020.16761", "title": "CAPE COVID"},
        {"doi": "10.1101/2020.06.22.20137273", "title": "RECOVERY"},
    ]

    result = evaluate_benchmark_recall(manifest, records)

    assert result.total_required == 7
    assert result.matched == 4
    assert result.passed is False
    assert {item["trial_id"] for item in result.missing} == {
        "dexa_covid_19",
        "covid_steroid",
        "steroids_sari",
    }


def test_current_corticosteroids_benchmark_search_recall_if_available() -> None:
    if not CURRENT_RUN_SEARCH.exists():
        pytest.skip("local benchmark run artifact is not present")
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    records = json.loads(CURRENT_RUN_SEARCH.read_text(encoding="utf-8"))

    result = evaluate_benchmark_recall(manifest, records)

    assert result.passed is True
    assert result.matched >= 5
    assert "codex" in result.matches
    assert "recovery" in result.matches


def test_current_corticosteroids_project_benchmark_passes_with_user_supplied_sources_if_available() -> None:
    if not CURRENT_RUN_PROJECT.exists():
        pytest.skip("local benchmark run artifact is not present")
    manifest = BenchmarkManifest.load(MANIFEST_PATH)

    report = evaluate_project_against_benchmark(manifest, CURRENT_RUN_PROJECT)

    assert report.search_recall is not None
    assert report.search_recall.matched == 5
    assert report.primary_publication_recall is not None
    assert report.primary_publication_recall.matched == 7
    assert report.full_text_recall is not None
    assert report.full_text_recall.matched == 7
    assert report.primary_full_text_recall is not None
    assert report.primary_full_text_recall.matched == 7
    assert report.primary_analysis is not None
    assert report.primary_analysis.passed is True
    assert report.primary_analysis.matched_trials == 7
    assert report.primary_analysis.differences == {
        "events_intervention": 0,
        "total_intervention": 0,
        "events_control": 0,
        "total_control": 0,
    }
    assert report.primary_analysis.observed_total_participants == 1703
    assert report.primary_analysis.expected_total_participants == 1703
    assert report.primary_analysis.participant_difference == 0
    assert report.primary_analysis.patient_totals_passed is True
    assert report.primary_analysis.failure_reasons == []
    assert report.primary_analysis.missing == []
    assert report.pooled_effect is not None
    assert report.pooled_effect.passed is True
    assert report.summary_card["status"] == "passed"
    assert report.summary_card["failing_gates"] == []


def test_primary_comparison_passes_only_when_trial_events_and_patient_totals_match() -> None:
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    selected_rows = [
        {
            "study_id": trial.publication_pmids[0] if trial.publication_pmids else trial.registration_id,
            "study_label": trial.trial_name,
            "outcome_name": (
                "21-day mortality or respiratory support"
                if trial.trial_id == "cape_covid"
                else "28-day all-cause mortality"
            ),
            "source_quote": (
                "The CAPE COVID endpoint was 21-day mortality or respiratory support."
                if trial.trial_id == "cape_covid"
                else "28-day all-cause mortality was reported."
            ),
            "timepoint_adjudication_note": (
                "Accepted closest CAPE COVID endpoint per benchmark manifest."
                if trial.trial_id == "cape_covid"
                else ""
            ),
            "events_intervention": trial.expected_events_intervention,
            "total_intervention": trial.expected_total_intervention,
            "events_control": trial.expected_events_control,
            "total_control": trial.expected_total_control,
        }
        for trial in manifest.expected_trials
    ]
    extraction_records = {
        trial.publication_pmids[0] if trial.publication_pmids else trial.registration_id: {
            "pmid": trial.publication_pmids[0] if trial.publication_pmids else "",
            "doi": trial.publication_dois[0] if trial.publication_dois else "",
            "title": trial.trial_name,
            "trial_registration": trial.registration_id,
        }
        for trial in manifest.expected_trials
    }

    from new_meta.core.benchmark_manifest import compare_primary_analysis

    result = compare_primary_analysis(manifest, selected_rows, extraction_records)

    assert result.passed is True
    assert result.matched_trials == 7
    assert result.observed_total_participants == 1703
    assert result.expected_total_participants == 1703
    assert result.participant_difference == 0
    assert result.trial_recall_passed is True
    assert result.unexpected_rows_passed is True
    assert result.event_totals_passed is True
    assert result.patient_totals_passed is True
    assert result.failure_reasons == []


def test_primary_comparison_requires_adjudication_for_accepted_alternate_timepoint() -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini timepoint benchmark",
        topic="28-day all-cause mortality",
        expected_trials=[
            BenchmarkTrial(
                trial_id="cape",
                trial_name="CAPE COVID",
                publication_pmids=["32876689"],
                expected_events_intervention=11,
                expected_total_intervention=75,
                expected_events_control=20,
                expected_total_control=73,
                expected_primary_timepoint="28-day all-cause mortality",
                accepted_timepoints=["21-day mortality or respiratory support"],
                requires_timepoint_adjudication=True,
                timepoint_notes="Use of the 21-day endpoint needs explicit protocol/user adjudication.",
            )
        ],
    )
    selected_rows = [
        {
            "study_id": "32876689",
            "study_label": "Dequin 2020",
            "outcome_name": "21-day mortality or respiratory support",
            "source_quote": "The primary outcome was 21-day mortality or respiratory support.",
            "events_intervention": 11,
            "total_intervention": 75,
            "events_control": 20,
            "total_control": 73,
        }
    ]

    result = compare_primary_analysis(
        manifest,
        selected_rows,
        {"32876689": {"pmid": "32876689", "title": "CAPE COVID"}},
    )

    assert result.trial_recall_passed is True
    assert result.event_totals_passed is True
    assert result.patient_totals_passed is True
    assert result.timepoint_adjudication_passed is False
    assert result.timepoint_mismatches[0]["reason"] == "missing_timepoint_adjudication"
    assert "timepoint_adjudication_mismatch" in result.failure_reasons


def test_primary_comparison_does_not_trust_outcome_label_as_timepoint_source() -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini timepoint benchmark",
        topic="28-day all-cause mortality",
        expected_trials=[
            BenchmarkTrial(
                trial_id="cape",
                trial_name="CAPE COVID",
                publication_pmids=["32876689"],
                expected_events_intervention=11,
                expected_total_intervention=75,
                expected_events_control=20,
                expected_total_control=73,
                expected_primary_timepoint="28-day all-cause mortality",
            )
        ],
    )
    selected_rows = [
        {
            "study_id": "32876689",
            "study_label": "Dequin 2020",
            "outcome_name": "28-day all-cause mortality",
            "source_quote": "There were 69 treatment failure events, including 11 deaths and 20 deaths.",
            "events_intervention": 11,
            "total_intervention": 75,
            "events_control": 20,
            "total_control": 73,
        }
    ]

    result = compare_primary_analysis(
        manifest,
        selected_rows,
        {"32876689": {"pmid": "32876689", "title": "CAPE COVID"}},
    )

    assert result.timepoint_adjudication_passed is False
    assert result.timepoint_mismatches[0]["reason"] == "primary_timepoint_not_matched"


def test_primary_comparison_accepts_alternate_timepoint_with_adjudication_note() -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini timepoint benchmark",
        topic="28-day all-cause mortality",
        expected_trials=[
            BenchmarkTrial(
                trial_id="cape",
                trial_name="CAPE COVID",
                publication_pmids=["32876689"],
                expected_events_intervention=11,
                expected_total_intervention=75,
                expected_events_control=20,
                expected_total_control=73,
                expected_primary_timepoint="28-day all-cause mortality",
                accepted_timepoints=["21-day mortality or respiratory support"],
                requires_timepoint_adjudication=True,
            )
        ],
    )
    selected_rows = [
        {
            "study_id": "32876689",
            "study_label": "Dequin 2020",
            "outcome_name": "21-day mortality or respiratory support",
            "source_quote": "The primary outcome was 21-day mortality or respiratory support.",
            "timepoint_adjudication_note": (
                "Accepted closest CAPE COVID endpoint per protocol-level benchmark manifest."
            ),
            "events_intervention": 11,
            "total_intervention": 75,
            "events_control": 20,
            "total_control": 73,
        }
    ]

    result = compare_primary_analysis(
        manifest,
        selected_rows,
        {"32876689": {"pmid": "32876689", "title": "CAPE COVID"}},
    )

    assert result.passed is True
    assert result.timepoint_adjudication_passed is True
    assert result.timepoint_mismatches == []


def test_primary_comparison_accepts_source_verified_time_to_event_primary_quote() -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini time-to-event benchmark",
        topic="time to cardiovascular death or hospitalization for heart failure",
        expected_trials=[
            BenchmarkTrial(
                trial_id="emperor",
                trial_name="EMPEROR-Preserved",
                publication_pmids=["34449189"],
                expected_events_intervention=415,
                expected_total_intervention=2997,
                expected_events_control=511,
                expected_total_control=2991,
                expected_primary_timepoint="time to cardiovascular death or hospitalization for heart failure",
                timepoint_kind="time_to_event",
            )
        ],
    )
    selected_rows = [
        {
            "study_id": "34449189",
            "study_label": "EMPEROR-Preserved",
            "outcome_name": "Composite of cardiovascular death or first hospitalization for heart failure",
            "source_quote": (
                "A primary outcome event occurred in 415 of 2997 patients in the empagliflozin "
                "group and in 511 of 2991 patients in the placebo group (hazard ratio, 0.79; "
                "95% confidence interval [CI], 0.69 to 0.90)."
            ),
            "source_quote_verified": True,
            "events_intervention": 415,
            "total_intervention": 2997,
            "events_control": 511,
            "total_control": 2991,
            "effect": 0.79,
        }
    ]

    result = compare_primary_analysis(
        manifest,
        selected_rows,
        {"34449189": {"pmid": "34449189", "title": "EMPEROR-Preserved"}},
    )

    assert result.passed is True
    assert result.timepoint_adjudication_passed is True
    assert result.timepoint_mismatches == []


def test_primary_comparison_flags_patient_total_mismatch_even_when_events_match() -> None:
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    trial = manifest.expected_trials[0]
    selected_rows = [
        {
            "study_id": trial.publication_pmids[0],
            "study_label": trial.trial_name,
            "events_intervention": trial.expected_events_intervention,
            "total_intervention": trial.expected_total_intervention,
            "events_control": trial.expected_events_control,
            "total_control": 0,
        }
    ]
    extraction_records = {
        trial.publication_pmids[0]: {
            "pmid": trial.publication_pmids[0],
            "title": trial.trial_name,
        }
    }

    from new_meta.core.benchmark_manifest import compare_primary_analysis

    result = compare_primary_analysis(manifest, selected_rows, extraction_records)

    assert result.passed is False
    assert result.observed_total_participants == 7
    assert result.expected_total_participants == 1703
    assert result.participant_difference == -1696
    assert result.patient_totals_passed is False
    assert "patient_total_mismatch" in result.failure_reasons
    matched = result.matched[trial.trial_id]
    assert matched["expected_total_intervention"] == trial.expected_total_intervention
    assert matched["count_mismatches"]["total_control"] == {
        "observed": 0,
        "expected": trial.expected_total_control,
    }


def test_project_benchmark_counts_explicit_benchmark_primary_fulltext_sources(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[
            BenchmarkTrial(
                trial_id="codex",
                trial_name="CoDEX",
                publication_pmids=["32876695"],
                publication_dois=["10.1001/jama.2020.17021"],
                expected_events_intervention=69,
                expected_total_intervention=128,
                expected_events_control=76,
                expected_total_control=128,
            )
        ],
    )
    (tmp_path / "benchmark" / "sources" / "codex").mkdir(parents=True)
    source_path = tmp_path / "benchmark" / "sources" / "codex" / "codex_pmc.html"
    source_path.write_text("Full CoDEX article text", encoding="utf-8")
    (tmp_path / "benchmark" / "benchmark_source_manifest.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "trial_id": "codex",
                        "trial_name": "CoDEX",
                        "source_kind": "primary_full_text",
                        "filename": "codex_pmc.html",
                        "local_path": str(source_path),
                        "status": "uploaded_needs_review",
                        "parse_status": "ok",
                        "text_chars": 2048,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "search_results.json").write_text("[]", encoding="utf-8")
    (tmp_path / "screening").mkdir()
    (tmp_path / "screening" / "full_text_screening.json").write_text("[]", encoding="utf-8")

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.search_recall is not None
    assert report.search_recall.matched == 0
    assert report.primary_publication_recall is not None
    assert report.primary_publication_recall.matched == 1
    assert report.primary_full_text_recall is not None
    assert report.primary_full_text_recall.matched == 1


def test_project_benchmark_ignores_generic_benchmark_sources_for_primary_fulltext(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[
            BenchmarkTrial(
                trial_id="codex",
                trial_name="CoDEX",
                publication_pmids=["32876695"],
                publication_dois=["10.1001/jama.2020.17021"],
            )
        ],
    )
    (tmp_path / "benchmark").mkdir()
    (tmp_path / "benchmark" / "benchmark_source_manifest.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "trial_id": "codex",
                        "trial_name": "CoDEX",
                        "source_kind": "benchmark_source",
                        "filename": "who_figure2.txt",
                        "local_path": str(tmp_path / "who_figure2.txt"),
                        "status": "uploaded_needs_review",
                        "parse_status": "ok",
                        "text_chars": 2000,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "search_results.json").write_text("[]", encoding="utf-8")
    (tmp_path / "screening").mkdir()
    (tmp_path / "screening" / "full_text_screening.json").write_text("[]", encoding="utf-8")

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.primary_publication_recall is not None
    assert report.primary_publication_recall.matched == 0
    assert report.primary_full_text_recall is not None
    assert report.primary_full_text_recall.matched == 0


def test_project_benchmark_flags_blocked_run_with_publication_style_sections(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[],
    )
    manuscript_dir = tmp_path / "manuscript"
    manuscript_dir.mkdir()
    (manuscript_dir / "manuscript_facts.json").write_text(
        json.dumps({"report_type": "evidence_gap"}),
        encoding="utf-8",
    )
    (manuscript_dir / "manuscript_validation.json").write_text(
        json.dumps({"passed": False}),
        encoding="utf-8",
    )
    (manuscript_dir / "draft.md").write_text(
        "# Bad blocked report\n\n## Abstract\n\nThis looks publication-ready and concludes the treatment is effective.\n\n## Methods\n\nMethods text.",
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.manuscript_gate is not None
    assert report.manuscript_gate.blocked_run is True
    assert report.manuscript_gate.passed is False
    assert report.manuscript_gate.forbidden_sections == ["Abstract", "Methods"]
    assert report.manuscript_gate.unsupported_conclusion_present is True
    assert "blocked_publication_sections" in report.manuscript_gate.failure_reasons
    assert "blocked_unsupported_conclusion_language" in report.manuscript_gate.failure_reasons


def test_project_benchmark_cli_fails_when_manuscript_gate_fails(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[],
    )
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    manuscript_dir = tmp_path / "project" / "manuscript"
    manuscript_dir.mkdir(parents=True)
    (manuscript_dir / "manuscript_facts.json").write_text(
        json.dumps({"report_type": "evidence_gap"}),
        encoding="utf-8",
    )
    (manuscript_dir / "draft.md").write_text(
        "# Bad blocked report\n\n## Abstract\n\nThis concludes the treatment is effective.",
        encoding="utf-8",
    )

    assert benchmark_manifest_main([str(manifest_path), str(tmp_path / "project"), "--project"]) == 1
    assert benchmark_manifest_main([str(manifest_path), str(tmp_path / "project"), "--project", "--no-fail"]) == 0


def test_project_benchmark_cli_can_write_project_report(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[],
        expected_primary_result={
            "n_trials": 0,
            "n_participants": 0,
            "effect_measure": "OR",
            "fixed_effect": {"effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82},
        },
    )
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    project_dir = tmp_path / "project"
    manuscript_dir = project_dir / "manuscript"
    manuscript_dir.mkdir(parents=True)
    (manuscript_dir / "manuscript_facts.json").write_text(
        json.dumps({"report_type": "evidence_gap"}),
        encoding="utf-8",
    )
    (manuscript_dir / "draft.md").write_text(
        "# Evidence Gap\n\nNo publication-style sections.",
        encoding="utf-8",
    )

    assert benchmark_manifest_main([
        str(manifest_path),
        str(project_dir),
        "--project",
        "--write-report",
        "--no-fail",
    ]) == 0

    report_path = project_dir / "benchmark" / "benchmark_report.json"
    summary_path = project_dir / "benchmark" / "benchmark_summary_card.json"
    assert report_path.exists()
    assert summary_path.exists()
    report = json.loads(report_path.read_text(encoding="utf-8"))
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert report["benchmark_id"] == "mini"
    assert report["summary_card"] == summary
    assert summary["published_anchor"]["effect_measure"] == "OR"


def test_passed_benchmark_report_clears_stale_clinicaltrials_warning(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "pipeline_warnings.json").write_text(
        json.dumps([
            {
                "stage": "retrieval",
                "code": "clinicaltrials_fallback_failed",
                "message": "ClinicalTrials.gov fallback failed.",
            },
            {
                "stage": "figures",
                "code": "figure_generation_failed",
                "message": "Funnel plot failed.",
            },
        ]),
        encoding="utf-8",
    )
    report = BenchmarkProjectReport(
        benchmark_id="mini",
        project_dir=str(project_dir),
        summary_card={
            "benchmark_id": "mini",
            "status": "passed",
            "passed": True,
            "failing_gates": [],
        },
    )

    write_project_benchmark_report(report, project_dir)

    warnings = json.loads((project_dir / "pipeline_warnings.json").read_text(encoding="utf-8"))
    assert [warning["code"] for warning in warnings] == ["figure_generation_failed"]


def test_project_benchmark_allows_clean_evidence_gap_artifact(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[],
    )
    manuscript_dir = tmp_path / "manuscript"
    manuscript_dir.mkdir()
    (manuscript_dir / "manuscript_facts.json").write_text(
        json.dumps({"report_type": "evidence_gap"}),
        encoding="utf-8",
    )
    (manuscript_dir / "manuscript_validation.json").write_text(
        json.dumps({"passed": False}),
        encoding="utf-8",
    )
    (manuscript_dir / "draft.md").write_text(
        "# Systematic Review Evidence-Gap Report\n\n## Current Conclusion\n\nBlocked.\n\n## Recommended Next Actions\n\nUpload PDFs.",
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.manuscript_gate is not None
    assert report.manuscript_gate.blocked_run is True
    assert report.manuscript_gate.passed is True
    assert report.manuscript_gate.forbidden_sections == []
    assert report.manuscript_gate.unsupported_conclusion_phrases == []


def test_project_benchmark_flags_meta_validation_failure_without_blocked_run_rules(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[],
    )
    manuscript_dir = tmp_path / "manuscript"
    manuscript_dir.mkdir()
    (manuscript_dir / "manuscript_facts.json").write_text(
        json.dumps({"report_type": "meta"}),
        encoding="utf-8",
    )
    (manuscript_dir / "manuscript_validation.json").write_text(
        json.dumps({
            "passed": False,
            "issues": [
                {"severity": "error", "kind": "patient_total_mismatch"},
                {"severity": "error", "kind": "artifact_reference_mismatch"},
            ],
        }),
        encoding="utf-8",
    )
    (manuscript_dir / "draft.md").write_text(
        "# Manuscript\n\n## Abstract\n\nText.\n\n## Methods\n\nText.\n\n## Results\n\nText.",
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.manuscript_gate is not None
    assert report.manuscript_gate.blocked_run is False
    assert report.manuscript_gate.passed is False
    assert report.manuscript_gate.forbidden_sections == []
    assert report.manuscript_gate.validation_issue_kinds == [
        "artifact_reference_mismatch",
        "patient_total_mismatch",
    ]
    assert report.summary_card is not None
    assert [gate["gate"] for gate in report.summary_card["failing_gates"]] == ["manuscript_gate"]
    manuscript_gate = next(gate for gate in report.summary_card["gates"] if gate["gate"] == "manuscript_gate")
    assert manuscript_gate["failure_reasons"] == ["manuscript_validation_failed"]


def test_project_benchmark_allows_negated_publication_ready_phrase_in_blocked_report(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[],
    )
    manuscript_dir = tmp_path / "manuscript"
    manuscript_dir.mkdir()
    (manuscript_dir / "manuscript_facts.json").write_text(
        json.dumps({"report_type": "evidence_gap"}),
        encoding="utf-8",
    )
    (manuscript_dir / "manuscript_validation.json").write_text(
        json.dumps({"passed": False}),
        encoding="utf-8",
    )
    (manuscript_dir / "draft.md").write_text(
        "# Systematic Review Evidence-Gap Report\n\n"
        "This run is classified as evidence_gap rather than a publication-ready meta-analysis "
        "because unresolved evidence blockers remain.",
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.manuscript_gate is not None
    assert report.manuscript_gate.passed is True
    assert report.manuscript_gate.unsupported_conclusion_phrases == []


def test_project_benchmark_flags_primary_publications_without_full_text_source(tmp_path: Path) -> None:
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST_PATH)
    screening_dir = tmp_path / "screening"
    screening_dir.mkdir()
    rows = [
        {
            "decision": "include",
            "paper": {
                "pmid": "34449189",
                "doi": "10.1056/NEJMoa2107038",
                "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                "text_availability": "abstract_only",
                "fulltext_source": "europe_pmc_abstract",
            },
        },
        {
            "decision": "include",
            "paper": {
                "pmid": "36027570",
                "doi": "10.1056/NEJMoa2206286",
                "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
                "text_availability": "abstract_only",
                "fulltext_source": "europe_pmc_abstract",
            },
        },
    ]
    (screening_dir / "full_text_screening.json").write_text(
        json.dumps(rows),
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.full_text_recall is not None
    assert report.full_text_recall.passed is True
    assert report.primary_full_text_recall is not None
    assert report.primary_full_text_recall.passed is False
    assert report.primary_full_text_recall.matched == 0
    assert {item["trial_id"] for item in report.primary_full_text_recall.missing} == {
        "deliver",
        "emperor_preserved",
    }


def test_project_benchmark_requires_blocked_report_issue_codes(tmp_path: Path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[],
    )
    manuscript_dir = tmp_path / "manuscript"
    manuscript_dir.mkdir()
    (manuscript_dir / "manuscript_facts.json").write_text(
        json.dumps({
            "report_type": "evidence_gap",
            "evidence_readiness": {
                "blocker_codes": [
                    "abstract_only_primary_effect",
                    "primary_timepoint_not_source_verified",
                ],
                "blockers": [
                    {"code": "abstract_only_primary_effect", "message": "abstract only"},
                    {"code": "primary_timepoint_not_source_verified", "message": "timepoint missing"},
                ],
            },
        }),
        encoding="utf-8",
    )
    (manuscript_dir / "manuscript_validation.json").write_text(
        json.dumps({"passed": False, "issues": [{"severity": "error", "kind": "evidence_readiness_blocker"}]}),
        encoding="utf-8",
    )
    (manuscript_dir / "draft.md").write_text(
        "# Systematic Review Evidence-Gap Report\n\n## Blocking Reasons\n\n- `abstract_only_primary_effect`: abstract only.",
        encoding="utf-8",
    )

    report = evaluate_project_against_benchmark(manifest, tmp_path)

    assert report.manuscript_gate is not None
    assert report.manuscript_gate.passed is False
    assert report.manuscript_gate.expected_issue_codes == [
        "abstract_only_primary_effect",
        "primary_timepoint_not_source_verified",
    ]
    assert report.manuscript_gate.missing_issue_codes == ["primary_timepoint_not_source_verified"]
    assert "blocked_missing_issue_codes" in report.manuscript_gate.failure_reasons


def test_registry_records_can_close_missing_search_recall_gap_if_retrieved() -> None:
    if not CURRENT_RUN_SEARCH.exists():
        pytest.skip("local benchmark run artifact is not present")
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    records = json.loads(CURRENT_RUN_SEARCH.read_text(encoding="utf-8")) + [
        {
            "title": "Hydrocortisone for COVID-19 and Severe Hypoxia",
            "source": "clinicaltrials",
            "trial_registration": "NCT04348305",
        },
        {
            "title": "Steroids-SARI",
            "source": "clinicaltrials",
            "trial_registration": "NCT04244591",
        },
    ]

    result = evaluate_benchmark_recall(manifest, records, scope="publication_ready")

    assert result.passed is True
    assert result.matched == 7


def test_manifest_registry_augmentation_fetches_missing_nct_records(monkeypatch, tmp_path) -> None:
    manifest = BenchmarkManifest.load(MANIFEST_PATH)
    records = [
        {"pmid": "32799933", "title": "DEXA-COVID 19"},
        {"pmid": "32876695", "title": "CoDEX"},
        {"pmid": "32678530", "title": "RECOVERY"},
        {"doi": "10.1001/jama.2020.16761", "title": "CAPE COVID"},
        {"pmid": "32876697", "title": "REMAP-CAP"},
    ]

    def fake_fetch(nct_id, cache_dir=None, timeout=None):
        registry_records = {
            "NCT04348305": {
                "title": "Hydrocortisone for COVID-19 and Severe Hypoxia",
                "source": "clinicaltrials",
                "trial_registration": "NCT04348305",
            },
            "NCT04244591": {
                "title": "Steroids-SARI",
                "source": "clinicaltrials",
                "trial_registration": "NCT04244591",
            },
        }
        return registry_records[nct_id], {
            "status": "cached",
            "cache_path": str(tmp_path / f"{nct_id}.json"),
        }

    from new_meta.tools import clinicaltrials

    monkeypatch.setattr(clinicaltrials, "fetch_study_cached", fake_fetch)

    augmented, result = augment_records_with_manifest_registry(
        manifest,
        records,
        cache_dir=tmp_path,
        scope="publication_ready",
    )

    assert len(augmented) == 7
    assert result.recall_before.matched == 5
    assert result.recall_after.matched == 7
    assert result.recall_after.passed is True
    assert result.added == 2
    assert {attempt.nct_id for attempt in result.attempts if attempt.added} == {
        "NCT04348305",
        "NCT04244591",
    }


def test_manifest_registry_augmentation_records_failed_fetch(monkeypatch, tmp_path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[
            BenchmarkTrial(
                trial_id="missing",
                trial_name="Missing Trial",
                registration_id="NCT00000001",
            )
        ],
        recall_thresholds={"search": 1.0},
    )

    def fake_fetch(nct_id, cache_dir=None, timeout=None):
        return None, {"status": "failed", "error": "timeout"}

    from new_meta.tools import clinicaltrials

    monkeypatch.setattr(clinicaltrials, "fetch_study_cached", fake_fetch)

    augmented, result = augment_records_with_manifest_registry(
        manifest,
        [],
        cache_dir=tmp_path,
    )

    assert augmented == []
    assert result.recall_before.matched == 0
    assert result.recall_after.matched == 0
    assert result.added == 0
    assert result.attempts[0].status == "failed"
    assert result.attempts[0].error == "timeout"


def test_manifest_registry_augmentation_does_not_duplicate_existing_records(monkeypatch, tmp_path) -> None:
    manifest = BenchmarkManifest(
        benchmark_id="mini",
        title="Mini benchmark",
        topic="mini",
        expected_trials=[
            BenchmarkTrial(
                trial_id="present",
                trial_name="Present Trial",
                registration_id="NCT00000002",
            )
        ],
        recall_thresholds={"search": 1.0},
    )
    records = [{"title": "Present Trial", "trial_registration": "NCT00000002"}]

    def fake_fetch(nct_id, cache_dir=None, timeout=None):  # pragma: no cover - should not be called
        raise AssertionError("already-present registry records should not be fetched")

    from new_meta.tools import clinicaltrials

    monkeypatch.setattr(clinicaltrials, "fetch_study_cached", fake_fetch)

    augmented, result = augment_records_with_manifest_registry(
        manifest,
        records,
        cache_dir=tmp_path,
        only_missing=False,
    )

    assert augmented == records
    assert result.added == 0
    assert result.attempts[0].status == "already_present"
    assert result.attempts[0].matched_existing is True
