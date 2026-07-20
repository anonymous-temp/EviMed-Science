import json
import math
from pathlib import Path

import pytest

from new_meta.engines.complex_rct import run_complex_rct


def test_complex_rct_matches_independent_metafor_reml_oracle() -> None:
    fixture = json.loads(
        (Path("validation/corpora/metafor_complex_rct_reml.json")).read_text(encoding="utf-8")
    )
    result = run_complex_rct(fixture["inputs"])
    expected = fixture["expected"]
    tolerances = fixture["tolerances"]
    multiarm = next(item for item in result.study_effects if item["study_id"] == "M1")

    assert multiarm["analysis_effect"] == pytest.approx(
        expected["multi_arm_analysis_effect"], abs=tolerances["effect"]
    )
    assert multiarm["variance"] == pytest.approx(
        expected["multi_arm_variance"], abs=tolerances["effect"]
    )
    assert result.pooled_analysis_scale == pytest.approx(
        expected["pooled_analysis_scale"], abs=tolerances["effect"]
    )
    assert result.standard_error_analysis_scale == pytest.approx(
        expected["standard_error_analysis_scale"], abs=tolerances["standard_error"]
    )
    assert result.tau_squared == pytest.approx(
        expected["tau_squared"], abs=tolerances["tau_squared"]
    )
    assert math.log(result.ci_lower) == pytest.approx(
        expected["ci_lower_analysis_scale"], abs=tolerances["standard_error"]
    )
    assert math.log(result.ci_upper) == pytest.approx(
        expected["ci_upper_analysis_scale"], abs=tolerances["standard_error"]
    )
    assert result.i_squared == pytest.approx(expected["i_squared"], abs=1e-10)
    assert result.q == pytest.approx(expected["q"], abs=tolerances["effect"])
