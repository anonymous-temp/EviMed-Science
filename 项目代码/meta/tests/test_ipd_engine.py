import math

import numpy as np
import pytest

from new_meta.engines.ipd import run_ipd_meta


def _binary_studies():
    rng = np.random.default_rng(20260717)
    studies = []
    for study_index in range(4):
        participants = []
        for participant_index in range(240):
            treatment = participant_index % 2
            baseline = rng.normal(0, 1)
            linear = -1.0 - 0.55 * treatment + 0.20 * baseline - 0.30 * treatment * baseline
            outcome = int(rng.random() < 1 / (1 + math.exp(-linear)))
            participants.append({
                "participant_id": f"B{study_index}:{participant_index}",
                "treatment": treatment,
                "outcome": outcome,
                "covariates": {"baseline": baseline},
            })
        studies.append({
            "study_id": f"B{study_index}",
            "design": "parallel_rct",
            "participants": participants,
        })
    return studies


def _continuous_studies():
    rng = np.random.default_rng(20260718)
    studies = []
    for study_index in range(4):
        participants = []
        for participant_index in range(160):
            treatment = participant_index % 2
            baseline = rng.normal(0, 1)
            outcome = 10 + study_index - 2.0 * treatment + 0.5 * baseline + rng.normal(0, 2)
            participants.append({
                "participant_id": f"C{study_index}:{participant_index}",
                "treatment": treatment,
                "outcome": outcome,
                "covariates": {"baseline": baseline},
            })
        studies.append({
            "study_id": f"C{study_index}",
            "design": "parallel_rct",
            "participants": participants,
        })
    return studies


def _survival_studies():
    rng = np.random.default_rng(20260719)
    studies = []
    for study_index in range(4):
        participants = []
        for participant_index in range(180):
            treatment = participant_index % 2
            event_time = rng.exponential(1 / (0.15 * math.exp(-0.50 * treatment)))
            censor_time = rng.exponential(10)
            participants.append({
                "participant_id": f"S{study_index}:{participant_index}",
                "treatment": treatment,
                "time": min(event_time, censor_time),
                "event": int(event_time <= censor_time),
                "covariates": {},
            })
        studies.append({
            "study_id": f"S{study_index}",
            "design": "parallel_rct",
            "participants": participants,
        })
    return studies


def test_binary_ipd_meta_uses_within_study_centered_interaction() -> None:
    result = run_ipd_meta(
        _binary_studies(),
        outcome_type="binary",
        effect_measure="OR",
        covariates=["baseline"],
        effect_modifier="baseline",
    )

    assert result.n_studies == 4
    assert result.n_participants == 960
    assert result.effect_measure == "OR"
    assert result.pooled_effect < 1
    assert result.ci_lower < result.pooled_effect < result.ci_upper
    assert result.effect_modification is not None
    assert result.effect_modification["coefficient"] < 0
    assert result.diagnostics["modifier_centering"] == "within_study"
    assert result.one_stage_sensitivity["model"] == "fixed_study_intercepts"


def test_continuous_ipd_meta_returns_mean_difference_and_one_stage_sensitivity() -> None:
    result = run_ipd_meta(
        _continuous_studies(),
        outcome_type="continuous",
        effect_measure="MD",
        covariates=["baseline"],
    )

    assert result.pooled_effect == pytest.approx(-2.0, abs=0.35)
    assert result.ci_upper < 0
    assert result.one_stage_sensitivity["effect"] == pytest.approx(-2.0, abs=0.35)
    assert all(item["n_participants"] == 160 for item in result.study_effects)


def test_time_to_event_ipd_meta_fits_stratified_cox_studies() -> None:
    result = run_ipd_meta(
        _survival_studies(),
        outcome_type="time_to_event",
        effect_measure="HR",
    )

    assert result.n_studies == 4
    assert result.effect_measure == "HR"
    assert result.pooled_effect < 1
    assert result.ci_lower > 0
    assert result.diagnostics["study_model"] == "cox_partial_likelihood"
    assert result.one_stage_sensitivity["model"] == "stratified_cox_common_effect"


def test_ipd_meta_rejects_missing_core_fields_and_single_arm_studies() -> None:
    missing = _continuous_studies()
    missing[0]["participants"][0]["outcome"] = None
    with pytest.raises(ValueError, match="complete participant data"):
        run_ipd_meta(missing, outcome_type="continuous", effect_measure="MD")

    single_arm = _binary_studies()
    for participant in single_arm[0]["participants"]:
        participant["treatment"] = 1
    with pytest.raises(ValueError, match="both randomized arms"):
        run_ipd_meta(single_arm, outcome_type="binary", effect_measure="OR")

    missing_covariate = _continuous_studies()
    missing_covariate[0]["participants"][0]["covariates"]["baseline"] = None
    with pytest.raises(ValueError, match="complete participant data for all model covariates"):
        run_ipd_meta(
            missing_covariate,
            outcome_type="continuous",
            effect_measure="MD",
            covariates=["baseline"],
        )


def test_ipd_meta_rejects_nonparallel_designs() -> None:
    studies = _binary_studies()
    studies[0]["design"] = "cluster_rct"

    with pytest.raises(ValueError, match="parallel_rct"):
        run_ipd_meta(studies, outcome_type="binary", effect_measure="OR")
