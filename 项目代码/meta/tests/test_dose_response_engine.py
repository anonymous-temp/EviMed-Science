import math

import pytest

from new_meta.engines.dose_response import run_dose_response


def _records(*, nonlinear: float = -0.40):
    rows = []
    study_offsets = {"D1": -0.01, "D2": 0.02, "D3": -0.02, "D4": 0.01}
    for study_id, offset in study_offsets.items():
        first_id = f"{study_id}:1"
        second_id = f"{study_id}:2"
        rows.extend([
            {
                "result_id": first_id,
                "study_id": study_id,
                "contrast_id": first_id,
                "dose": 1.0,
                "reference_dose": 0.0,
                "dose_unit": "mg/day",
                "measure": "RR",
                "estimate": -0.20 + offset,
                "standard_error": 0.20,
                "scale": "log",
                "covariance_with": {second_id: 0.015},
            },
            {
                "result_id": second_id,
                "study_id": study_id,
                "contrast_id": second_id,
                "dose": 2.0,
                "reference_dose": 0.0,
                "dose_unit": "mg/day",
                "measure": "RR",
                "estimate": -0.40 + 1.5 * nonlinear + offset,
                "standard_error": 0.22,
                "scale": "log",
                "covariance_with": {first_id: 0.015},
            },
        ])
    return rows


def test_dose_response_fits_multivariate_reml_spline_and_curve() -> None:
    result = run_dose_response(_records())

    assert result.measure == "RR"
    assert result.n_studies == 4
    assert result.n_contrasts == 8
    assert result.dose_unit == "mg/day"
    assert result.knots == pytest.approx([0.0, 1.0, 2.0])
    assert len(result.coefficients) == 2
    assert len(result.between_study_covariance) == 2
    curve = {item["dose"]: item for item in result.curve}
    assert curve[0.0]["effect"] == pytest.approx(1.0)
    assert curve[1.0]["effect"] == pytest.approx(math.exp(-0.20), abs=0.03)
    assert curve[2.0]["effect"] < curve[1.0]["effect"]
    assert result.nonlinearity["df"] == 1
    assert result.nonlinearity["p_value"] < 0.05
    assert result.diagnostics["within_study_covariance"] == "explicit"
    assert result.diagnostics["model"] == "two_stage_multivariate_reml_rcs"


def test_dose_response_harmonizes_convertible_mass_units() -> None:
    rows = _records(nonlinear=0.0)
    for row in rows[2:4]:
        row["dose"] /= 1000
        row["dose_unit"] = "g/day"

    result = run_dose_response(rows)

    assert result.dose_unit == "mg/day"
    assert result.nonlinearity["p_value"] > 0.05


def test_dose_response_rejects_missing_within_study_covariance() -> None:
    rows = _records()
    rows[0]["covariance_with"] = {}
    rows[1]["covariance_with"] = {}

    with pytest.raises(ValueError, match="explicit covariance"):
        run_dose_response(rows)


def test_dose_response_rejects_incompatible_dose_dimensions() -> None:
    rows = _records()
    rows[-1]["dose_unit"] = "mg/kg/day"

    with pytest.raises(ValueError, match="dose units"):
        run_dose_response(rows)


def test_dose_response_rejects_studies_without_spline_rank() -> None:
    rows = _records()
    rows = [row for row in rows if not (row["study_id"] == "D1" and row["dose"] == 2.0)]

    with pytest.raises(ValueError, match="at least two non-reference dose contrasts"):
        run_dose_response(rows)


def test_observational_dose_response_requires_compatible_adjusted_effects() -> None:
    rows = _records()
    for row in rows:
        row.update({
            "design": "cohort",
            "adjusted": False,
            "adjusted_covariates": [],
        })

    with pytest.raises(ValueError, match="adjusted effects"):
        run_dose_response(rows)

    for row in rows:
        row.update({
            "adjusted": True,
            "adjusted_covariates": ["age", "sex", "baseline severity"],
        })
    result = run_dose_response(rows)
    assert result.diagnostics["observational_adjustment_set"] == [
        "age",
        "baseline severity",
        "sex",
    ]

    rows[-1]["adjusted_covariates"] = ["age", "sex"]
    with pytest.raises(ValueError, match="adjustment sets"):
        run_dose_response(rows)
