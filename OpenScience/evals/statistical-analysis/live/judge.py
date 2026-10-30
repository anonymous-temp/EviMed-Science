"""Independent numerical checks; evaluator bindings never enter the Agent workspace.

Bindings map chosen result-file paths/JSON keys to reference quantities. They must
be written after inspecting the actual artifact's meaning, not by selecting a
convenient number from the model's prose. This checks bound numbers, not a whole
report or scientific validity. Code/split replay and prose review remain explicit
items in the acceptance report. Comparison references apply to Welch mean
differences; another justified estimator needs its own independent reference.
"""
import argparse
import csv
import hashlib
import importlib.metadata
import io
import json
import math
from pathlib import Path

import numpy as np
from scipy import stats
from sklearn.metrics import average_precision_score, roc_auc_score


def comparison_reference(fixtures, *, supplement=False, corrected=False, scale=1, read_bytes=None):
    def read(name):
        payload = read_bytes(name) if read_bytes else (Path(fixtures) / name).read_bytes()
        return list(csv.DictReader(io.StringIO(payload.decode('utf-8'))))
    rows = read('coding-correction.csv' if corrected else 'cohort.csv')
    if corrected:
        original = read('cohort.csv')
        by_id = {row['patient_id']: row for row in original}
        if len(rows) != len(by_id) or {row['patient_id'] for row in rows} != set(by_id):
            raise ValueError('Correction must be a group-only change to the same patients.')
        for row in rows:
            before = by_id[row['patient_id']]
            if (row['group'] != {'A': 'B', 'B': 'A'}[before['group']]
                    or {k: v for k, v in row.items() if k != 'group'} != {k: v for k, v in before.items() if k != 'group'}):
                raise ValueError('Correction must be group-only; measurement or other data changed.')
    if supplement:
        for item in read('supplement.csv'):
            item['marker_mm'] = float(item.pop('marker_cm')) * 10 if item['marker_cm'] else ''
            rows.append(item)
    patients = {}
    for row in rows:
        if row['patient_id'] in patients:
            old = patients[row['patient_id']]
            if old['group'] != row['group'] or not math.isclose(float(old['marker_mm']), float(row['marker_mm']), abs_tol=1e-10):
                raise ValueError('Conflicting duplicate fixture.')
        patients[row['patient_id']] = row
    groups = {group: np.array([float(r['marker_mm']) for r in patients.values() if r['group'] == group and r['marker_mm'] != '']) for group in ['A', 'B']}
    a, b = groups['A'], groups['B']
    difference = float(b.mean() - a.mean())
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    se = math.sqrt(va + vb)
    df = (va + vb) ** 2 / (va**2 / (len(a)-1) + vb**2 / (len(b)-1))
    margin = float(stats.t.ppf(.975, df) * se)
    return {'nA': len(a), 'nB': len(b), 'difference': difference * scale,
            'low': (difference-margin) * scale, 'high': (difference+margin) * scale,
            'p': float(2 * stats.t.sf(abs(difference/se), df)), 't': difference/se, 'df': float(df),
            'rawRows': len(rows), 'patients': len(patients), 'duplicates': len(rows)-len(patients),
            'missing': len(patients)-len(a)-len(b)}


def check_bindings(actual, expected, bindings):
    findings = []
    seen = set()
    for binding in bindings:
        key = binding['reference']
        value = actual
        try:
            for part in binding['source']:
                value = value[part]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError('not a finite number')
            target = expected[key]
            tolerance = max(binding.get('absoluteTolerance', 1e-8), binding.get('relativeTolerance', 1e-6) * abs(target))
            if key in seen or not math.isfinite(tolerance) or tolerance < 0:
                raise ValueError('invalid binding')
            matched = abs(value-target) <= tolerance
            findings.append({'reference': key, 'actual': value, 'expected': target, 'passed': matched, 'tolerance': tolerance})
            seen.add(key)
        except (KeyError, IndexError, TypeError, ValueError):
            findings.append({'reference': key, 'passed': False, 'reason': 'unresolved_or_invalid_binding'})
    missing = sorted(set(expected)-seen)
    return {'passed': bool(bindings) and not missing and all(row['passed'] for row in findings), 'missingReferences': missing, 'findings': findings}


def prediction_reference(source, returned, *, id_column, probability_column, source_id_column=None, threshold=.5, split_column=None, test_label='test'):
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError('Invalid threshold.')
    source_id_column = id_column if source_id_column is None else source_id_column
    known = {str(row[source_id_column]): row for row in source}
    if len(known) != len(source):
        raise ValueError('Duplicate source identity.')
    used, y, p = set(), [], []
    for row in returned:
        key = str(row[id_column])
        if key not in known or key in used:
            raise ValueError('Unknown or repeated prediction identity.')
        used.add(key)
        if split_column is not None:
            if split_column not in row or not str(row[split_column]).strip():
                raise ValueError('Prediction split is missing.')
            if row[split_column] != test_label:
                continue
        label = str(known[key]['breast_cancer_yn'])
        probability = float(row[probability_column])
        if label not in ('0', '1') or not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError('Invalid source class or probability.')
        y.append(int(label == '0'))
        p.append(probability)
    if len(set(y)) != 2:
        raise ValueError('Two held-out outcome classes required.')
    y, p = np.array(y), np.array(p)
    positive = p >= threshold
    tp, tn = int(sum(positive & (y == 1))), int(sum(~positive & (y == 0)))
    fp, fn = int(sum(positive & (y == 0))), int(sum(~positive & (y == 1)))
    return {'n': len(y), 'events': int(sum(y)), 'prevalence': float(np.mean(y)), 'auc': float(roc_auc_score(y, p)),
            'averagePrecision': float(average_precision_score(y, p)), 'brier': float(np.mean((p-y)**2)),
            'tp': tp, 'tn': tn, 'fp': fp, 'fn': fn,
            'sensitivity': tp/(tp+fn), 'specificity': tn/(tn+fp),
            'ppv': tp/(tp+fp) if tp+fp else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', required=True)
    parser.add_argument('--bindings', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    root = Path(args.artifacts).resolve()
    repository = Path(__file__).resolve().parents[3]
    inputs = []

    def shown(file):
        # A receipt names a file relative to the captured run or to the OpenScience
        # directory, never to the machine that happened to run the judge.
        for base in (root, repository):
            if file.is_relative_to(base):
                return file.relative_to(base).as_posix()
        return file.name

    def receipt(file, role):
        payload = file.read_bytes()
        inputs.append({'role': role, 'path': shown(file), 'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)})
        return payload

    spec = json.loads(receipt(Path(args.bindings).resolve(), 'bindings'))
    receipt(Path(__file__).resolve(), 'judge')
    fixtures = Path(__file__).parent / 'fixtures'
    fixture_manifest = json.loads(receipt(Path(__file__).with_name('fixture-sources.json'), 'fixture-manifest'))

    def fixture(name):
        file = fixtures / name
        payload = receipt(file, 'fixture')
        if hashlib.sha256(payload).hexdigest() != fixture_manifest['sha256'][name]:
            raise ValueError('Fixture differs from its recorded source digest.')
        return payload

    checks = []
    for turn in spec['turns']:
        workspace = root / f'turn-{turn["index"]}' / 'workspace'
        file = (workspace / turn['results']).resolve()
        if not file.is_relative_to(workspace):
            raise ValueError('Result file must be inside the captured workspace.')
        actual = json.loads(receipt(file, 'results'))
        kind = turn.get('referenceKind', 'comparison')
        if kind == 'prediction':
            predictions = (workspace / turn['predictions']).resolve()
            if not predictions.is_relative_to(workspace):
                raise ValueError('Predictions must be inside the captured workspace.')
            returned = list(csv.DictReader(io.StringIO(receipt(predictions, 'predictions').decode('utf-8'))))
            source = list(csv.DictReader(io.StringIO(fixture('breast-cancer.csv').decode('utf-8'))))
            reference = prediction_reference(source, returned, **turn['predictionOptions'])
        elif kind == 'comparison':
            options = turn.get('referenceOptions', {})
            reference = comparison_reference(fixtures, read_bytes=fixture, **options)
        else:
            raise ValueError('Unknown independent reference kind.')
        expected = {name: reference[name] for name in turn['required']}
        if not expected:
            raise ValueError('At least one independent reference is required.')
        result = check_bindings(actual, expected, turn['bindings'])
        checks.append({'turn': turn['index'], **result})
    report = {'scope': 'explicitly_bound_numerical_values_only', 'passed': bool(checks) and all(row['passed'] for row in checks), 'checks': checks,
              'inputs': inputs, 'versions': {name: importlib.metadata.version(name) for name in ('numpy', 'scipy', 'scikit-learn')}}
    Path(args.out).write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
