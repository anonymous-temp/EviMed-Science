"""Regularized lower incomplete gamma function P(a, x), dependency-free.

Needed for the MGPS empirical-Bayes quantiles (EB05) without pulling in
scipy. Implementation follows Numerical Recipes (3rd ed., sec. 6.2):
a power series for x < a + 1 and a Lentz continued fraction for the
complement otherwise. Verified in tests against closed forms for integer
shapes and against erf for a = 0.5.
"""

from __future__ import annotations

import math

_MAX_ITER = 100_000  # large shapes near x ~= a need many series terms
_EPS = 3.0e-14
_FPMIN = 1.0e-300


def regularized_gamma_p(a: float, x: float) -> float:
    """P(a, x) = γ(a, x) / Γ(a), the lower regularized incomplete gamma."""
    if not math.isfinite(a) or a <= 0.0:
        raise ValueError(f"shape a must be positive and finite, got {a!r}")
    if not math.isfinite(x) or x < 0.0:
        raise ValueError(f"x must be non-negative and finite, got {x!r}")
    if x == 0.0:
        return 0.0
    if x < a + 1.0:
        return _gamma_p_series(a, x)
    return 1.0 - _gamma_q_continued_fraction(a, x)


def _gamma_p_series(a: float, x: float) -> float:
    """P(a, x) via its convergent power series (valid and fast for x < a+1)."""
    gln = math.lgamma(a)
    term = 1.0 / a
    total = term
    an = a
    for _ in range(_MAX_ITER):
        an += 1.0
        term *= x / an
        total += term
        if abs(term) < abs(total) * _EPS:
            return total * math.exp(-x + a * math.log(x) - gln)
    raise ArithmeticError(f"gamma series did not converge for a={a}, x={x}")


def _gamma_q_continued_fraction(a: float, x: float) -> float:
    """Q(a, x) = 1 - P(a, x) via Lentz's continued fraction method."""
    gln = math.lgamma(a)
    b = x + 1.0 - a
    c = 1.0 / _FPMIN
    d = 1.0 / max(b, _FPMIN)
    h = d
    for i in range(1, _MAX_ITER + 1):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = b + an / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < _EPS:
            return math.exp(-x + a * math.log(x) - gln) * h
    raise ArithmeticError(f"gamma continued fraction did not converge for a={a}, x={x}")
