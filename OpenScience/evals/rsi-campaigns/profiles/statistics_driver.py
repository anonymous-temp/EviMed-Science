"""Fixed stdin/stdout bridge; never loads a caller-selected module or executes code."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
if len(raw) > 16 * 1024 * 1024:
    raise ValueError('statistics input too large')
value = json.loads(raw)
spec = importlib.util.spec_from_file_location('campaign_statistics', Path(__file__).resolve().parents[1] / 'statistics.py')
statistics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(statistics)
if value['receipt'].get('registration_digest') == 'bound-by-runner':
    value['receipt']['registration_digest'] = statistics.registration_digest(value['registration'])
result = statistics.evaluate(value['registration'], value['observations'], value['receipt'])
print(json.dumps({'inputSha256': hashlib.sha256(raw).hexdigest(), 'result': result}, allow_nan=False))
