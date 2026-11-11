#!/usr/bin/env python3
"""Collect small review artifacts; never copy accounts, raw traces or public data."""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import shutil


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def native(record):
    official = record.get('official', {})
    fields = ['passed', 'rewards', 'error', 'error_category', 'verifier_error',
              'verifier_error_category', 'agent_timed_out', 'agent_exit',
              'verifier_exit', 'n_tool_calls', 'n_skill_invocations', 'agent_timeout_info']
    return {'task': record['task']['id'], 'arm': record['arm'],
            'infraError': record.get('infraError'),
            'official': {key: official[key] for key in fields if key in official}}


def collect(root, runs, out, ledger):
    summary = read(root / 'summary.json')
    assert len(summary) == 6 and all(row['complete'] for row in summary), 'Six complete arm records required'
    out.mkdir(parents=True, exist_ok=False)
    # Explicit allowlist: no generic copy of the lab root or practice directory.
    files = ['report.md', 'report.csv', 'summary.json', 'accounting.json', 'manifest.json',
             'findings.md', 'targeted-audit.json', 'python-freeze.txt', 'pin-checks.json', 'protocol-amendments.json',
             'resource-policy.json', 'task-admissions.json', 'execution-queue.json',
             'campaign-amendment.json', 'gateway-drain.json', 'batch.json', 'learned-methods.json', 'source-commit',
             'watchdog-recovery.json', 'flat-permission-recovery.json', 'capacity-hold.json',
             'queue-yield.json', 'cache-recovery.json', 'cache-recovery-organize.json']
    for name in files:
        if (root / name).exists():
            shutil.copyfile(root / name, out / name)
    shutil.copyfile(root / 'upstream/receipt.json', out / 'upstream-receipt.json')
    methods = read(root / 'learned-methods.json')['methods']
    for method in methods:
        file = root / 'learned' / method['name'] / 'SKILL.md'
        assert hashlib.sha256(file.read_bytes()).hexdigest() == method['sha256']
        target = out / 'learned' / method['name'] / 'SKILL.md'
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
    for file in (root / 'flat-receipts').rglob('*.json'):
        target = out / 'flat-receipts' / file.relative_to(root / 'flat-receipts')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
    rows, configs, native_results = [], [], []
    for result in summary:
        directory = runs / f"{result['bench']}-{result['arm']}-1"
        arm_rows = read(directory / 'ledger-row.json')
        assert len(arm_rows) == 1
        rows += arm_rows
        configs.append(read(directory / 'run.json'))
        native_results.append({'runId': directory.name,
            'records': [native(read(file)) for file in sorted((directory / 'records').glob('*.json'))]})
    appended = [json.loads(line) for line in ledger.read_text().splitlines() if line.strip()]
    run_ids = {row['runId'] for row in rows}
    actual = [row for row in appended if row.get('runId') in run_ids]
    assert len(actual) == 6, 'Append exactly one final global ledger row per arm before collection'
    for proposed in rows:
        matches = [row for row in actual if {key: value for key, value in row.items() if key not in ['ledgerId', 'at']} == {key: value for key, value in proposed.items() if key not in ['ledgerId', 'at']}]
        assert len(matches) == 1 and matches[0].get('ledgerId') and matches[0].get('at'), proposed['runId']
    write(out / 'ledger-rows.json', actual)
    write(out / 'run-configs.json', configs)
    write(out / 'native-results.json', native_results)
    calibration = []
    for run_id in ['sb-none-precompat-1', 'sb-flat-permission-calibration-1']:
        directory = runs / run_id / 'records'
        calibration.append({'runId': run_id, 'records': [native(read(p)) for p in sorted(directory.glob('*.json'))]})
    write(out / 'calibration-results.json', calibration)
    learning = read(root / 'practice/complete.json')
    jobs = collections.Counter((job.get('kind'), job.get('status')) for job in learning['jobs']['jobs'])
    practice = []
    for file in sorted((root / 'practice').glob('*.json')):
        if file.name.startswith(('sb-', 'slb-')):
            record = read(file)
            practice.append({'task': file.stem, 'turns': [
                {'status': turn.get('run', {}).get('status'), 'dispatchError': bool(turn.get('error'))}
                for turn in record.get('turns', [])]})
    write(out / 'learning.json', {key: learning.get(key) for key in
          ['at', 'learned', 'approved', 'reachedQuiet', 'productPath', 'scoredTrialsProductPath']} |
          {'methods': [{'name': item.get('name'), 'status': item.get('status')} for item in methods],
           'jobs': [{'kind': key[0], 'status': key[1], 'count': count} for key, count in sorted(jobs.items())],
           'practice': practice})
    shutil.copyfile(root / 'judges/config.json', out / 'judge-config.json')
    diagnostics = []
    for file in sorted((root / 'judges').glob('*/*.json')):
        if file.parent.name not in ['none', 'flat', 'learned']:
            continue
        item = read(file)
        metrics = {key: item.get(key) for key in ['family', 'variant', 'arm', 'judge', 'officialJudge',
                   'skillQualityError', 'trajectoryError', 'skillQuality', 'trajectoryChars']}
        metrics['coverage'] = item.get('skillCoverage', {}).get('coverage')
        metrics['executability'] = {name: value['summary']['overall_score'] for name, value in item.get('executability', {}).items()}
        metrics['safety'] = {name: value['summary']['overall_score'] for name, value in item.get('safety', {}).items()}
        metrics['keyPointRecall'] = item.get('keyPointRecall', {}).get('trajectory_key_point_recall')
        metrics['order'] = item.get('executionOrder', {}).get('score')
        metrics['completeness'] = item.get('completeness', {}).get('score')
        diagnostics.append(metrics)
    write(out / 'judge-metrics.json', diagnostics)
    python_log = (root / 'python-tests.log').read_text()
    node_log = (root / 'node-tests.log').read_text()
    audit_log = (root / 'source-audit.log').read_text()
    assert re.search(r'Ran 19 tests .*\n\nOK', python_log)
    assert re.search(r'pass 11\b', node_log) and re.search(r'fail 0\b', node_log)
    assert 'Source credential audit passed:' in audit_log
    write(out / 'checks.json', {'nodePassed': 11, 'pythonPassed': 19, 'totalPassed': 30,
        'sourceCredentialAuditPassed': True,
        'targetedEvaluationAuditPassed': (root / 'targeted-audit.json').exists() and read(root / 'targeted-audit.json').get('findings') == [],
        'logSha256': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in
                      ['node-tests.log', 'python-tests.log', 'source-audit.log']},
        'pinChecks': read(root / 'pin-checks.json')})
    size = sum(file.stat().st_size for file in out.rglob('*') if file.is_file())
    assert size < 2 * 1024**2, 'Review bundle unexpectedly exceeds 2 MiB; inspect before copying'
    sums = '\n'.join(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.relative_to(out)}'
                     for file in sorted(out.rglob('*')) if file.is_file() and file.name != 'SHA256SUMS')
    (out / 'SHA256SUMS').write_text(sums + '\n')
    print(json.dumps({'out': str(out), 'bytes': size, 'arms': len(rows), 'methods': len(methods)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path('/srv/evimed/sb'))
    parser.add_argument('--runs', type=pathlib.Path, default=pathlib.Path('/srv/evimed/runs'))
    parser.add_argument('--out', type=pathlib.Path, default=pathlib.Path('/srv/evimed/sb/public-results'))
    parser.add_argument('--ledger', type=pathlib.Path, default=pathlib.Path('/srv/evimed/results/ledger.jsonl'))
    args = parser.parse_args()
    collect(args.root, args.runs, args.out, args.ledger)
