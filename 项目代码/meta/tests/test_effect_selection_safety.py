import logging

import pytest

from new_meta.engines import meta_engine
from new_meta.engines.effect_size import correlation_fisher_z, proportion_freeman_tukey
from new_meta.main import _dedupe_primary_effect_candidates
from new_meta.schemas.meta_result import StudyEffect
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _study(study_id: str) -> ExtractedStudy:
    return ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id=study_id,
            title=f"Trial {study_id}",
            authors=[f"{study_id} Author"],
            year=2020,
        ),
        outcomes=[],
    )


def test_primary_effect_dedupe_keeps_distinct_studies_with_same_arm_totals() -> None:
    outcome_a = OutcomeData(
        outcome_name="mortality",
        outcome_type="dichotomous",
        events_intervention=1,
        total_intervention=50,
        events_control=2,
        total_control=50,
        source_quote_verified=True,
    )
    outcome_b = outcome_a.model_copy(deep=True)
    candidates = [
        (_study("S1"), outcome_a, StudyEffect(study_id="S1", study_label="Trial S1", yi=-0.2, vi=0.04, se=0.2)),
        (_study("S2"), outcome_b, StudyEffect(study_id="S2", study_label="Trial S2", yi=-0.1, vi=0.05, se=0.22)),
    ]

    effects = _dedupe_primary_effect_candidates(candidates, logging.getLogger("test"))

    assert {effect.study_id for effect in effects} == {"S1", "S2"}


def test_correlation_and_proportion_are_back_transformed_for_reporting() -> None:
    z, _ = correlation_fisher_z(0.42, 30)
    assert meta_engine._to_original(z, "COR") == pytest.approx(0.42)

    yi, vi = proportion_freeman_tukey(30, 100)
    assert meta_engine._to_original(yi, "PROP", vi) == pytest.approx(0.30, abs=0.01)



@pytest.mark.parametrize("outcome_type, measure, reported", [
    ("continuous", "HR", "MD"), ("continuous", "RR", "SMD"),
    ("dichotomous", "MD", "RR"), ("time-to-event", "RR", "HR"),
    ("unknown", "HR", "HR"), ("continuous", "MD", "mL/min"),
    ("incidence", "HR", "IR (per 100 patient-years)"),
])
def test_effect_engine_refuses_incompatible_typed_reported_effects(outcome_type, measure, reported):
    from new_meta.engines.effect_size import compute_effect_size

    with pytest.raises(ValueError, match="(?i)adjudicat|incompatib|match"):
        compute_effect_size(outcome_type, measure, effect=4.4, ci_lower=1.6, ci_upper=7.3,
                            reported_effect_measure=reported)


@pytest.mark.parametrize("measure, reported", [("HR", "RR"), ("RR", "OR"), ("MD", "SMD"), ("HR", "")])
def test_reported_fallback_requires_exact_measure_identity(measure, reported):
    from new_meta.engines.effect_size import compute_effect_size

    outcome_type = {"HR": "time-to-event", "RR": "dichotomous", "MD": "continuous"}[measure]
    with pytest.raises(ValueError, match="reported.*measure"):
        compute_effect_size(outcome_type, measure, effect=0.8, ci_lower=0.6, ci_upper=0.9,
                            reported_effect_measure=reported)


def test_actual_continuous_slope_is_not_coerced_by_hr_protocol(tmp_path):
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.core.project import Project
    from new_meta.schemas.protocol import PICO, ResearchProtocol

    outcome = OutcomeData(
        outcome_name="Change in eGFR slope", outcome_type="continuous",
        reported_effect_measure="MD", effect_size=4.4, ci_lower=1.6, ci_upper=7.3,
        source_quote="The between-group difference of change in eGFR slope was 4.4 (1.6 to 7.3) ml/min/1.73m2 per year.",
        source_quote_verified=True, source_location="Abstract, page 972",
    )
    study = _study("slope-trial")
    study.outcomes = [outcome]
    before = outcome.model_dump()
    protocol = ResearchProtocol(
        research_question="Kidney outcomes", effect_measure="HR", primary_outcome_type="time_to_event",
        pico=PICO(population="Adults", intervention="Drug", comparator="Control", outcome_primary=outcome.outcome_name),
    )
    project = Project("typed effect admission", output_dir=tmp_path)
    compile_project_method_plan(project, protocol)
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=[study])
    assert effects == []
    assert audit[0]["decision"] == "excluded"
    assert audit[0]["reason"] == "outcome_type_measure_mismatch"
    assert audit[0]["reported_effect_measure"] == "MD"
    assert audit[0]["requested_effect_measure"] == "HR"
    assert audit[0]["source_quote"] == before["source_quote"]
    assert audit[0]["requires_adjudication"] is True
    assert "adjudicat" in audit[0]["next_action"].lower()
    assert outcome.model_dump() == before
    assert project.load_json("effect_selection_audit.json", subdir="analysis") == audit


def test_compatible_raw_inputs_and_explicit_reported_measures_remain_computable():
    import math
    from new_meta.engines.effect_size import compute_effect_size, hazard_ratio, mean_difference, risk_ratio

    assert compute_effect_size("continuous", "MD", mean_i=5, sd_i=1, n_i=50, mean_c=3, sd_c=1, n_c=50) == mean_difference(5, 1, 50, 3, 1, 50)
    assert compute_effect_size("dichotomous", "RR", events_i=10, total_i=100, events_c=5, total_c=100) == risk_ratio(10, 90, 5, 95)
    assert compute_effect_size("time_to_event", "HR", hr=0.8, hr_ci_lower=0.6, hr_ci_upper=0.9) == hazard_ratio(0.8, 0.6, 0.9)
    assert compute_effect_size("continuous", "MD", effect=4.4, ci_lower=1.6, ci_upper=7.3, reported_effect_measure="MD")[0] == 4.4
    assert compute_effect_size("time-to-event", "HR", effect=0.8, ci_lower=0.6, ci_upper=0.9, reported_effect_measure="HR")[0] == math.log(0.8)



def test_reported_log_scale_is_not_logged_a_second_time():
    from new_meta.engines.effect_size import compute_effect_size

    with pytest.raises(ValueError, match="scale"):
        compute_effect_size("time-to-event", "HR", effect=0.2, ci_lower=0.1, ci_upper=0.3,
                            reported_effect_measure="HR", reported_effect_scale="log")


def test_legacy_engine_call_cannot_reinterpret_continuous_as_hr():
    from new_meta.engines.effect_size import compute_effect_size

    with pytest.raises(ValueError, match="incompatible"):
        compute_effect_size("continuous", "HR", effect=4.4, ci_lower=1.6, ci_upper=7.3)


def test_dedicated_hazard_ratio_cannot_be_relabelled_as_risk_ratio():
    from new_meta.engines.effect_size import compute_effect_size

    with pytest.raises(ValueError, match="incompatible"):
        compute_effect_size("time-to-event", "RR", hr=0.8, hr_ci_lower=0.6, hr_ci_upper=0.9)



def test_valid_raw_data_are_not_confused_with_a_separate_reported_measure():
    from new_meta.engines.effect_size import compute_effect_size, risk_ratio, standardized_mean_difference

    assert compute_effect_size(
        "dichotomous", "RR", events_i=10, total_i=100, events_c=5, total_c=100,
        effect=2.11, ci_lower=0.7, ci_upper=6.4, reported_effect_measure="OR",
    ) == risk_ratio(10, 90, 5, 95)
    assert compute_effect_size(
        "continuous", "SMD", mean_i=5, sd_i=2, n_i=50, mean_c=3, sd_c=2, n_c=50,
        effect=2, ci_lower=1, ci_upper=3, reported_effect_measure="MD",
    ) == standardized_mean_difference(5, 2, 50, 3, 2, 50)
