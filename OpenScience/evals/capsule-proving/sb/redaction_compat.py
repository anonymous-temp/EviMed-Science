"""Bound BenchFlow 0.6.3's quadratic generic credential-name scan.

This changes trajectory serialization only. Token values remain redacted; the
leading identifier boundary avoids restarting an unbounded name scan at every
character of long noncredential identifiers. Agent and verifier code is untouched.
"""
import hashlib
import pathlib
import re
from importlib.metadata import version


def apply():
    from benchflow.trajectories import types
    if version('benchflow') != '0.6.3':
        raise ValueError('Review the logging compatibility patch for this BenchFlow version')
    prefix = r'("?[A-Za-z0-9_]*(?:TOKEN|SECRET)'
    boundary = r'(?<![A-Za-z0-9_])'
    changed = []
    for index, (pattern, replacement) in enumerate(types._REDACTION_PATTERNS):
        if pattern.pattern.startswith(prefix):
            safe = re.compile(boundary + pattern.pattern, pattern.flags)
            types._REDACTION_PATTERNS[index] = safe, replacement
            changed.append({'before': pattern.pattern, 'after': safe.pattern})
        elif pattern.pattern.startswith(boundary + prefix):
            changed.append({'before': pattern.pattern[len(boundary):], 'after': pattern.pattern})
    if len(changed) != 1:
        raise ValueError('BenchFlow generic redaction pattern changed; review before running')
    return {'benchflow': version('benchflow'), 'sourceSha256': hashlib.sha256(pathlib.Path(types.__file__).read_bytes()).hexdigest(),
            'scope': 'Trajectory secret-redaction serialization only', 'patterns': changed}
