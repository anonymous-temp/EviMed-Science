import json
from pathlib import Path

import numpy as np
import pytest

from new_meta.engines.dose_response import run_dose_response


def test_dose_response_matches_independent_dosresmeta_oracle() -> None:
    fixture = json.loads(
        Path("validation/corpora/dosresmeta_rcs_reml.json").read_text(encoding="utf-8")
    )
    result = run_dose_response(fixture["inputs"])
    expected = fixture["expected"]
    tolerance = fixture["tolerances"]

    assert result.knots == pytest.approx(expected["knots"], abs=tolerance["coefficient"])
    assert result.coefficients == pytest.approx(
        expected["coefficients"], abs=tolerance["coefficient"]
    )
    assert np.asarray(result.coefficient_covariance) == pytest.approx(
        np.asarray(expected["coefficient_covariance"]), abs=tolerance["covariance"]
    )
    assert result.nonlinearity["p_value"] == pytest.approx(
        expected["nonlinearity_p"], abs=tolerance["p_value"]
    )
    assert np.max(np.abs(result.between_study_covariance)) < expected[
        "between_study_covariance_upper_bound"
    ]
