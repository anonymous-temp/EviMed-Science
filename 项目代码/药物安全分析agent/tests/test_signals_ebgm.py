"""Tests for the gamma utilities and the MGPS EBGM/EB05 implementation.

The gamma CDF is checked against closed forms (integer shapes have exact
finite-series CDFs; shape 1/2 reduces to erf). EBGM itself has no simple
hand-computable closed form, so it is verified by:

1. external known-answer vectors — fixed-prior values generated with
   R/openEBGM for the standard geometric definition;
2. internal quantile consistency — EB05 must satisfy CDF(EB05) = 0.05;
3. structural properties — weights in (0,1), EB05 < EBGM, EBGM increasing
   in the observed count a, shrinkage toward the prior for weak data.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from safety_agent.signals._gamma import regularized_gamma_p
from safety_agent.signals.disproportionality import (
    DEFAULT_MGPS_PRIOR,
    MGPSPrior,
    ebgm,
)
from safety_agent.signals.mgps_fit import (
    MGPSFitResult,
    fit_mgps_prior,
    gps_prior_fit_id,
    gps_scope_fingerprint,
    load_gps_prior_artifact,
    write_gps_fit_artifact,
)
from safety_agent.signals.tables import ContingencyTable2x2

# -- regularized_gamma_p against closed forms -----------------------------------


def test_gamma_p_integer_shapes():
    x = 2.3
    assert regularized_gamma_p(1.0, x) == pytest.approx(1.0 - math.exp(-x), rel=1e-12)
    assert regularized_gamma_p(2.0, x) == pytest.approx(
        1.0 - math.exp(-x) * (1.0 + x), rel=1e-12
    )
    assert regularized_gamma_p(3.0, x) == pytest.approx(
        1.0 - math.exp(-x) * (1.0 + x + x * x / 2.0), rel=1e-12
    )


def test_gamma_p_half_shape_matches_erf():
    # P(1/2, x) = erf(sqrt(x))
    for x, expected in ((1.0, math.erf(1.0)), (2.0, math.erf(math.sqrt(2.0))), (0.04, math.erf(0.2))):
        assert regularized_gamma_p(0.5, x) == pytest.approx(expected, rel=1e-12)


def test_gamma_p_continued_fraction_branch():
    # x >> a exercises the continued-fraction branch; P -> 1 from below.
    value = regularized_gamma_p(2.0, 30.0)
    assert 0.999999 < value < 1.0
    assert value == pytest.approx(1.0 - math.exp(-30.0) * 31.0, rel=1e-10)


def test_gamma_p_validates_input():
    with pytest.raises(ValueError):
        regularized_gamma_p(0.0, 1.0)
    with pytest.raises(ValueError):
        regularized_gamma_p(1.0, -1.0)
    assert regularized_gamma_p(1.0, 0.0) == 0.0


# -- EBGM self-consistency -------------------------------------------------------


def _gamma_pdf(x, shape, rate):
    return math.exp(shape * math.log(rate) - math.lgamma(shape) + (shape - 1.0) * math.log(x) - rate * x)


def _posterior_components(table: ContingencyTable2x2, prior: MGPSPrior):
    """Re-derive the mixture posterior independently of the implementation."""
    n = table.n
    expected = (table.a + table.b) * (table.a + table.c) / n
    comps = []
    for alpha, beta, weight in (
        (prior.alpha1, prior.beta1, prior.weight),
        (prior.alpha2, prior.beta2, 1.0 - prior.weight),
    ):
        log_pred = (
            math.lgamma(alpha + table.a)
            - math.lgamma(alpha)
            - math.lgamma(table.a + 1.0)
            + alpha * math.log(beta)
            + table.a * math.log(expected)
            - (alpha + table.a) * math.log(beta + expected)
        )
        comps.append([alpha + table.a, beta + expected, math.log(weight) + log_pred])
    norm = max(c[2] for c in comps)
    weights = [math.exp(c[2] - norm) for c in comps]
    total = sum(weights)
    return [(c[0], c[1], w / total) for c, w in zip(comps, weights)], expected


def _posterior_cdf_by_integration(components, point):
    steps = 200_000
    dx = point / steps
    acc = 0.0
    for i in range(1, steps):
        x = i * dx
        acc += sum(w * _gamma_pdf(x, s, r) for s, r, w in components)
    return acc * dx


OPENEBGM_ORACLE_PRIOR = MGPSPrior(0.2, 0.1, 2.0, 4.0, 0.2)


@pytest.mark.parametrize(
    "cells,expected_q,expected_ebgm,expected_eb05",
    [
        ((10, 90, 20, 1880), 0.994890011634257, 6.03227320913093, 3.42106498289062),
        ((2, 8, 7, 983), 0.809923412610651, 5.79461027673053, 0.61814636006206),
        ((0, 10, 5, 85), 0.181075149893449, 0.173649978408583, 0.00174303788240661),
    ],
    ids=["n10-E1.5", "n2-E0.09", "n0-E0.5"],
)
def test_ebgm_matches_r_openebgm_known_answers(
    cells, expected_q, expected_ebgm, expected_eb05
):
    result = ebgm(ContingencyTable2x2(*map(float, cells)), OPENEBGM_ORACLE_PRIOR)
    assert result.posterior_weight1 == pytest.approx(expected_q, rel=1e-11)
    assert result.value == pytest.approx(expected_ebgm, rel=1e-11)
    assert result.eb05 == pytest.approx(expected_eb05, rel=1e-10)


def test_eb05_matches_independent_mixture_cdf_integration():
    table = ContingencyTable2x2(10.0, 90.0, 20.0, 1880.0)
    result = ebgm(table, OPENEBGM_ORACLE_PRIOR)
    components, expected = _posterior_components(table, OPENEBGM_ORACLE_PRIOR)
    assert result.expected == pytest.approx(expected, rel=1e-12)
    cdf_at_eb05 = _posterior_cdf_by_integration(components, result.eb05)
    assert cdf_at_eb05 == pytest.approx(0.05, abs=5e-4)


def test_ebgm_structural_properties():
    table = ContingencyTable2x2(a=10.0, b=90.0, c=20.0, d=1880.0)
    result = ebgm(table)
    assert 0.0 < result.posterior_weight1 < 1.0
    assert 0.0 < result.eb05 < result.value
    # crude relative reporting ratio a/E = 6.67; shrinkage pulls EBGM below it
    assert result.value < table.a / result.expected


def test_ebgm_increases_with_observed_count():
    previous = 0.0
    for a in (1, 3, 10, 30):
        value = ebgm(ContingencyTable2x2(a=float(a), b=90.0, c=20.0, d=1880.0)).value
        assert value > previous
        previous = value


def test_ebgm_shrinks_weak_data_toward_prior():
    # a == E: crude ratio 1, posterior must sit near 1 with EB05 below it.
    table = ContingencyTable2x2(a=10.0, b=190.0, c=90.0, d=1710.0)  # E = 200*100/2000 = 10
    result = ebgm(table)
    assert result.expected == pytest.approx(10.0, rel=1e-12)
    assert 0.5 < result.value < 1.5
    assert result.eb05 < result.value


def test_ebgm_zero_expected_count_returns_the_unchanged_prior():
    result = ebgm(ContingencyTable2x2(a=0.0, b=0.0, c=5.0, d=95.0))
    assert result.expected == 0.0
    assert result.posterior_weight1 == DEFAULT_MGPS_PRIOR.weight
    assert result.value > 0.0
    assert 0.0 < result.eb05 < result.value


def test_prior_validation():
    with pytest.raises(ValueError):
        MGPSPrior(alpha1=-1.0)
    with pytest.raises(ValueError):
        MGPSPrior(weight=1.5)
    with pytest.raises(ValueError, match="finite"):
        MGPSPrior(alpha1=float("nan"))


def test_documented_default_is_an_unfitted_starting_prior():
    assert DEFAULT_MGPS_PRIOR.weight == pytest.approx(1.0 / 3.0)
    assert DEFAULT_MGPS_PRIOR.fitted is False
    assert DEFAULT_MGPS_PRIOR.fit_id is None


def test_fit_mgps_prior_returns_snapshot_bound_fitted_prior():
    rng = np.random.default_rng(20260720)
    expected = rng.lognormal(mean=-0.2, sigma=1.0, size=300)
    component = rng.random(300) < 0.35
    relative_risk = np.where(
        component,
        rng.gamma(shape=0.3, scale=1.0 / 0.2, size=300),
        rng.gamma(shape=2.5, scale=1.0 / 3.0, size=300),
    )
    observed = rng.poisson(expected * relative_risk)

    fitted = fit_mgps_prior(observed, expected)

    assert fitted.converged is True
    assert fitted.prior.fitted is True
    assert fitted.prior.fit_id == gps_prior_fit_id(
        data_fingerprint=fitted.data_fingerprint,
        alpha1=fitted.prior.alpha1,
        beta1=fitted.prior.beta1,
        alpha2=fitted.prior.alpha2,
        beta2=fitted.prior.beta2,
        weight=fitted.prior.weight,
    )
    assert fitted.observations == 300
    assert np.isfinite(fitted.negative_log_likelihood)
    assert fitted.successful_starts >= 2
    assert fitted.near_optimal_starts >= 2
    assert fitted.parameter_agreement_starts >= 2
    assert fitted.boundary_parameters == ()
    assert fitted.prior.alpha1 / fitted.prior.beta1 <= fitted.prior.alpha2 / fitted.prior.beta2

    # External oracle: R/openEBGM 0.9.1 autoHyper(..., zeroes=TRUE,
    # squashed=FALSE) over these exact numpy-generated N/E vectors. The R
    # result is label-switched, so values below use the lower-mean component first.
    assert fitted.negative_log_likelihood == pytest.approx(401.5735225557119, rel=1e-10)
    assert fitted.prior.alpha1 == pytest.approx(0.8794091156524855, rel=1e-4)
    assert fitted.prior.beta1 == pytest.approx(1.279183792387576, rel=1e-4)
    assert fitted.prior.alpha2 == pytest.approx(4.472685204142328, rel=1e-4)
    assert fitted.prior.beta2 == pytest.approx(0.6192989788533344, rel=1e-4)
    assert fitted.prior.weight == pytest.approx(
        1.0 - 0.07176386029442458, rel=1e-4
    )

    permutation = np.random.default_rng(7).permutation(observed.size)
    reordered = fit_mgps_prior(observed[permutation], expected[permutation])
    assert reordered.negative_log_likelihood == pytest.approx(
        fitted.negative_log_likelihood, rel=1e-10
    )
    assert reordered.prior.alpha1 == pytest.approx(fitted.prior.alpha1, rel=1e-5)
    assert reordered.prior.beta1 == pytest.approx(fitted.prior.beta1, rel=1e-5)
    assert reordered.prior.alpha2 == pytest.approx(fitted.prior.alpha2, rel=1e-5)
    assert reordered.prior.beta2 == pytest.approx(fitted.prior.beta2, rel=1e-5)
    assert reordered.prior.weight == pytest.approx(fitted.prior.weight, rel=1e-5)


def test_fit_mgps_prior_validates_the_complete_matrix():
    with pytest.raises(ValueError, match="at least five"):
        fit_mgps_prior([1, 2], [0.5, 1.0])
    with pytest.raises(ValueError, match="positive"):
        fit_mgps_prior([0, 1, 2, 3, 4], [1, 1, 0, 1, 1])
    with pytest.raises(ValueError, match="max_iterations"):
        fit_mgps_prior([0, 1, 2, 3, 4], [1, 1, 1, 1, 1], max_iterations=0)


def test_fitted_prior_artifact_is_bound_to_one_snapshot(tmp_path):
    fingerprint = "a" * 64
    fit_id = gps_prior_fit_id(
        data_fingerprint=fingerprint,
        alpha1=0.3,
        beta1=0.2,
        alpha2=2.5,
        beta2=3.0,
        weight=0.4,
    )
    result = MGPSFitResult(
        prior=MGPSPrior(
            alpha1=0.3,
            beta1=0.2,
            alpha2=2.5,
            beta2=3.0,
            weight=0.4,
            fitted=True,
            fit_id=fit_id,
        ),
        negative_log_likelihood=123.4,
        converged=True,
        iterations=42,
        observations=1000,
        data_fingerprint=fingerprint,
        message="converged",
        successful_starts=3,
        near_optimal_starts=3,
        parameter_agreement_starts=3,
    )
    scope = gps_scope_fingerprint(date_from=None, date_to=None)
    path = write_gps_fit_artifact(
        result,
        tmp_path / "gps-prior.json",
        snapshot_id="s1",
        snapshot_sha256="1" * 64,
        scope_fingerprint=scope,
    )

    loaded = load_gps_prior_artifact(
        path,
        expected_snapshot_id="s1",
        expected_snapshot_sha256="1" * 64,
        expected_scope_fingerprint=scope,
    )

    assert loaded == result.prior
    with pytest.raises(ValueError, match="snapshot"):
        load_gps_prior_artifact(
            path,
            expected_snapshot_id="s2",
            expected_snapshot_sha256="1" * 64,
            expected_scope_fingerprint=scope,
        )
    with pytest.raises(ValueError, match="content hash"):
        load_gps_prior_artifact(
            path,
            expected_snapshot_id="s1",
            expected_snapshot_sha256="2" * 64,
            expected_scope_fingerprint=scope,
        )
    with pytest.raises(ValueError, match="analysis scope"):
        load_gps_prior_artifact(
            path,
            expected_snapshot_id="s1",
            expected_snapshot_sha256="1" * 64,
            expected_scope_fingerprint=gps_scope_fingerprint(
                date_from="2020-01-01", date_to=None
            ),
        )
    with pytest.raises(ValueError, match="whole"):
        fit_mgps_prior([0, 1, 2.5, 3, 4], [1, 1, 1, 1, 1])


def test_gps_prior_artifact_rejects_nonconverged_fit(tmp_path):
    fingerprint = "c" * 64
    result = MGPSFitResult(
        prior=MGPSPrior(fitted=True, fit_id=fingerprint[:16]),
        negative_log_likelihood=123.4,
        converged=False,
        iterations=1,
        observations=100,
        data_fingerprint=fingerprint,
        message="iteration limit",
    )
    with pytest.raises(ValueError, match="converge"):
        write_gps_fit_artifact(
            result,
            tmp_path / "gps-prior.json",
            snapshot_id="s1",
            snapshot_sha256="1" * 64,
            scope_fingerprint=gps_scope_fingerprint(
                date_from=None, date_to=None
            ),
        )


def test_ebgm_handles_real_faers_scale_cells():
    """Regression: large counts (a in the thousands, real openFDA scale)
    must not stall the gamma series — the quantile bracket deliberately
    starts off the x ~= shape diagonal via a Wilson-Hilferty guess."""
    from safety_agent.signals import analyze

    table = ContingencyTable2x2(a=9448.0, b=120000.0, c=60000.0, d=18_000_000.0)
    result = ebgm(table)
    assert result.value > 1.0
    assert 0.0 < result.eb05 < result.value
    components, _expected = _posterior_components(table, DEFAULT_MGPS_PRIOR)
    cdf_at_eb05 = sum(
        w * regularized_gamma_p(s, r * result.eb05) for s, r, w in components
    )
    assert cdf_at_eb05 == pytest.approx(0.05, abs=1e-6)
    # the full analyze() path (ROR/PRR/chi2/IC included) must work too
    metrics = analyze(table)
    assert metrics.ebgm.value == result.value
