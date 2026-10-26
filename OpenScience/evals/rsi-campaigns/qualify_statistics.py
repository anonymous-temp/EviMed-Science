"""Seeded, bounded-memory mathematical calibration; no models or paid calls."""
import argparse
import json
import numpy as np
from scipy.stats import beta, t


def calibrate(seed=20261026, simulations=20000, groups=80, batch=256):
    """Calibrate only declared Gaussian paired contrasts, not universal coverage.

    Boundary cases estimate false qualification. Positive cases estimate power.
    One-sided exact binomial bounds quantify Monte Carlo uncertainty.
    """
    if simulations < 20000 or groups < 30 or not 1 <= batch <= 1024:
        raise ValueError('require >=20000 simulations, >=30 groups, batch in 1..1024')
    rng = np.random.default_rng(seed)
    scenarios = [
        ('identical-quality-same-cost', 'efficiency', 0., .1, False),
        ('equal-quality-cheap', 'efficiency', 0., -.15, True),
        ('NI-boundary-efficiency', 'efficiency', -.03, -.15, False),
        ('cost-boundary-efficiency', 'efficiency', .04, 0., False),
        ('NI-boundary-repair', 'targeted-repair', -.03, -.1, False),
        ('cost-boundary-repair', 'targeted-repair', .08, 0., False),
        ('cheap-catastrophic-regression', 'efficiency', -.4, -.3, False),
        ('meaningful-targeted-repair', 'targeted-repair', .1, -.08, True),
    ]
    results = []
    for name, claim, quality_mean, cost_mean, positive in scenarios:
        passed = 0
        for start in range(0, simulations, batch):
            count = min(batch, simulations - start)
            quality = rng.normal(quality_mean, .05, (count, groups))
            cost = rng.normal(cost_mean, .08, (count, groups))
            def limits(values):
                mean = values.mean(axis=1)
                width = t.ppf(.95, values.shape[1] - 1) * values.std(axis=1, ddof=1) / np.sqrt(values.shape[1])
                influence = np.max((values - mean[:, None]) ** 2, axis=1) / np.sum((values - mean[:, None]) ** 2, axis=1)
                return mean - width, mean + width, influence <= .2
            ql, _, qok = limits(quality + .03)
            _, cu, cok = limits(cost)
            accepted = (ql > 0) & (cu <= 0) & qok & cok
            if claim == 'targeted-repair':
                lower, _, ok = limits(quality[:, :groups // 2])
                accepted &= (lower > 0) & ok
            passed += int(accepted.sum())
        results.append({'scenario': name, 'claim': claim, 'expected_positive': positive,
                        'qualified': passed, 'simulations': simulations, 'rate': passed / simulations,
                        'binomial_95_upper': 1. if passed == simulations else float(beta.ppf(.95, passed + 1, simulations - passed))})
    return {'seed': seed, 'groups': groups, 'batch': batch, 'scenarios': results,
            'scope': 'Pure mathematical Gaussian contrasts only; not end-to-end or universal coverage qualification',
            'dependencies': {'numpy': np.__version__, 'scipy': __import__('scipy').__version__}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, default=20261026)
    parser.add_argument('--simulations', type=int, default=20000)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump(calibrate(args.seed, args.simulations), output, indent=2, allow_nan=False)
        output.write('\n')
