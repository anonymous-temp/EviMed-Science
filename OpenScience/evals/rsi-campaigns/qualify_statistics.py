"""Seeded, bounded-memory mathematical calibration; no models or paid calls."""
import argparse
import json
import numpy as np
from scipy.stats import beta
import importlib.util
from pathlib import Path
_spec = importlib.util.spec_from_file_location('campaign_statistics', Path(__file__).with_name('statistics.py'))
_statistics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_statistics)


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
            for index in range(count):
                q = np.clip(quality[index], -.49, .49)
                factor = .9 if claim == 'efficiency' else 1.1
                costs = [(1., float(factor + c)) for c in cost[index]]
                try:
                    verdict, _ = _statistics.numeric_decision(q, [.03] * groups,
                        [i < groups // 2 for i in range(groups)], costs, {claim: .05})
                except ValueError:
                    verdict = 'inconclusive'
                if start == 0 and index == 0:
                    _validate_wrapper(q, costs, claim, verdict)
                passed += verdict == 'qualified'
        results.append({'scenario': name, 'claim': claim, 'expected_positive': positive,
                        'qualified': passed, 'simulations': simulations, 'rate': passed / simulations,
                        'binomial_95_upper': 1. if passed == simulations else float(beta.ppf(.95, passed + 1, simulations - passed))})
    qualification_passed = all(s['binomial_95_upper'] <= .05 for s in results if not s['expected_positive'])
    return {'qualification_passed': qualification_passed, 'allocated_alpha': .05, 'scenario_role': 'registered mathematical qualification controls; no held-back confirmation evidence', 'seed': seed, 'groups': groups, 'batch': batch, 'scenarios': results,
            'scope': 'Shared-core mathematical clipped Gaussian contrasts with exact wrapper equivalence controls only; not end-to-end or universal coverage qualification',
            'dependencies': {'numpy': np.__version__, 'scipy': __import__('scipy').__version__}}


def _validate_wrapper(quality, costs, claim, expected):
    """Check aggregation, minimum slice size and core parity on each scenario."""
    n = len(quality)
    registration = {'version': 1, 'mode': 'paired-t', 'paid_cost_budget': 1000,
        'groups': [{'id': str(i), 'family': 'calibration', 'failure_slice': i < n // 2} for i in range(n)],
        'G_target': n, 'claims': {claim: .05}, 'expires_at': '2030-01-01T00:00:00+00:00',
        'cost_identity': 'all mathematical arm/form/repeat costs',
        'families': {'calibration': {'margin': .03, 'repeats': 3, 'score_type': 'bounded-continuous',
            'pilot_rationale': 'Preregistered mathematical calibration scenario, not empirical task-family evidence',
            'forms': {'original': .5, 'equivalent': .5}}}}
    rows = []
    for i in range(n):
        for arm, arm_index in [('baseline', 0), ('candidate', 1)]:
            for form in ('original', 'equivalent'):
                for repeat in range(3):
                    rows.append({'group': str(i), 'arm': arm, 'form': form, 'repeat': repeat,
                        'quality': .5 + (float(quality[i]) if arm_index else 0),
                        'cost': costs[i][arm_index], 'status': 'measured', 'critical_violations': 0})
    receipt = {'registration_digest': _statistics.registration_digest(registration),
        'confirmation_exposed': False, 'look': 1, 'complete_costs': True,
        'cost_identity': registration['cost_identity'], 'now': '2026-10-26T00:00:00+00:00', 'expired_budget': False}
    actual = _statistics.evaluate(registration, rows, receipt)
    if actual['decision'] != expected:
        raise AssertionError(f"shared-core/wrapper mismatch: {expected}, {actual}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, default=20261026)
    parser.add_argument('--simulations', type=int, default=20000)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump(calibrate(args.seed, args.simulations), output, indent=2, allow_nan=False)
        output.write('\n')
