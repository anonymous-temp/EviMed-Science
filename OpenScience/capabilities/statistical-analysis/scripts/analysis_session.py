#!/usr/bin/env python3
"""Optional file-based continuity for an LLM-owned analysis, without scheduling.

A schemaVersion 1 spec contains steps with id, script, interpreter (python/r),
inputs, outputs, results (one JSON output), dependsOn and context. Context holds
only the semantics relevant to that step: groups, units, transforms or model
choices. Root and step fields are closed; arbitrary semantics belong inside
context so every accepted semantic change participates in reuse signatures.
Declare helper code and serialized model files as inputs; this helper
never unpickles them. A generated input must belong to an ancestor step. All
outputs must be files and results must be among them. Optional args are passed
verbatim to the native script. Scripts remain responsible for reading their
inputs and writing their declared output paths relative to the workspace.

status --workspace DIR --spec session.json --state state.json
run --workspace DIR --spec session.json --state state.json --step fit [--force]

Run commands must be serialized. This is provenance, not a sandbox, a numerical
validator, or a dependency scheduler. The LLM chooses and runs each stale step.
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

import run_analysis

RESERVED = ('.analysis-provenance', '.analysis-session-receipts')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def read_json(path):
    value = json.loads(path.read_text())
    # JSON's default decoder permits NaN and float overflow; neither is state.
    json.dumps(value, allow_nan=False)
    return value


def aliases(left, right):
    return (left == right or left.is_relative_to(right) or right.is_relative_to(left)
            or (left.exists() and right.exists() and left.samefile(right)))


def file_path(root, value):
    if not isinstance(value, str) or not value:
        raise ValueError('File paths must be nonempty strings.')
    path = run_analysis.confined(root, value)
    if path.exists() and not path.is_file():
        raise ValueError('Analysis paths must name files, not directories.')
    return path


def reserved(root, path):
    return any(path == root / name or path.is_relative_to(root / name) for name in RESERVED)


def assert_outputs(root, outputs, protected):
    """Repeat after native execution before reading any declared output."""
    checked = []
    for path in outputs:
        target = file_path(root, str(path))
        if reserved(root, target) or any(aliases(target, other) for other in [*protected, *checked]):
            raise ValueError('Outputs must not alias sources, scripts, spec, state, receipts or other outputs.')
        checked.append(target)


def load_spec(root, spec_value, state_value):
    spec_path, state_path = (file_path(root, value) for value in (spec_value, state_value))
    if aliases(spec_path, state_path) or reserved(root, spec_path) or reserved(root, state_path):
        raise ValueError('Spec and state must be distinct files outside reserved provenance directories.')
    document = read_json(spec_path)
    if not isinstance(document, dict) or document.get('schemaVersion') != 1 or not isinstance(document.get('steps'), list):
        raise ValueError('Spec must contain schemaVersion 1 and a steps array.')
    unknown = set(document) - {'schemaVersion', 'steps'}
    if unknown:
        raise ValueError(f'Unknown spec fields: {", ".join(sorted(unknown))}. Put semantics in each step context.')
    steps = {}
    for raw in document['steps']:
        if not isinstance(raw, dict):
            raise ValueError('Each step must be an object.')
        unknown = set(raw) - {'id', 'script', 'interpreter', 'inputs', 'outputs',
                              'results', 'dependsOn', 'context', 'args'}
        if unknown:
            raise ValueError(f'Unknown step fields: {", ".join(sorted(unknown))}. Put semantics in context.')
        step_id = raw.get('id')
        if not isinstance(step_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', step_id) or step_id in steps:
            raise ValueError('Step ids must be unique safe identifiers of at most 80 characters.')
        if raw.get('interpreter') not in ('python', 'r') or not isinstance(raw.get('context'), dict):
            raise ValueError('Each step needs interpreter python/r and a context object.')
        for key in ('inputs', 'outputs', 'dependsOn'):
            if not isinstance(raw.get(key), list) or not all(isinstance(item, str) for item in raw[key]):
                raise ValueError(f'{key} must be an array of strings.')
            if len(set(raw[key])) != len(raw[key]):
                raise ValueError(f'{key} must not contain duplicates.')
        if not raw['outputs'] or not isinstance(raw.get('args', []), list) or not all(isinstance(item, str) for item in raw.get('args', [])):
            raise ValueError('A step needs outputs; optional args must be strings.')
        step = dict(raw)
        for key in ('script', 'results'):
            step[key] = file_path(root, raw.get(key))
        if any(reserved(root, Path(os.path.abspath(root / item))) for item in raw['outputs']):
            raise ValueError('Outputs cannot use reserved provenance paths.')
        for key in ('inputs', 'outputs'):
            step[key] = [file_path(root, item) for item in raw[key]]
        if step['results'] not in step['outputs']:
            raise ValueError('The JSON results file must be a declared output.')
        steps[step_id] = step

    ordered, visiting, ancestors = [], set(), {}

    def visit(step_id):
        if step_id in visiting:
            raise ValueError('Step dependencies must be acyclic.')
        if step_id not in steps:
            raise ValueError('Every dependency must name a known step.')
        if step_id in ancestors:
            return
        visiting.add(step_id)
        parents = set()
        for parent in steps[step_id]['dependsOn']:
            visit(parent)
            parents.update({parent, *ancestors[parent]})
        visiting.remove(step_id)
        ancestors[step_id] = parents
        ordered.append(step_id)

    for step_id in steps:
        visit(step_id)
    outputs = [path for step in steps.values() for path in step['outputs']]
    # Use pathname ownership, not inode ownership: a hardlink to raw data is not
    # permission to reinterpret that source as a generated intermediate.
    owners = {}
    for step_id, step in steps.items():
        for path in step['outputs']:
            if path in owners:
                raise ValueError('Each output must have exactly one owner step.')
            owners[path] = step_id
    sources = [step['script'] for step in steps.values()]
    for step_id, step in steps.items():
        for path in step['inputs']:
            owner = owners.get(path)
            if owner is not None and owner not in ancestors[step_id]:
                raise ValueError('A generated input must belong to a declared dependency ancestor.')
            if owner is None:
                sources.append(path)
    protected = [spec_path, state_path, *sources]
    for path in (Path(__file__).resolve(), Path(run_analysis.__file__).resolve()):
        if path.is_relative_to(root):
            protected.append(path)
    for index, path in enumerate(protected):
        if index < 2 and any(aliases(path, source) for source in sources):
            raise ValueError('Spec and state cannot alias analysis sources or scripts.')
    assert_outputs(root, outputs, protected)
    return spec_path, state_path, steps, ordered, protected


def safe_snapshot(root, path):
    try:
        return run_analysis.snapshot(root, path)
    except (OSError, ValueError):
        return None


def hashes(root, paths):
    return {path.relative_to(root).as_posix(): safe_snapshot(root, path) for path in paths}


def content(snapshot):
    return {key: snapshot[key] for key in ('path', 'sha256', 'size')} if snapshot else None


def read_state(path):
    if not path.exists():
        return {'schemaVersion': 1, 'steps': {}, 'history': []}, 'missing'
    try:
        state = read_json(path)
        if (not isinstance(state, dict) or state.get('schemaVersion') != 1
                or not isinstance(state.get('steps'), dict) or not isinstance(state.get('history'), list)
                or not all(isinstance(item, dict) for item in state['history'])):
            raise ValueError('Invalid state shape.')
        for record in state['steps'].values():
            if (not isinstance(record, dict) or not isinstance(record.get('reusable'), bool)
                    or not isinstance(record.get('outputs'), dict) or not isinstance(record.get('receipt'), str)
                    or not isinstance(record.get('signature'), str) or not isinstance(record.get('executionId'), str)):
                raise ValueError('Invalid step state.')
            if any(value is not None and (not isinstance(value, dict)
                    or not isinstance(value.get('path'), str) or not isinstance(value.get('sha256'), str)
                    or not isinstance(value.get('size'), int)) for value in record['outputs'].values()):
                raise ValueError('Invalid output state.')
        return state, 'valid'
    except (OSError, ValueError, UnicodeError, RecursionError):
        return None, 'invalid'


def receipt_attempt(root, receipt, execution_id):
    try:
        ledger = read_json(file_path(root, receipt))
        if not isinstance(ledger, dict) or ledger.get('schemaVersion') != 1 or not isinstance(ledger.get('executions'), list):
            return None
        # A crash after the runner writes a newer attempt must not resurrect an
        # older successful state, even if the newer attempt left output intact.
        latest = ledger['executions'][-1] if ledger['executions'] else None
        return latest if isinstance(latest, dict) and latest.get('id') == execution_id else None
    except (OSError, ValueError, UnicodeError, RecursionError):
        return None


# An undefined value (a p-value in a degenerate subgroup, a mean of nothing) is a
# normal result: the runner stores it as null, keeps the raw file in provenance
# and records this warning. It stays visible in status and never blocks reuse.
ADVISORY_WARNING_CODES = frozenset({'nonfinite'})


def good_attempt(attempt):
    return (isinstance(attempt, dict) and attempt.get('exitCode') == 0
            and attempt.get('sourcesUnchanged') is True
            and all(isinstance(item, dict) and item.get('code') in ADVISORY_WARNING_CODES
                    for item in attempt.get('warnings') or [])
            and isinstance(attempt.get('output'), dict) and attempt['output'].get('observedWrite') is True)


def advisories(attempt):
    items = attempt.get('warnings') if isinstance(attempt, dict) else None
    return [{'code': item['code'], 'field': item.get('field')} for item in (items or [])
            if isinstance(item, dict) and item.get('code') in ADVISORY_WARNING_CODES][:20]


def inspect(root, spec_value, state_value):
    spec_path, state_path, steps, ordered, protected = load_spec(root, spec_value, state_value)
    state, state_status = read_state(state_path)
    runtime_versions, statuses = {}, {}
    helper_hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest()
                     for name, path in (('continuity', __file__), ('runner', run_analysis.__file__))}
    for step_id in ordered:
        step = steps[step_id]
        interpreter = step['interpreter']
        if interpreter not in runtime_versions:
            executable = sys.executable if interpreter == 'python' else shutil.which('Rscript')
            try:
                runtime_versions[interpreter] = run_analysis.versions(interpreter, executable) if executable else None
            except (OSError, subprocess.SubprocessError, ValueError):
                runtime_versions[interpreter] = None
        sources = hashes(root, [step['script'], *step['inputs']])
        outputs = hashes(root, step['outputs'])
        parts = {'schemaVersion': 1, 'id': step_id, 'interpreter': interpreter, 'helpers': helper_hashes,
                 'sources': {key: content(value) for key, value in sources.items()},
                 'outputs': list(outputs), 'results': step['results'].relative_to(root).as_posix(),
                 'args': step.get('args', []), 'context': step['context'], 'versions': runtime_versions[interpreter],
                 'dependencies': {parent: {'signature': statuses[parent]['signature'],
                    'outputs': {key: content(value) for key, value in statuses[parent]['outputs'].items()}}
                    for parent in step['dependsOn']}}
        signature = digest(parts)
        reasons = []
        if any(value is None for value in sources.values()):
            reasons.append('source_missing_or_unreadable')
        if runtime_versions[interpreter] is None:
            reasons.append('runtime_unavailable')
        if any(not statuses[parent]['reusable'] for parent in step['dependsOn']):
            reasons.append('dependency_not_reusable')
        record = state['steps'].get(step_id) if state else None
        warnings = []
        if state_status != 'valid':
            reasons.append(f'state_{state_status}')
        elif not record or not record['reusable']:
            reasons.append('no_successful_execution')
        elif record['signature'] != signature:
            reasons.append('signature_changed')
        if record:
            if (set(record['outputs']) != set(outputs) or any(value is None or value['size'] == 0
                    or content(value) != content(record['outputs'].get(key)) for key, value in outputs.items())):
                reasons.append('outputs_changed_or_missing')
            attempt = receipt_attempt(root, record['receipt'], record['executionId'])
            if not good_attempt(attempt):
                reasons.append('execution_receipt_unverified')
            warnings = advisories(attempt)
        statuses[step_id] = {'id': step_id, 'signature': signature, 'reusable': not reasons,
                             'reasons': reasons, 'outputs': outputs, 'context': step['context'],
                             'executionId': record['executionId'] if record else None,
                             'warnings': warnings}
    result = {'schemaVersion': 1, 'state': state_status, 'steps': [statuses[key] for key in steps]}
    return result, (spec_path, state_path, steps, ordered, protected, state)


def session_status(workspace, spec, state):
    root = run_analysis.resolved(Path(workspace), strict=True)
    return inspect(root, spec, state)[0]


def run_step(args):
    root = run_analysis.resolved(Path(args.workspace), strict=True)
    status, details = inspect(root, args.spec, args.state)
    spec_path, state_path, steps, _, protected, state = details
    if state is None:
        raise ValueError('State is corrupt; retain it and use a new state path or restore a verified copy.')
    if args.step not in steps:
        raise ValueError('Unknown step.')
    current = {item['id']: item for item in status['steps']}
    row, step = current[args.step], steps[args.step]
    if row['reusable'] and not args.force:
        print(json.dumps({'action': 'reused', 'step': args.step, 'executionId': row['executionId']}))
        return 0
    if any(not current[parent]['reusable'] for parent in step['dependsOn']):
        raise ValueError('Dependencies are not reusable; explicitly run stale upstream steps first.')
    receipt = root / '.analysis-session-receipts' / f'{args.step}.json'
    # Receipts are also protected from path aliases before the existing runner
    # reads its ledger. Never read an arbitrary file through a reserved symlink.
    receipt = file_path(root, str(receipt))
    if receipt.parent != root / '.analysis-session-receipts' or any(aliases(receipt, path) for path in [*protected, *(path for item in steps.values() for path in item['outputs'])]):
        raise ValueError('Receipt path aliases a protected file.')
    parent = None
    if receipt.exists():
        ledger = read_json(receipt)
        if not isinstance(ledger, dict) or not isinstance(ledger.get('executions'), list):
            raise ValueError('Receipt is not an execution ledger.')
        if ledger['executions']:
            parent = ledger['executions'][-1].get('id')
    before_outputs = hashes(root, step['outputs'])
    before_protected = hashes(root, protected)
    before_state = safe_snapshot(root, state_path)
    transforms = [str(path) for path in (spec_path, state_path) if path.exists()]
    runner_args = argparse.Namespace(workspace=str(root), interpreter=step['interpreter'],
        script=str(step['script']), input=[str(path) for path in step['inputs']],
        transform=transforms, results=str(step['results']), receipt=str(receipt),
        arg=step.get('args', []), parent=parent)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exit_code = run_analysis.execute(runner_args)
    summary = json.loads(output.getvalue())
    attempt = receipt_attempt(root, summary['receipt'], summary['execution'])
    reasons = []
    if exit_code != 0 or not good_attempt(attempt):
        reasons.append('execution_not_reusable')
    try:
        assert_outputs(root, [path for item in steps.values() for path in item['outputs']], protected)
        after_outputs = hashes(root, step['outputs'])
    except (OSError, ValueError):
        after_outputs = {path.relative_to(root).as_posix(): None for path in step['outputs']}
        reasons.append('output_path_unsafe')
    if any(value is None or value['size'] == 0 or value == before_outputs[key] for key, value in after_outputs.items()):
        reasons.append('outputs_not_observed_written')
    try:
        if 'output_path_unsafe' not in reasons:
            read_json(step['results'])
    except (OSError, ValueError, UnicodeError, RecursionError):
        reasons.append('results_not_finite_json')
    after_protected = hashes(root, protected)
    if any(content(value) != content(after_protected[key]) for key, value in before_protected.items()):
        reasons.append('sources_or_context_changed')
    try:
        after_status = session_status(root, args.spec, args.state)
        after_row = next(item for item in after_status['steps'] if item['id'] == args.step)
        if after_row['signature'] != row['signature']:
            reasons.append('signature_changed_during_execution')
    except (OSError, ValueError, UnicodeError, RecursionError, StopIteration):
        reasons.append('spec_unreadable_after_execution')
    record = {'step': args.step, 'signature': row['signature'], 'reusable': not reasons,
              'executionId': summary['execution'], 'receipt': summary['receipt'],
              'outputs': after_outputs, 'context': step['context'], 'reasons': reasons,
              'recordedAt': datetime.now(timezone.utc).isoformat()}
    state['steps'][args.step] = record
    state['history'].append(record)
    # A native script or another invocation must not make us overwrite its new
    # state. Retain this attempt in a separate, safe recovery file instead.
    if safe_snapshot(root, state_path) != before_state:
        record['reusable'] = False
        record['reasons'].append('state_changed_during_execution')
        state_path = root / f'analysis-session-state-{uuid.uuid4().hex}.json'
    write_protected = [path for path in protected if path != state_path]
    write_protected.extend(path for item in steps.values() for path in item['outputs'])
    try:
        run_analysis.write_bytes(root, state_path, run_analysis.encoded(state), write_protected)
    except (OSError, ValueError):
        record['reusable'] = False
        record['reasons'].append('state_path_unsafe')
        state_path = root / f'analysis-session-state-{uuid.uuid4().hex}.json'
        run_analysis.write_bytes(root, state_path, run_analysis.encoded(state), write_protected, create_only=True)
    print(json.dumps({'action': 'executed', 'step': args.step, 'executionId': summary['execution'],
                      'reusable': record['reusable'], 'reasons': record['reasons'],
                      'warnings': advisories(attempt),
                      'receipt': summary['receipt'], 'state': state_path.relative_to(root).as_posix()}))
    return 0 if record['reusable'] else exit_code or 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('status', 'run'):
        subparser = commands.add_parser(command)
        for name in ('workspace', 'spec', 'state'):
            subparser.add_argument(f'--{name}', required=True)
        if command == 'run':
            subparser.add_argument('--step', required=True)
            subparser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'status':
            print(json.dumps(session_status(args.workspace, args.spec, args.state), allow_nan=False))
            return 0
        return run_step(args)
    except (OSError, ValueError, UnicodeError, RecursionError) as error:
        print(f'Analysis continuity refused: {type(error).__name__}: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
