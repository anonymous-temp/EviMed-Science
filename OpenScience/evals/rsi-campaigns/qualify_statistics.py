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
    if simulations < 20000 or groups < 25 or not 1 <= batch <= 1024:
        raise ValueError('require >=20000 simulations, >=25 groups, batch in 1..1024')
    rng = np.random.default_rng(seed)
    scenarios = [
        ('identical-quality-same-cost', 'efficiency', 0., .1, False),
        ('equal-quality-cheap', 'efficiency', 0., -.15, True),
        ('NI-boundary-efficiency', 'efficiency', -.03, -.15, False),
        ('cost-boundary-efficiency', 'efficiency', .04, 0., False),
        # Repair slice clearly better, the whole family exactly at the NI boundary: only the global NI test can refuse it.
        ('NI-boundary-repair', 'targeted-repair', -.03, -.1, False),
        # Cost at the efficiency boundary with a right-skewed (centred lognormal) noise, as paid model costs are.
        ('skewed-cost-null', 'efficiency', .04, 0., False),
        ('cost-boundary-repair', 'targeted-repair', .08, 0., False),
        ('cheap-catastrophic-regression', 'efficiency', -.4, -.3, False),
        ('meaningful-targeted-repair', 'targeted-repair', .1, -.08, True),
        ('bounded-correlated-forms-null', 'efficiency', -.03, -.15, False),
        ('rare-failure-null', 'efficiency', -.03, -.15, False),
    ]
    results = []
    for name, claim, quality_mean, cost_mean, positive in scenarios:
        results.append(_scenario(rng, name, claim, quality_mean, cost_mean, positive, simulations, groups, batch))
    # Superiority (a deterministic, zero-model-call consumer, e.g. frontier selection by day): nulls and a modest effect at the
    # registered day-level sizes and at the frontier campaign's alpha (0.05/3 per monthly campaign) as well as 0.05.
    for day_groups in (25, 31):
        for alpha in (.05, .05 / 3):
            for name, quality_mean, positive, shape in (('superiority-null', 0., False, 'normal'), ('superiority-skewed-null', 0., False, 'skewed'),
                                                        ('superiority-modest-effect', .03, True, 'normal')):
                results.append(_superiority(rng, f'{name}-G{day_groups}-a{alpha:.4f}', quality_mean, positive, shape, simulations, day_groups, alpha, batch))
    # A null's false-qualification rate is bounded by the claim's allocated alpha (the 95% binomial upper bound must not exceed it).
    qualification_passed = all(s['binomial_95_upper'] <= s['allocated_alpha'] for s in results if not s['expected_positive'])
    _validate_unknown_controls()
    return {'qualification_passed': qualification_passed, 'procedure': dict(_statistics.PROCEDURE), 'allocated_alpha': .05, 'test_alpha': .025,
            'scenarios': results, 'scenario_role': 'registered mathematical qualification controls; no held-back confirmation evidence',
            'scope': 'Shared-core mathematical clipped Gaussian and skewed contrasts with exact wrapper equivalence controls only; not end-to-end or universal coverage qualification',
            'dependencies': {'numpy': np.__version__, 'scipy': __import__('scipy').__version__}}


def _superiority(rng, name, quality_mean, positive, shape, simulations, groups, alpha, batch):
    passed = 0
    for start in range(0, simulations, batch):
        count = min(batch, simulations - start)
        if shape == 'skewed':
            quality = quality_mean + .04 * (rng.exponential(1., (count, groups)) - 1.)
        else:
            quality = rng.normal(quality_mean, .04, (count, groups))
        for index in range(count):
            q = np.clip(quality[index], -.49, .49)
            try:
                verdict, _ = _statistics.numeric_decision(q, [0.] * groups, [False] * groups, [(0., 0.)] * groups, {'superiority': alpha})
            except ValueError:
                verdict = 'inconclusive'
            if start == 0 and index == 0:
                _validate_wrapper(q, [(0., 0.)] * groups, 'superiority', verdict, alpha=alpha)
            passed += verdict == 'qualified'
    return {'scenario': name, 'claim': 'superiority', 'expected_positive': positive, 'groups': groups, 'alpha': alpha * _statistics.PROCEDURE['test_alpha_fraction'],
            'allocated_alpha': alpha, 'qualified': passed, 'simulations': simulations, 'rate': passed / simulations,
            'binomial_95_upper': 1. if passed == simulations else float(beta.ppf(.95, passed + 1, simulations - passed))}


def _scenario(rng, name, claim, quality_mean, cost_mean, positive, simulations, groups, batch):
    passed = 0
    for start in range(0, simulations, batch):
        count = min(batch, simulations - start)
        quality = rng.normal(quality_mean, .05, (count, groups))
        if name == 'bounded-correlated-forms-null':
            # Independent groups; shared latent group + correlated form/repeat noise.
            latent = rng.uniform(-.06, .06, (count, groups, 1, 1))
            form = rng.uniform(-.02, .02, (count, groups, 2, 1))
            repeat = rng.uniform(-.01, .01, (count, groups, 2, 3))
            quality = quality_mean + (latent + form + repeat).mean(axis=(2, 3))
        if name == 'rare-failure-null':
            # Centered rare shocks: null mean retained, influence rule still applied.
            quality = quality_mean + rng.normal(0, .01, (count, groups)) + .2 * (rng.binomial(1, .02, (count, groups)) - .02)
        if name == 'NI-boundary-repair':
            # Half the groups (the registered slice) gain .07, the rest lose .13: global mean -.03, the margin's boundary.
            quality = np.where(np.arange(groups) < groups // 2, .07, -.13) + rng.normal(0, .05, (count, groups))
        cost = rng.normal(cost_mean, .08, (count, groups))
        if name == 'skewed-cost-null':
            cost = cost_mean + .08 * (rng.lognormal(0, .8, (count, groups)) - np.exp(.32)) / np.sqrt((np.exp(.64) - 1) * np.exp(.64))
        for index in range(count):
            q = np.clip(quality[index], -.49, .49)
            factor = .9 if claim == 'efficiency' else 1.1
            costs = [(.4, float(.4 * (factor + c))) for c in cost[index]]
            try:
                verdict, _ = _statistics.numeric_decision(q, [.03] * groups,
                    [i < groups // 2 for i in range(groups)], costs, {claim: .05})
            except ValueError:
                verdict = 'inconclusive'
            if start == 0 and index == 0:
                _validate_wrapper(q, costs, claim, verdict)
            passed += verdict == 'qualified'
    return {'scenario': name, 'claim': claim, 'expected_positive': positive, 'groups': groups, 'allocated_alpha': .05,
            'qualified': passed, 'simulations': simulations, 'rate': passed / simulations,
            'binomial_95_upper': 1. if passed == simulations else float(beta.ppf(.95, passed + 1, simulations - passed))}


def _validate_wrapper(quality, costs, claim, expected, alpha=.05):
    """Check aggregation, minimum slice size and core parity on each scenario."""
    n = len(quality)
    registration = {'procedure': dict(_statistics.PROCEDURE), 'version': 1, 'mode': 'paired-t', 'paid_cost_budget': 1000,
        'groups': [{'id': str(i), 'family': 'calibration', 'failure_slice': i < n // 2 and claim != 'superiority'} for i in range(n)],
        'G_target': n, 'claims': {claim: alpha}, 'expires_at': '2030-01-01T00:00:00+00:00',
        'cost_identity': 'deterministic-no-model-call' if claim == 'superiority' else 'all mathematical arm/form/repeat costs',
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


def _validate_unknown_controls():
    """Wrapper controls remain unknown instead of creating favorable scores."""
    # Reuse the behavioral fixtures, which exercise actual registered rows.
    test_path = Path(__file__).parent / 'tests' / 'test_statistics.py'
    spec = importlib.util.spec_from_file_location('qualification_controls', test_path)
    controls = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controls)
    for mutation in ('missing', 'outage', 'rare-critical'):
        registration, rows, receipt = controls.fixture(mode='deterministic')
        if mutation == 'missing': rows.pop()
        if mutation == 'outage': rows[0].update(status='evaluator-outage', quality=None)
        if mutation == 'rare-critical':
            next(row for row in rows if row['arm'] == 'candidate')['critical_violations'] = 1
        result = _statistics.evaluate(registration, rows, receipt)
        expected = 'not-qualified' if mutation == 'rare-critical' else 'inconclusive'
        if result['decision'] != expected:
            raise AssertionError(f'{mutation} wrapper control failed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, default=20261026)
    parser.add_argument('--simulations', type=int, default=20000)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    with open(args.output, 'w', encoding='utf-8') as output:
        development = calibrate(args.seed, args.simulations)
        held_back = calibrate(args.seed + 104729, args.simulations)
        json.dump({'qualification_passed': development['qualification_passed'] and held_back['qualification_passed'],
                   'generatedAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                   'development': development, 'held_back': held_back,
                   'scope': 'Prequalification method development on public mathematical fixtures; no real candidate confirmation'}, output, indent=2, allow_nan=False)
        output.write('\n')
