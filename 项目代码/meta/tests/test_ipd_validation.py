import json
import math
from pathlib import Path

import numpy as np
import pytest

from new_meta.engines.ipd import run_ipd_meta


def _datasets():
    binary_rng = np.random.default_rng(20260717)
    binary = []
    for study_index in range(4):
        participants = []
        for participant_index in range(240):
            treatment = participant_index % 2
            baseline = binary_rng.normal()
            linear = -1 - 0.55 * treatment + 0.20 * baseline - 0.30 * treatment * baseline
            participants.append({
                "treatment": treatment,
                "outcome": int(binary_rng.random() < 1 / (1 + math.exp(-linear))),
                "covariates": {"baseline": baseline},
            })
        binary.append({"study_id": f"B{study_index}", "participants": participants})

    continuous_rng = np.random.default_rng(20260718)
    continuous = []
    for study_index in range(4):
        participants = []
        for participant_index in range(160):
            treatment = participant_index % 2
            baseline = continuous_rng.normal()
            participants.append({
                "treatment": treatment,
                "outcome": 10 + study_index - 2 * treatment + 0.5 * baseline + continuous_rng.normal(0, 2),
                "covariates": {"baseline": baseline},
            })
        continuous.append({"study_id": f"C{study_index}", "participants": participants})

    survival_rng = np.random.default_rng(20260719)
    survival = []
    for study_index in range(4):
        participants = []
        for participant_index in range(180):
            treatment = participant_index % 2
            event_time = survival_rng.exponential(1 / (0.15 * math.exp(-0.50 * treatment)))
            censor_time = survival_rng.exponential(10)
            participants.append({
                "treatment": treatment,
                "time": min(event_time, censor_time),
                "event": int(event_time <= censor_time),
            })
        survival.append({"study_id": f"S{study_index}", "participants": participants})
    return {"binary": binary, "continuous": continuous, "survival": survival}


@pytest.mark.parametrize(
    ("kind", "kwargs"),
    [
        ("binary", {"outcome_type": "binary", "effect_measure": "OR", "covariates": ["baseline"], "effect_modifier": "baseline"}),
        ("continuous", {"outcome_type": "continuous", "effect_measure": "MD", "covariates": ["baseline"]}),
        ("survival", {"outcome_type": "time_to_event", "effect_measure": "HR"}),
    ],
)
def test_ipd_models_match_independent_r_oracles(kind: str, kwargs: dict) -> None:
    fixture = json.loads(Path("validation/corpora/ipd_r_oracles.json").read_text(encoding="utf-8"))
    expected = fixture["expected"][kind]
    tolerance = fixture["tolerances"]
    result = run_ipd_meta(_datasets()[kind], **kwargs)
    analysis_coefficient = (
        math.log(result.pooled_effect) if result.effect_measure in {"OR", "HR"} else result.pooled_effect
    )
    pooled_se = (
        (math.log(result.ci_upper) - math.log(result.ci_lower)) / (2 * 1.959963984540054)
        if result.effect_measure in {"OR", "HR"}
        else (result.ci_upper - result.ci_lower) / (2 * 1.959963984540054)
    )

    assert [item["analysis_effect"] for item in result.study_effects] == pytest.approx(
        expected["study_coefficients"], abs=tolerance["coefficient"]
    )
    assert [item["standard_error"] for item in result.study_effects] == pytest.approx(
        expected["study_standard_errors"], abs=tolerance["standard_error"]
    )
    assert analysis_coefficient == pytest.approx(
        expected["pooled_coefficient"], abs=tolerance["coefficient"]
    )
    assert pooled_se == pytest.approx(
        expected["pooled_standard_error"], abs=tolerance["standard_error"]
    )
    assert result.tau_squared == pytest.approx(
        expected["tau_squared"], abs=tolerance["tau_squared"]
    )
    assert result.one_stage_sensitivity["analysis_coefficient"] == pytest.approx(
        expected["one_stage_coefficient"], abs=tolerance["coefficient"]
    )
    assert result.one_stage_sensitivity["standard_error"] == pytest.approx(
        expected["one_stage_standard_error"], abs=tolerance["standard_error"]
    )
