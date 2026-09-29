#!/usr/bin/env python3
"""Record native Python/R execution. No method selection or dependency installation.

This is provenance, not a sandbox or proof of numerical correctness. The runtime
owns process isolation; the generated script must keep source data unchanged.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid


def confined(root: Path, value: str) -> Path:
    path = (root / value).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Path must be a file inside the workspace.')
    return path


def snapshot(root: Path, path: Path):
    path = confined(root, str(path))
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        stat = os.fstat(stream.fileno())
    return {'path': path.relative_to(root).as_posix(), 'sha256': digest.hexdigest(),
            'size': stat.st_size, 'mtimeNs': stat.st_mtime_ns, 'ctimeNs': stat.st_ctime_ns,
            'inode': stat.st_ino}


def distinct_outputs(root: Path, outputs: tuple, sources: list):
    for output in outputs:
        confined(root, str(output))
        for other in sources + [item for item in outputs if item != output]:
            if output == other or (output.exists() and other.exists() and output.samefile(other)):
                raise ValueError('Outputs must not replace source, script, state or each other.')
    if outputs[0] == outputs[1]:
        raise ValueError('Results and receipt must be distinct files.')


def write_bytes(root: Path, path: Path, data: bytes, protected: list):
    """One writer for every artifact: protect inputs and anchor atomic replacement.

    Resolving a target authorizes it but does not authorize following a new link
    later. Directory descriptors keep replacement in the checked parent, and
    O_NOFOLLOW refuses parents replaced by a script or concurrent process.
    """
    def check_target():
        target = confined(root, str(path))
        for source in protected:
            if target == source.resolve() or (target.exists() and source.exists() and target.samefile(source)):
                raise ValueError('Artifact write would replace a protected analysis file.')

    check_target()
    parts = path.relative_to(root).parts
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    temporary = f'.analysis-{uuid.uuid4().hex}.tmp'
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
        check_target()
        os.replace(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def encoded(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def finite(value, warnings, field='$'):
    if isinstance(value, float) and not math.isfinite(value):
        warnings.append({'field': field, 'code': 'nonfinite', 'message': 'Non-finite output retained in raw provenance; represented as null.'})
        return None
    if isinstance(value, dict):
        return {key: finite(item, warnings, f'{field}.{key}') for key, item in value.items()}
    if isinstance(value, list):
        return [finite(item, warnings, f'{field}[{index}]') for index, item in enumerate(value)]
    return value


def versions(interpreter: str, executable: str):
    if interpreter == 'python':
        return {'interpreter': sys.version, 'libraries': dict(sorted(
            (dist.metadata['Name'], dist.version) for dist in importlib.metadata.distributions()
            if dist.metadata['Name']))}
    # Only version metadata, never a process environment or analysis stdout.
    query = 'cat(R.version.string,"\\n",sep=""); p<-installed.packages(); write.table(p[,c("Package","Version")],stdout(),sep="\\t",row.names=FALSE,col.names=FALSE,quote=FALSE)'
    result = subprocess.run([executable, '--vanilla', '-e', query], capture_output=True, text=True, check=True)
    lines = result.stdout.splitlines()
    return {'interpreter': lines[0], 'libraries': dict(line.split('\t', 1) for line in lines[1:] if '\t' in line)}


def execute(args) -> int:
    root = Path(args.workspace).resolve(strict=True)
    script = confined(root, args.script)
    inputs = [confined(root, value) for value in args.input]
    transforms = [confined(root, value) for value in args.transform]
    results, receipt = (confined(root, value) for value in (args.results, args.receipt))
    sources = [script, *inputs, *transforms]
    for path in sources:
        if not path.is_file():
            raise ValueError('Script, input and transformation files must exist.')
    distinct_outputs(root, (results, receipt), sources)
    ledger = json.loads(receipt.read_text()) if receipt.exists() else {'schemaVersion': 1, 'executions': []}
    if not isinstance(ledger, dict) or ledger.get('schemaVersion') != 1 or not isinstance(ledger.get('executions'), list):
        raise ValueError('Existing receipt is not an execution ledger; retain it and use a different receipt path.')
    if args.parent and not any(item.get('id') == args.parent for item in ledger['executions']):
        raise ValueError('Parent must name an execution in this receipt.')
    executable = sys.executable if args.interpreter == 'python' else shutil.which('Rscript')
    argv = [executable or 'Rscript', *(['--vanilla'] if args.interpreter == 'r' else []), str(script), *args.arg]
    attempt = {'id': uuid.uuid4().hex, 'parent': args.parent, 'argv': argv,
               'script': snapshot(root, script), 'inputs': [snapshot(root, item) for item in inputs],
               'transforms': [snapshot(root, item) for item in transforms],
               'startedAt': datetime.now(timezone.utc).isoformat(), 'warnings': []}
    before = snapshot(root, results)
    before_artifact = None
    if before is not None:
        backup = confined(root, f'.analysis-provenance/{attempt["id"]}-previous-results.json')
        write_bytes(root, backup, results.read_bytes(), sources + [results, receipt])
        before_artifact = snapshot(root, backup)
    try:
        if executable is None:
            raise FileNotFoundError('Rscript is unavailable')
        attempt['versions'] = versions(args.interpreter, executable)
        completed = subprocess.run(argv, cwd=root, shell=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        attempt['exitCode'] = completed.returncode
    except (OSError, subprocess.SubprocessError) as error:
        attempt['exitCode'] = 127
        attempt['warnings'].append({'code': 'execution_unavailable', 'message': type(error).__name__})
    attempt['endedAt'] = datetime.now(timezone.utc).isoformat()
    output_error = False
    try:
        # A native script may replace an authorized path with a symlink/hardlink.
        # Recheck aliases before reading or normalizing through that path.
        distinct_outputs(root, (results, receipt), sources)
        after = snapshot(root, results)
    except (OSError, ValueError) as error:
        after = None
        output_error = True
        attempt['warnings'].append({'code': 'output_unreadable', 'message': type(error).__name__})
    wrote = after is not None and before != after
    observation = ('unreadable' if output_error else 'missing' if after is None else 'created' if before is None else
                   'unchanged' if not wrote else 'rewritten_same_bytes' if before['sha256'] == after['sha256'] else 'changed')
    attempt['output'] = {'before': before, 'after': after, 'observation': observation, 'observedWrite': wrote}
    if before_artifact is not None:
        attempt['output']['beforeArtifact'] = before_artifact
    if wrote:
        raw = results.read_bytes()
        try:
            value = json.loads(raw)
            clean = finite(value, attempt['warnings'])
            if any(item.get('code') == 'nonfinite' for item in attempt['warnings']):
                raw_path = confined(root, f'.analysis-provenance/{attempt["id"]}-results.raw.json')
                write_bytes(root, raw_path, raw, sources + [results, receipt])
                attempt['output']['raw'] = snapshot(root, raw_path)
                write_bytes(root, results, encoded(clean), sources + [receipt])
                attempt['output']['normalized'] = snapshot(root, results)
        except (OSError, UnicodeError, ValueError, RecursionError) as error:
            attempt['warnings'].append({'code': 'results_unreadable', 'message': type(error).__name__})
    source_after = []
    for item in sources:
        try:
            source_after.append(snapshot(root, item))
        except (OSError, ValueError):
            source_after.append(None)
    source_before = [attempt['script'], *attempt['inputs'], *attempt['transforms']]
    attempt['sourcesUnchanged'] = all(a and b and a['sha256'] == b['sha256'] for a, b in zip(source_before, source_after))
    if not attempt['sourcesUnchanged']:
        attempt['sourcesAfter'] = source_after
        attempt['warnings'].append({'code': 'source_changed', 'message': 'A script, input or transformation changed during execution; inspect provenance before reusing state.'})
    ledger['executions'].append(attempt)
    try:
        write_bytes(root, receipt, encoded(ledger), sources + [results])
    except (OSError, ValueError):
        # Never retry an unsafe destination. A root-level artifact also avoids
        # any provenance directory the child replaced with a symlink.
        receipt = root / f'analysis-receipt-{uuid.uuid4().hex}.json'
        output_error = True
        attempt['warnings'].append({'code': 'receipt_path_unsafe', 'message': 'The requested receipt path became unsafe; this attempt and prior records are retained in the returned receipt path.'})
        write_bytes(root, receipt, encoded(ledger), sources + [results])
    print(json.dumps({'execution': attempt['id'], 'exitCode': attempt['exitCode'], 'outputObservation': observation, 'receipt': receipt.relative_to(root).as_posix()}))
    if output_error and attempt['exitCode'] == 0:
        return 2
    return attempt['exitCode'] if attempt['exitCode'] >= 0 else 128 - attempt['exitCode']


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--interpreter', choices=['python', 'r'], required=True)
    parser.add_argument('--script', required=True)
    parser.add_argument('--input', action='append', required=True)
    parser.add_argument('--results', required=True)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--arg', action='append', default=[])
    parser.add_argument('--parent')
    parser.add_argument('--transform', action='append', default=[])
    try:
        return execute(parser.parse_args())
    except (OSError, ValueError) as error:
        print(f'Analysis operation refused: {type(error).__name__}: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
