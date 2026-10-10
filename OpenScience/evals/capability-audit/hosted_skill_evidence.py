"""Verify bounded native skill tasks from retained, scoped DSH observations.

A prompt injection certifies only the observed bounded method. It is never
reported as native skill-loader, full-package or current production-image proof.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def retained(repo: Path, receipt: dict) -> Path:
    path = repo / receipt.get('path', '')
    resolved = path.resolve()
    if path.is_symlink() or not resolved.is_relative_to(repo.resolve()) or not path.is_file():
        raise ValueError('receipt must name a retained regular repository file')
    if path.stat().st_size <= 0 or path.stat().st_size != receipt.get('bytes') or digest(path) != receipt.get('sha256'):
        raise ValueError('receipt bytes or digest mismatch')
    return path


def assertion(repo: Path, item: dict, outputs: set[str]) -> bool:
    """Re-evaluate task content assertions, rather than trust passed booleans."""
    receipt = item.get('artifact', {})
    if receipt.get('path') not in outputs:
        raise ValueError('content assertion must target a retained task output')
    path = retained(repo, receipt)
    if item.get('operation') in ('contains', 'excludes'):
        expected = item.get('value')
        if not isinstance(expected, str) or not expected:
            raise ValueError('content assertion requires nonempty expected text')
        present = expected in path.read_text(encoding='utf-8')
        return present if item['operation'] == 'contains' else not present
    if item.get('operation') == 'json-equals':
        value = json.loads(path.read_text(encoding='utf-8'))
        keys = item.get('keys')
        if not isinstance(keys, list) or not keys:
            raise ValueError('JSON assertion requires a key path')
        for key in keys:
            value = value[key]
        return value == item.get('value')
    raise ValueError('unsupported content assertion')


def validate_row(repo: Path, package: dict, row: dict) -> dict:
    identifier = package['id']
    if row.get('packageId') != identifier or row.get('manifestSha256') != package['manifestSha256'] or row.get('passed') is not True:
        raise ValueError('current skill manifest mismatch or task failed')
    manifest = repo / package['manifest']
    body = manifest.read_text(encoding='utf-8')
    scope = row.get('scope', {})
    if any(not isinstance(scope.get(key), str) or not scope[key] for key in ('projectId', 'workspaceRelativePath', 'sessionId', 'runId')):
        raise ValueError('complete hosted task scope is required')
    workspace = (repo / scope['workspaceRelativePath']).resolve()
    # Workspace may later be archived outside the source tree. The retained
    # scope remains relative and fenced; output artifacts are retained here.
    if not workspace.is_relative_to(repo.resolve()) or Path(scope['workspaceRelativePath']).is_absolute():
        raise ValueError('workspace scope escapes repository')
    run = json.loads(retained(repo, row.get('runReceipt', {})).read_text())
    if 'data' in run:
        run = run['data']
    if run.get('id') != scope['runId'] or run.get('sessionId') != scope['sessionId'] or run.get('status') != 'succeeded':
        raise ValueError('task is not bound to a successful observed hosted run')
    if run.get('projectId') is not None:
        if run['projectId'] != scope['projectId']:
            raise ValueError('run project scope mismatch')
    else:
        # Hosted run records intentionally omit projectId. Bind the real
        # request's project selection to its observed session registry instead
        # of inventing a field on the run response.
        registry = json.loads(retained(repo, row.get('sessionRegistryReceipt', {})).read_text())
        request = registry.get('request', {})
        if request != {'method': 'GET', 'path': '/api/research-sessions', 'projectId': scope['projectId']}:
            raise ValueError('session registry request scope mismatch')
        sessions = registry.get('response')
        if isinstance(sessions, dict) and 'data' in sessions:
            sessions = sessions['data']
        if not isinstance(sessions, list) or not any(item.get('sessionId') == scope['sessionId'] for item in sessions):
            raise ValueError('successful run session is absent from scoped project registry')
        projects = json.loads(retained(repo, row.get('projectReceipt', {})).read_text())
        if isinstance(projects, dict) and 'data' in projects:
            projects = projects['data']
        if not isinstance(projects, list):
            projects = [projects]
        if not any(item.get('id') == scope['projectId'] for item in projects):
            raise ValueError('project scope is absent from observed authenticated projects')
    transcript = json.loads(retained(repo, row.get('transcriptReceipt', {})).read_text())
    if 'data' in transcript:
        transcript = transcript['data']
    if transcript.get('sessionId') != scope['sessionId']:
        raise ValueError('transcript session scope mismatch')
    messages = transcript.get('messages', [])
    parts = [(message, part) for message in messages for part in message.get('parts', [])]
    dispatch = row.get('dispatch', {})
    body_path = retained(repo, dispatch.get('bodyReceipt', {}))
    if body_path.read_bytes() != manifest.read_bytes():
        raise ValueError('loaded body must preserve exact current skill bytes')
    kind = dispatch.get('kind')
    if kind == 'control-plane-injected':
        if not any(message.get('role') == 'user' and part.get('type') == 'text' and body in part.get('text', '') for message, part in parts):
            raise ValueError('full skill body is absent from observed prompt')
    elif kind == 'native-skill-tool':
        reads = [part for _, part in parts if part.get('type') == 'tool' and part.get('status') == 'completed' and not part.get('error') and part.get('callId') == dispatch.get('loadCallId')]
        if len(reads) != 1:
            raise ValueError('native skill loading call is absent or ambiguous')
        loaded = reads[0]
        if loaded.get('tool') != 'skill':
            raise ValueError('native loading requires the observed native skill tool; a file read is not loader proof')
        content = '\n'.join(line['text'] for line in loaded.get('meta', {}).get('lines', []))
        if content.rstrip('\n') != body.rstrip('\n') and body not in str(loaded.get('output', '')):
            raise ValueError('observed skill load does not contain exact current body')
    elif kind == 'delegated-skill-tool':
        raise ValueError('delegated dispatch requires child scope evidence; prompt injection must not impersonate it')
    else:
        raise ValueError('unsupported dispatch kind')
    inputs = row.get('inputReceipts', [])
    artifacts = row.get('artifacts', [])
    if not inputs or not artifacts:
        raise ValueError('bounded method requires preserved input and output')
    for receipt in inputs + artifacts:
        retained(repo, receipt)
    outputs = {receipt['path'] for receipt in artifacts}
    executions = row.get('toolExecutions', [])
    if not executions:
        raise ValueError('reading instructions alone is not method execution')
    method_seen = False
    method_outputs = set()
    for execution in executions:
        matches = [part for _, part in parts if part.get('type') == 'tool' and part.get('callId') == execution.get('callId')]
        if len(matches) != 1:
            raise ValueError('tool execution is absent or ambiguous')
        part = matches[0]
        if part.get('tool') != execution.get('name') or part.get('status') != 'completed' or part.get('error') or execution.get('status') != 'succeeded':
            raise ValueError('claimed tool execution did not succeed')
        # A read/list alone only establishes availability, never the method.
        method_operation = part.get('tool') not in ('read', 'list', 'glob', 'grep', 'skill') and part.get('callId') != dispatch.get('loadCallId')
        if method_operation:
            method_seen = True
        for receipt in execution.get('outputReceipts', []):
            retained(repo, receipt)
            if receipt.get('path') not in outputs:
                raise ValueError('tool output must be retained as a task artifact')
            relative = receipt.get('workspaceRelativePath')
            if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or '..' in Path(relative).parts:
                raise ValueError('tool output requires a fenced workspace path')
            observed = relative in json.dumps(part, ensure_ascii=False)
            # A literal observed shell cwd plus a quoted exact basename binds
            # the same workspace file; do not execute or expand shell syntax.
            if not observed and part.get('tool') == 'bash':
                command = part.get('input', {}).get('command', '')
                cwd = '/workspace/' + str(Path(relative).parent)
                prefix = re.match(r'\A\s*cd\s+([A-Za-z0-9_./-]+)\s*&&', command)
                basename = Path(relative).name
                observed = bool(prefix and prefix.group(1) == cwd and any(quote + basename + quote in command for quote in ("'", '"')))
            if not observed:
                raise ValueError('claimed output path is absent from actual tool observation')
            if method_operation:
                method_outputs.add(receipt['path'])
    if not method_seen:
        raise ValueError('no actual method operation beyond instruction reading')
    if outputs != method_outputs:
        raise ValueError('every task output must be bound to an actual successful method operation')
    assertions = row.get('assertions', [])
    if not assertions or not all(assertion(repo, item, outputs) for item in assertions):
        raise ValueError('bounded output content assertions failed or absent')
    return {'packageId': identifier, 'dispatch': kind, 'state': 'bounded-hosted-task-matched', 'currentImageExecution': 'unknown', 'fullPackageExecution': 'unknown'}


def coverage(repo: Path, document: dict, composition: dict) -> dict[str, dict]:
    if document.get('schemaVersion') != 1:
        raise ValueError('unsupported hosted skill receipt schema')
    packages = {item['id']: item for item in composition['packages']}
    observed = datetime.fromisoformat(str(document.get('finishedAt')).replace('Z', '+00:00'))
    if observed.tzinfo is None or observed > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError('hosted observation timestamp is absent or in the future')
    rows = document.get('packages', [])
    identifiers = [row.get('packageId') for row in rows]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError('duplicate hosted skill receipts')
    valid = {}
    for row in rows:
        identifier = row.get('packageId')
        if identifier not in packages:
            raise ValueError('receipt names an unshipped skill')
        valid[identifier] = validate_row(repo, packages[identifier], row)
    return valid
