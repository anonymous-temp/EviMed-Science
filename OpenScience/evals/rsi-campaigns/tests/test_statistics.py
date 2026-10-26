"""Behavioral decision tests; no model calls."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('campaign_statistics', Path(__file__).parents[1] / 'statistics.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixture(claim='efficiency', mode='paired-t', n=40):
    groups = [{'id': str(i), 'family': 'office', 'failure_slice': i < n // 2} for i in range(n)]
    registration = {'version': 1, 'paid_cost_budget': 1000, 'consumer_id': 'test-consumer', 'corpus_digest': 'test-corpus', 'mode': mode, 'groups': groups, 'G_target': n,
                    'claims': {claim: 0.05}, 'expires_at': '2030-01-01T00:00:00+00:00',
                    'cost_identity': 'all paid attempts including failures and evaluator',
                    'families': {'office': {'margin': 0.03, 'repeats': 1 if mode == 'deterministic' else 3,
                    'score_type': 'bounded-continuous', 'pilot_rationale': 'Independent pilot variance and cost reviewed',
                    'forms': {'original': 0.5, 'equivalent': 0.5}}}}
    rows = []
    for i in range(n):
        for arm in ('baseline', 'candidate'):
            for form in ('original', 'equivalent'):
                for repeat in range(registration['families']['office']['repeats']):
                    rows.append({'group': str(i), 'arm': arm, 'form': form, 'repeat': repeat,
                                 'quality': 0.7 + (i % 3) * 0.01,
                                 'cost': 1.0 if arm == 'baseline' else 0.7 + (i % 5) * .01,
                                 'critical_violations': 0, 'status': 'measured'})
    receipt = {'registration_digest': MODULE.registration_digest(registration), 'confirmation_exposed': False,
               'look': 1, 'complete_costs': True, 'cost_identity': registration['cost_identity'],
               'now': '2026-10-26T00:00:00+00:00', 'expired_budget': False}
    receipt['deterministic_qualification'] = {'type': 'trusted-deterministic-finite-corpus', 'qualification_id': 'test-external-receipt', 'externally_verified': True, 'consumer_id': 'test-consumer', 'corpus_digest': 'test-corpus'}
    return registration, rows, receipt


class DecisionTests(unittest.TestCase):
    def test_efficiency_requires_quality_and_savings(self):
        reg, rows, receipt = fixture(mode='deterministic')
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'qualified')
        for row in rows:
            if row['arm'] == 'candidate': row['quality'] = 0.0
        self.assertNotEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'qualified')

    def test_targeted_repair_large_effect_without_savings(self):
        reg, rows, receipt = fixture('targeted-repair', n=80)
        for row in rows:
            if row['arm'] == 'candidate':
                row['quality'] += .15 + (int(row['group']) % 5) * .002
                row['cost'] = 1.01 + (int(row['group']) % 5) * .001
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'qualified')

    def test_equal_quality_same_cost_and_833_percent_fail(self):
        reg, rows, receipt = fixture(mode='deterministic')
        for row in rows:
            if row['arm'] == 'candidate': row['cost'] = 1
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'not-qualified')
        for row in rows:
            if row['arm'] == 'candidate': row['quality'], row['cost'] = .5831, .1
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'not-qualified')

    def test_unknown_failures_retain_paid_cost(self):
        reg, rows, receipt = fixture()
        rows[0].update(status='evaluator-outage', quality=None, cost=4)
        result = MODULE.evaluate(reg, rows, receipt)
        self.assertEqual(result['decision'], 'inconclusive')
        self.assertEqual(result['cost_totals']['baseline'], sum(r['cost'] for r in rows if r['arm'] == 'baseline'))

    def test_contract_integrity_and_fixed_horizon(self):
        for mutation in ('duplicate', 'missing', 'digest', 'repeat', 'exposure', 'budget'):
            reg, rows, receipt = fixture()
            if mutation == 'duplicate': rows.append(dict(rows[0]))
            if mutation == 'missing': rows.pop()
            if mutation == 'digest': receipt['registration_digest'] = 'wrong'
            if mutation == 'repeat': rows[0]['repeat'] = 100
            if mutation == 'exposure': receipt['confirmation_exposed'] = True
            if mutation == 'budget': receipt['expired_budget'] = True
            with self.subTest(mutation=mutation):
                self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')

    def test_nonfinite_and_missing_cost_are_unknown(self):
        for value in (None, float('nan'), float('inf'), -1):
            reg, rows, receipt = fixture()
            rows[0]['cost'] = value
            result = MODULE.evaluate(reg, rows, receipt)
            self.assertEqual(result['decision'], 'inconclusive')
            __import__('json').dumps(result, allow_nan=False)

    def test_family_repeat_changes_require_reregistration(self):
        reg, rows, receipt = fixture()
        reg['families']['office']['repeats'] = 10
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')
        receipt['registration_digest'] = MODULE.registration_digest(reg)
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')

    def test_cost_inference_uses_registered_weights_but_retains_paid_total(self):
        reg, rows, receipt = fixture(mode='deterministic')
        reg['families']['office']['forms'] = {'original': .9, 'equivalent': .1}
        receipt['registration_digest'] = MODULE.registration_digest(reg)
        for row in rows:
            if row['arm'] == 'candidate': row['cost'] = 0 if row['form'] == 'original' else 2
        result = MODULE.evaluate(reg, rows, receipt)
        self.assertEqual(result['decision'], 'qualified')
        self.assertEqual(result['cost_totals']['candidate'], 80)
        self.assertAlmostEqual(result['quantities']['efficiency']['cost_contrast']['mean'], -.7)

    def test_empty_slice_tiny_alpha_and_sparse_slice_fail_closed(self):
        for mutation in ('empty', 'tiny-alpha', 'sparse'):
            reg, rows, receipt = fixture('targeted-repair', n=40)
            if mutation == 'empty':
                for group in reg['groups']: group['failure_slice'] = False
            if mutation == 'tiny-alpha': reg['claims'] = {'targeted-repair': 1e-300}
            receipt['registration_digest'] = MODULE.registration_digest(reg)
            for row in rows:
                if row['arm'] == 'candidate': row['quality'] += .1 + int(row['group']) * .001
            result = MODULE.evaluate(reg, rows, receipt)
            self.assertEqual(result['decision'], 'inconclusive')
            __import__('json').dumps(result, allow_nan=False)

    def test_registered_half_alpha_and_fixed_slice_protocol(self):
        reg, rows, receipt = fixture(mode='deterministic')
        reg['procedure'] = {'id': 'rsi-paired-source-v2', 'test_alpha_fraction': .9, 'minimum_slice_groups': 30}
        receipt['registration_digest'] = MODULE.registration_digest(reg)
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')
        reg['procedure']['test_alpha_fraction'] = .5
        reg['procedure']['minimum_slice_groups'] = 1
        receipt['registration_digest'] = MODULE.registration_digest(reg)
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')

    def test_review_malformed_and_overflow_fail_closed(self):
        for reg, rows, receipt in (([], [], {}), ({}, [[]], {})):
            self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')
        reg, rows, receipt = fixture(mode='deterministic')
        for row in rows: row['cost'] = 1e308
        result = MODULE.evaluate(reg, rows, receipt)
        self.assertEqual(result['decision'], 'inconclusive')
        __import__('json').dumps(result, allow_nan=False)

    def test_review_single_family_and_trusted_determinism(self):
        reg, rows, receipt = fixture(mode='deterministic')
        receipt.pop('deterministic_qualification', None)
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')
        reg, rows, receipt = fixture()
        reg['families']['other'] = dict(reg['families']['office'])
        receipt['registration_digest'] = MODULE.registration_digest(reg)
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')

    def test_paired_t_zero_variance_requires_explicit_finite_mode(self):
        reg, rows, receipt = fixture()
        self.assertEqual(MODULE.evaluate(reg, rows, receipt)['decision'], 'inconclusive')


if __name__ == '__main__': unittest.main()
