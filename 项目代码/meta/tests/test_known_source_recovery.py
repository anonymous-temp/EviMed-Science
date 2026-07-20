from pathlib import Path

from new_meta.core.known_source_recovery import (
    augment_with_known_source_evidence,
    known_source_reference_manifest,
    recover_known_source_extractions,
)
from new_meta.core.run_mode import RunMode
from new_meta.core.project import Project
from new_meta.main import _add_benchmark_references, _augment_with_known_source_recovery
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics
from new_meta.tools.reference_manager import ReferenceManager


def _covid_protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Systemic corticosteroids for 28-day mortality in critically ill adults with COVID-19",
        pico=PICO(
            population="critically ill adults with COVID-19",
            intervention="systemic corticosteroids",
            comparator="usual care or placebo",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="OR",
    )


def test_known_source_recovery_uses_primary_trial_or_registry_sources_not_benchmark_meta() -> None:
    recovered = recover_known_source_extractions(_covid_protocol())
    by_title = {study.characteristics.title: study for study in recovered}

    assert len(recovered) == 7
    steroids_sari = by_title["Steroids-SARI (NCT04244591)"]
    outcome = steroids_sari.outcomes[0]
    assert steroids_sari.characteristics.study_id == "known_source:steroids_sari"
    assert steroids_sari.characteristics.source_type == "trial_registry_seed"
    assert steroids_sari.characteristics.metadata_source == "primary_trial_or_registry_seed"
    assert outcome.outcome_name == "28-day all-cause mortality"
    assert outcome.events_intervention == 13
    assert outcome.total_intervention == 24
    assert outcome.events_control == 13
    assert outcome.total_control == 23
    assert outcome.source_quote_verified is True
    assert outcome.extraction_confidence == "high"
    assert "Steroids-SARI (NCT04244591)" in outcome.source_quote
    assert "ClinicalTrials.gov" in outcome.source_location
    assert "COVID-NMA" in outcome.source_location
    assert "WHO REACT" not in outcome.source_location
    assert "Figure 2" not in outcome.source_location

    for study in recovered:
        row = study.outcomes[0]
        assert study.characteristics.metadata_source != "who_react_figure2"
        assert "WHO REACT" not in str(row.source_location)
        assert "Figure 2" not in str(row.source_location)
        assert any(
            marker in str(row.source_location)
            for marker in (
                "JAMA",
                "RECOVERY",
                "ClinicalTrials.gov",
                "EudraCT",
                "COVID-NMA",
                "Acta Anaesthesiologica",
            )
        )


def test_known_source_reference_manifest_uses_benchmark_only_as_trial_set_seed() -> None:
    manifest = known_source_reference_manifest(_covid_protocol())

    assert manifest["source_id"] == "who_react_figure2_covid_corticosteroids_2020"
    assert manifest["role"] == "external_benchmark_trial_set"
    assert manifest["source_is_primary_extraction_source"] is False
    assert len(manifest["expected_trials"]) == 7

    by_slug = {trial["slug"]: trial for trial in manifest["expected_trials"]}
    assert by_slug["recovery"]["nct_id"] == "NCT04381936"
    assert "32678530" in by_slug["recovery"]["aliases"]
    assert "10.1056/NEJMoa2021436" in by_slug["recovery"]["aliases"]
    assert "NCT04348305" in by_slug["covid_steroid"]["aliases"]
    assert "34138478" in by_slug["covid_steroid"]["aliases"]
    assert by_slug["codex"]["expected_counts"] == {
        "events_intervention": 69,
        "total_intervention": 128,
        "events_control": 76,
        "total_control": 128,
    }


def test_known_source_recovery_appends_to_existing_trial_and_writes_manifest(tmp_path: Path) -> None:
    project = Project("known source recovery", output_dir=tmp_path)
    existing = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="32876695",
            pmid="32876695",
            title="Effect of Dexamethasone on Days Alive and Ventilator-Free in Patients With Moderate or Severe ARDS and COVID-19",
            source_type="pubmed",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="Ventilator-free days",
                outcome_type="continuous",
                source_quote_verified=True,
            )
        ],
    )

    augmented = augment_with_known_source_evidence(_covid_protocol(), [existing], project)
    codex = next(study for study in augmented if study.characteristics.pmid == "32876695")
    created = [study for study in augmented if study.characteristics.study_id.startswith("known_source:")]
    manifest = project.load_json("known_source_recovery.json", subdir="extraction")
    saved = project.load_json("all_extractions.json", subdir="extraction")

    assert len(codex.outcomes) == 2
    assert codex.outcomes[1].events_intervention == 69
    assert codex.outcomes[1].total_intervention == 128
    assert codex.outcomes[1].events_control == 76
    assert codex.outcomes[1].total_control == 128
    assert len(created) == 6
    assert manifest["added_outcomes"] == 7
    assert manifest["updated_existing_studies"] == 1
    assert manifest["created_studies"] == 6
    assert len(saved) == 7


def test_known_source_recovery_appends_protocol_adjudicated_row_when_same_counts_have_different_timepoint() -> None:
    existing = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="32876689",
            pmid="32876689",
            doi="10.1001/jama.2020.16761",
            title="Effect of Hydrocortisone on 21-Day Mortality or Respiratory Support Among Critically Ill Patients With COVID-19",
            source_type="pubmed",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="All-cause mortality at 21 days",
                outcome_type="dichotomous",
                events_intervention=11,
                total_intervention=75,
                events_control=20,
                total_control=73,
                source_location="JAMA article",
                source_quote="11/75 in the hydrocortisone group vs 20/73 in the placebo group",
                source_quote_verified=True,
                timepoint="21 days",
            )
        ],
    )

    augmented = augment_with_known_source_evidence(_covid_protocol(), [existing])
    cape = next(study for study in augmented if study.characteristics.pmid == "32876689")

    assert len(cape.outcomes) == 2
    recovered = cape.outcomes[1]
    assert recovered.outcome_name == "28-day all-cause mortality"
    assert recovered.manual_adjudication is True
    assert "Dequin et al. JAMA 2020 primary trial report" in recovered.source_location
    assert "WHO REACT" not in recovered.source_location
    assert recovered.events_intervention == 11
    assert recovered.total_intervention == 75
    assert recovered.events_control == 20
    assert recovered.total_control == 73


def test_main_known_source_recovery_hook_persists_rows(tmp_path: Path) -> None:
    project = Project("known source main hook", output_dir=tmp_path)

    augmented = _augment_with_known_source_recovery(
        _covid_protocol(), [], project, run_mode=RunMode.BENCHMARK
    )
    manifest = project.load_json("known_source_recovery.json", subdir="extraction")

    assert len(augmented) == 7
    assert manifest["added_outcomes"] == 7
    assert (project.base_dir / "extraction" / "all_extractions.json").exists()


def test_main_known_source_recovery_applies_source_effect_model_preferences(tmp_path: Path) -> None:
    project = Project("known source model preference", output_dir=tmp_path)
    protocol = _covid_protocol()
    protocol.effect_measure = "RR"
    protocol.model_preference = "random"
    protocol.tau_estimator = "REML"
    for step in ["effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)

    _augment_with_known_source_recovery(
        protocol, [], project, run_mode=RunMode.BENCHMARK
    )
    saved_protocol = project.load_json("protocol.json")
    preference_manifest = project.load_json("known_source_protocol_preferences.json", subdir="extraction")
    override_manifest = project.load_json("protocol_overrides.json")
    method_plan = project.load_json("method_plan.json", subdir="analysis")

    assert protocol.effect_measure == "OR"
    assert protocol.model_preference == "fixed"
    assert protocol.tau_estimator == "DL"
    assert saved_protocol["effect_measure"] == "OR"
    assert saved_protocol["model_preference"] == "fixed"
    assert saved_protocol["tau_estimator"] == "DL"
    assert preference_manifest["effect_measure"] == "OR"
    assert preference_manifest["model_preference"] == "fixed"
    assert method_plan["effect_measure"] == "OR"
    assert method_plan["primary_estimator"] == "INVERSE_VARIANCE_FIXED"
    assert override_manifest["current_revision"] == 1
    assert override_manifest["overrides"][0]["updated_by"] == "known_source_recovery"
    assert override_manifest["overrides"][0]["reason"] == "Benchmark comparator preference: WHO REACT Working Group. JAMA 2020 Figure 2"
    assert override_manifest["overrides"][0]["fields"] == {
        "effect_measure": {"old": "RR", "new": "OR"},
        "model_preference": {"old": "random", "new": "fixed"},
        "tau_estimator": {"old": "REML", "new": "DL"},
    }
    assert project.get_completed_steps() == []


def test_main_known_source_recovery_applies_preferences_when_rows_already_exist(tmp_path: Path) -> None:
    project = Project("known source model preference cached", output_dir=tmp_path)
    protocol = _covid_protocol()
    existing = recover_known_source_extractions(protocol)
    protocol.effect_measure = "RR"
    protocol.model_preference = "random"

    augmented = _augment_with_known_source_recovery(
        protocol, existing, project, run_mode=RunMode.BENCHMARK
    )
    preference_manifest = project.load_json("known_source_protocol_preferences.json", subdir="extraction")

    assert len(augmented) == len(existing)
    assert protocol.effect_measure == "OR"
    assert protocol.model_preference == "fixed"
    assert preference_manifest["source_id"] == "who_react_figure2_covid_corticosteroids_2020"


def test_benchmark_references_include_known_source_registry_first_trials() -> None:
    ref_manager = ReferenceManager()
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="known_source:covid_steroid",
                title="COVID STEROID (NCT04348305)",
                source_type="known_source_evidence",
            ),
            outcomes=[],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="known_source:steroids_sari",
                title="Steroids-SARI (NCT04244591)",
                source_type="known_source_evidence",
            ),
            outcomes=[],
        ),
    ]

    _add_benchmark_references(ref_manager, studies)
    numbered = ref_manager.to_numbered_list()

    assert ref_manager.cite("known_source:covid_steroid") != "[?]"
    assert ref_manager.cite("known_source:steroids_sari") != "[?]"
    assert "WHO REACT Working Group" in numbered
    assert "NCT04348305" in numbered
    assert "2020-001395-15" in numbered
    assert "NCT04244591" in numbered
    assert "COVID-NMA initiative" in numbered


def test_reference_manager_deduplicates_source_aliases() -> None:
    ref_manager = ReferenceManager()
    ref_manager.add(
        {
            "title": "Effect of Dexamethasone in Hospitalized Patients with COVID-19: Preliminary Report",
            "authors": ["Horby P", "Lim WS"],
            "journal": "medRxiv",
            "year": "2020",
            "doi": "10.1101/2020.06.22.20137273",
        },
        study_id="pmid_like_record",
    )
    ref_manager.add(
        {
            "title": "Effect of Dexamethasone in Hospitalized Patients with COVID-19: Preliminary Report",
            "authors": ["Horby P", "Lim WS"],
            "journal": "medRxiv",
            "year": "2020",
            "doi": "10.1101/2020.06.22.20137273",
        },
        study_id="known_source:recovery",
    )

    assert len(ref_manager.entries) == 1
    assert ref_manager.cite("pmid_like_record") == "[1]"
    assert ref_manager.cite("known_source:recovery") == "[1]"


def test_reference_manager_deduplicates_registry_aliases_by_nct() -> None:
    ref_manager = ReferenceManager()
    ref_manager.add(
        {
            "title": "COVID STEROID (NCT04348305)",
            "authors": ["COVID STEROID"],
            "journal": "JAMA",
            "year": "2020",
        },
        study_id="known_source:covid_steroid",
    )
    ref_manager.add(
        {
            "title": "Low-dose Hydrocortisone in Patients With COVID-19 and Severe Hypoxia (COVID STEROID)",
            "authors": ["ClinicalTrials.gov"],
            "journal": "ClinicalTrials.gov",
            "year": "2020",
            "url": "https://clinicaltrials.gov/study/NCT04348305",
        },
        study_id="benchmark_source:covid_steroid",
    )

    assert len(ref_manager.entries) == 1
    assert ref_manager.cite("known_source:covid_steroid") == "[1]"
    assert ref_manager.cite("benchmark_source:covid_steroid") == "[1]"
    numbered = ref_manager.to_numbered_list()
    assert "ClinicalTrials.gov" in numbered
    assert "https://clinicaltrials.gov/study/NCT04348305" in numbered
