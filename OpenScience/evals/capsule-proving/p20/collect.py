"""Collect unchanged harness scores and per-material-kind counts from the lab; no model calls.

python3 evals/capsule-proving/p20/collect.py --runs /srv/evimed/runs --data /srv/evimed/data/memdata-data
"""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runs', type=Path, required=True)
parser.add_argument('--data', type=Path, required=True)
args = parser.parse_args()

def read(path):
    return json.loads(path.read_text())

def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def counts(rows):
    return {'n': len(rows), 'pass': sum(r['verdict'] == 'pass' for r in rows),
            'fail': sum(r['verdict'] == 'fail' for r in rows),
            'other': sum(r['verdict'] not in ('pass', 'fail') for r in rows)}

items = read(args.data / 'g9-dev/input.json')['items']
kinds = {item['itemId']: '+'.join(sorted({attachment['kind'] for session in item['sessions'] for attachment in session.get('attachments', [])})) or item['kind'] for item in items}
report = {'developmentOnly': True, 'model': 'deepseek-flash', 'answerThinking': 'enabled',
          'g8Judge': 'deepseek-flash, thinking disabled; unchanged remembered-format scorer',
          'g9Judge': 'qwen3.8-max; unchanged engine-layer scorer from /srv/evimed/repo/OpenScience',
          'g8': {}, 'g9': {}, 'scenarios': {}}
report['g8']['baseline'] = {'run': 'gx-g8-1', 'thinking': 'enabled',
                            'summary': read(args.runs / 'gx-g8-1/summary.json')['settings']['enabled']['summary']}
for arm in ['a', 'b', 'c']:
    root = args.runs / ('p20-g8-' + arm)
    if not (root / 'summary.json').exists():
        report['g8'][arm] = {'incomplete': True}
        continue
    cells = lines(root / 'cells.jsonl')
    retry = root / 'incomplete-attempts.jsonl'
    report['g8'][arm] = {'run': str(root), 'metadata': read(root / 'run.json'),
                         'summary': read(root / 'summary.json')['current'],
                         'cellCount': len(cells), 'cellsSha256': digest(root / 'cells.jsonl'),
                         'initialIncompleteAttempts': len(lines(retry)) if retry.exists() else 0,
                         'errors': sum(bool(r.get('error')) for r in cells)}
for set_name, run_name in [('g9', 'r3-g9-dev-cand-1'), ('scenarios', 'r3-scenarios-dev-cand-1')]:
    root = args.runs / run_name
    for variant in ['baseline', 'material', 'material2', 'material3']:
        suffix = '' if variant == 'baseline' else '.' + variant
        scores = root / ('scores' + suffix)
        if not (scores / 'summary.json').exists():
            report[set_name][variant] = {'incomplete': True}
            continue
        summary = read(scores / 'summary.json')
        rows = [r for r in lines(scores / 'rows.jsonl') if r['kind'] == 'answer']
        grouped = {}
        for row in rows:
            kind = kinds[row['caseId']] if set_name == 'g9' else row['category']
            grouped.setdefault(kind, []).append(row)
        report[set_name][variant] = {'run': str(root), 'variant': variant, 'answers': summary['answers'],
                                    'byCategory': summary['sets'][set_name]['byCategory'],
                                    'byItemKind': {kind: counts(group) for kind, group in sorted(grouped.items())},
                                    'failures': [r['id'] for r in rows if r['verdict'] == 'fail'],
                                    'rowsSha256': digest(scores / 'rows.jsonl'),
                                    'scorer': summary['schema']}
print(json.dumps(report, ensure_ascii=False, indent=2))
