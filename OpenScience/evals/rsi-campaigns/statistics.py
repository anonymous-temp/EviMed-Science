"""Preregistered fixed-horizon paired-source-group decisions (offline only).

Each registration declares groups, family margins/repeats/form weights and pilot
rationale before confirmation. Rows are complete arm/form/repeat measurements;
unknown outcomes are never scored zero. Costs include every paid attempt. The
paired-t scope is approximate, independent source groups with continuous bounded
scores, >=30 groups per tested population and no influential group. Deterministic
mode makes exact claims only about the registered finite corpus, never a population.
"""
import hashlib
import json
import math
from datetime import datetime

import numpy as np
from scipy.stats import t


def registration_digest(registration):
    """Digest the exact registration using sorted, compact, finite JSON."""
    return hashlib.sha256(json.dumps(registration, sort_keys=True, separators=(',', ':'),
                                      ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _interval(values, alpha, deterministic):
    values = np.asarray(values, dtype=float)
    if values.size == 0 or not np.all(np.isfinite(values)):
        raise ValueError('empty or nonfinite aggregate')
    mean = float(np.mean(values))
    if deterministic:
        return {'mean': mean, 'lower': mean, 'upper': mean, 'n_groups': len(values)}
    if len(values) < 30:
        raise ValueError('sparse population: paired-t requires at least 30 independent groups')
    sd = float(np.std(values, ddof=1))
    if sd <= 1e-12:
        raise ValueError('zero variance is outside approximate paired-t qualification')
    centered = np.abs(values - mean)
    if float(np.max(centered ** 2) / np.sum(centered ** 2)) > .2:
        raise ValueError('influential source group is outside qualification')
    width = float(t.ppf(1 - alpha, len(values) - 1)) * sd / math.sqrt(len(values))
    if not all(math.isfinite(v) for v in (mean, sd, width)):
        raise ValueError('nonfinite inferential quantity')
    return {'mean': mean, 'lower': mean - width, 'upper': mean + width, 'n_groups': len(values)}


def evaluate(registration, observations, receipt):
    """Return a JSON-safe verdict; invalid/incomplete evidence is inconclusive.

    V1 admits one family. paid_cost_budget bounds all paid arm totals (<=1000).
    Deterministic qualification is a trusted parent-signer receipt bound to the
    consumer and corpus; caller-supplied externally_verified is not authority.
    Receipt: registration_digest, confirmation_exposed=False, look=1,
    complete_costs=True, cost_identity, ISO now, expired_budget=False.
    Each group has id, family, failure_slice; family has margin, repeats,
    score_type='bounded-continuous', pilot_rationale, forms={name: weight}.
    Claims map efficiency/targeted-repair to separately allocated alpha, sum<=.05.
    """
    result = {'decision': 'inconclusive', 'reasons': [], 'quantities': {},
              'registration_digest': None, 'cost_totals': {'baseline': 0.0, 'candidate': 0.0},
              'scope': 'Registered finite corpus only' if isinstance(registration, dict) and registration.get('mode') == 'deterministic'
              else 'Approximate paired-t; independent source groups, continuous scores, no sequential looks',
              'limitations': ['No universal coverage claim', 'Registration and independence require external provenance audit']}
    try:
        if not isinstance(registration, dict) or not isinstance(receipt, dict) or not isinstance(observations, list) or any(not isinstance(row, dict) for row in observations):
            raise ValueError('registration, receipt and measurement rows must be objects')
        if not isinstance(registration.get('families'), dict) or len(registration['families']) != 1:
            raise ValueError('v1 supports exactly one task family per registration')
        budget = registration.get('paid_cost_budget')
        if not _number(budget) or not 0 < budget <= 1000:
            raise ValueError('registered paid cost budget must be in (0, 1000]')
        if not isinstance(registration.get('groups'), list) or any(not isinstance(g, dict) for g in registration['groups']):
            raise ValueError('groups must be objects')
        for row in observations:
            if row.get('arm') in result['cost_totals']:
                if not _number(row.get('cost')) or not 0 <= row['cost'] <= budget:
                    result['cost_totals'][row['arm']] = None
                elif result['cost_totals'][row['arm']] is not None:
                    result['cost_totals'][row['arm']] += row['cost']
        if any(v is not None and (not math.isfinite(v) or v > budget) for v in result['cost_totals'].values()):
            result['cost_totals'] = {k: v if v is not None and math.isfinite(v) else None for k, v in result['cost_totals'].items()}
            raise ValueError('paid totals exceed registered budget')
        digest = registration_digest(registration)
        result['registration_digest'] = digest
        if receipt['registration_digest'] != digest:
            raise ValueError('registration digest mismatch')
        if receipt['confirmation_exposed'] is not False or receipt['look'] != 1:
            raise ValueError('confirmation exposure or repeated look')
        if receipt['complete_costs'] is not True or receipt['cost_identity'] != registration['cost_identity']:
            raise ValueError('complete cost identity not attested')
        if not registration['cost_identity']:
            raise ValueError('missing cost identity')
        if receipt['expired_budget'] is not False or datetime.fromisoformat(receipt['now']) >= datetime.fromisoformat(registration['expires_at']):
            raise ValueError('budget/date expiry before fixed horizon')
        mode = registration['mode']
        if mode not in ('deterministic', 'paired-t'):
            raise ValueError('unsupported statistical mode')
        deterministic = mode == 'deterministic'
        if deterministic:
            qualification = receipt.get('deterministic_qualification', {})
            if not isinstance(qualification, dict) or qualification.get('type') != 'trusted-deterministic-finite-corpus' or qualification.get('consumer_id') != registration.get('consumer_id') or qualification.get('corpus_digest') != registration.get('corpus_digest') or not qualification.get('qualification_id') or qualification.get('externally_verified') is not True:
                raise ValueError('trusted externally verified deterministic consumer/corpus qualification required')
        claims = registration['claims']
        if not isinstance(claims, dict) or (len(claims) > 1 and registration.get('claim_policy') != 'preallocated-all-claims-IUT'):
            raise ValueError('single claim or explicit preallocated all-claims IUT required')
        if not claims or set(claims) - {'efficiency', 'targeted-repair'} or any(not _number(a) or a < 1e-6 for a in claims.values()) or sum(claims.values()) > .05:
            raise ValueError('invalid preregistered alpha allocation')
        groups = registration['groups']
        group_map = {g['id']: g for g in groups}
        if len(group_map) != len(groups) or len(groups) != registration['G_target'] or not groups:
            raise ValueError('fixed independent source-group target mismatch')
        expected = set()
        for group in groups:
            family = registration['families'][group['family']]
            if not isinstance(family, dict):
                raise ValueError('family must be an object')
            if not isinstance(group['failure_slice'], bool):
                raise ValueError('failure slice must be preregistered')
            if not _number(family['margin']) or not 0 < family['margin'] < 1 or not family['pilot_rationale']:
                raise ValueError('family margin requires pilot rationale')
            repeats = family['repeats']
            if type(repeats) is not int or repeats < (1 if deterministic else 3) or repeats > 100:
                raise ValueError('invalid family repetition contract')
            forms = family['forms']
            if not isinstance(forms, dict):
                raise ValueError('forms must be an object')
            if family['score_type'] != 'bounded-continuous' or not forms or any(not _number(w) or w <= 0 for w in forms.values()) or not math.isclose(sum(forms.values()), 1):
                raise ValueError('unqualified family score/weight contract')
            expected.update((group['id'], arm, form, repeat) for arm in ('baseline', 'candidate') for form in forms for repeat in range(repeats))
        indexed = {}
        for row in observations:
            key = (row['group'], row['arm'], row['form'], row['repeat'])
            if key in indexed or key not in expected:
                raise ValueError('duplicate or unregistered measurement')
            if row['status'] != 'measured' or not _number(row['quality']) or not 0 <= row['quality'] <= 1 or not _number(row['cost']) or not 0 <= row['cost'] <= budget:
                raise ValueError('unknown/nonfinite measurement or paid cost')
            if type(row['critical_violations']) is not int or row['critical_violations'] < 0:
                raise ValueError('unknown critical violation count')
            indexed[key] = row
        if set(indexed) != expected:
            raise ValueError('missing measurements at fixed horizon')
        if result['cost_totals']['baseline'] <= 0:
            raise ValueError('positive measured baseline cost required for relative cost claim')
        if any(r['critical_violations'] for r in observations if r['arm'] == 'candidate'):
            result.update(decision='not-qualified', reasons=['candidate critical violation'])
            return result
        quality, margins, slices, costs = [], [], [], []
        for group in groups:
            family = registration['families'][group['family']]
            if not isinstance(family, dict):
                raise ValueError('family must be an object')
            arms = {}
            for arm in ('baseline', 'candidate'):
                arms[arm] = sum(weight * sum(indexed[(group['id'], arm, form, repeat)]['quality'] for repeat in range(family['repeats'])) / family['repeats'] for form, weight in family['forms'].items())
            quality.append(arms['candidate'] - arms['baseline'])
            margins.append(family['margin'])
            slices.append(group['failure_slice'])
            costs.append(tuple(sum(weight * sum(indexed[(group['id'], arm, form, repeat)]['cost'] for repeat in range(family['repeats'])) / family['repeats'] for form, weight in family['forms'].items()) for arm in ('baseline', 'candidate')))
        verdict, quantities = numeric_decision(quality, margins, slices, costs, claims, deterministic)
        result['decision'] = verdict
        result['quantities'] = quantities
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        result['reasons'].append(str(error))
    return result


def numeric_decision(quality, margins, slices, costs, claims, deterministic=False):
    """Shared numerical core; every component uses its allocated claim alpha."""
    outcomes, quantities = [], {}
    for claim, alpha in claims.items():
        ni = _interval(np.array(quality) + margins, alpha, deterministic)
        bound = .9 if claim == 'efficiency' else 1.1
        cost = _interval([candidate - bound * baseline for baseline, candidate in costs], alpha, deterministic)
        item = {'quality_noninferiority': ni, 'cost_contrast': cost, 'cost_factor': bound}
        passed = ni['lower'] > 0 and cost['upper'] <= 0
        if claim == 'targeted-repair':
            repair = _interval([q for q, selected in zip(quality, slices) if selected], alpha, deterministic)
            item['failure_slice_quality'] = repair
            passed = passed and repair['lower'] > 0
        quantities[claim] = item
        outcomes.append(passed)
    return ('qualified' if all(outcomes) else 'not-qualified'), quantities
