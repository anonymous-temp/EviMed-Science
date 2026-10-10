#!/usr/bin/env python3
"""Offline scoring of archived native predictions. Never imports an API client."""
import argparse
import collections
import hashlib
import json
import statistics
from pathlib import Path
from clinical_metrics import VERSION, score, scorecard


def summarize(reference, archive):
    refs = {case['id']: case for case in reference['cases']}
    grouped = collections.defaultdict(list)
    for cell in archive['predictions']:
        case = refs[cell['caseId']]
        measured = score(case['task'], case['reference'], cell['predicted'])
        grouped[cell['arm']].append({'id': cell['cell'], 'sourceGroup': cell['group'],
            'dataClass': cell['dataClass'], 'status': 'invalid' if cell['parseError'] else 'predicted', **measured,
            'writeFailures': len(cell['writeIssues']), 'milliseconds': cell['latencyMs'], 'completed': cell['code'] == 0,
            'requests': len(cell['usage']), 'settledCostCny': sum(float(row['actual_cost']) for row in cell['usage'] if row.get('actual_cost') is not None),
            'unpricedRequests': sum(row.get('actual_cost') is None for row in cell['usage']),
            'modelObservations': sorted({row['observed_model'] for row in cell['usage'] if row.get('observed_model')})})
    arms = {}
    for arm, rows in grouped.items():
        arms[arm] = {'scorecard': scorecard(rows), 'completed': sum(row['completed'] for row in rows), 'attempted': len(rows),
            'writesWithIssues': sum(row['writeFailures'] > 0 for row in rows), 'writeIssues': sum(row['writeFailures'] for row in rows),
            'medianLatencyMs': statistics.median(row['milliseconds'] for row in rows),
            'requests': sum(row['requests'] for row in rows), 'settledCostCny': sum(row['settledCostCny'] for row in rows),
            'unpricedRequests': sum(row['unpricedRequests'] for row in rows),
            'observedModels': sorted({model for row in rows for model in row['modelObservations']}), 'cases': rows}
    return {'scorer': VERSION, 'manifest': archive['manifest'], 'arms': arms,
        'limitations': ['Authored synthetic regression, not independent clinician validation or a representative cohort.',
            'Native DSH predictions pass through the real control-plane gateway, located fact writer and matching executor; this is not a deployed browser-to-kernel acceptance test.',
            'An unknown judgment caused by a refused fact is not evidence of better clinical understanding. Write failures are reported separately.',
            'Repeated prompts share the patient/source cluster; the reported interval does not treat repetitions as independent patients.',
            'No automatic production promotion or clinical qualification follows this scorecard.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--predictions', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = summarize(json.loads(args.reference.read_text()), json.loads(args.predictions.read_text()))
    report['referenceHash'] = hashlib.sha256(args.reference.read_bytes()).hexdigest()
    report['predictionArchiveHash'] = hashlib.sha256(args.predictions.read_bytes()).hexdigest()
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
