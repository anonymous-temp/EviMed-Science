#!/usr/bin/env python3
"""Compare observed G1 wire evidence without copying prompts, answers or memory text into the aggregate."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import mean


def read(file):
    return json.loads(Path(file).read_text())


def answers(directory, users):
    rows = {}
    for user in users:
        file = Path(directory) / 'cases' / user / 'answers.jsonl'
        if file.exists():
            rows.update((r['qid'], r) for r in map(json.loads, file.read_text().splitlines()) if r)
    return rows


def observed(answer):
    calls = answer.get('toolCalls', [])
    searches = []
    for call in calls:
        if call.get('name') != 'mcp__openviking__search':
            continue
        decoded, suffix_chars = [], 0
        for block in call.get('blocks', []):
            if not isinstance(block, str):
                continue
            try:
                value, end = json.JSONDecoder().raw_decode(block.lstrip())
            except ValueError:
                suffix_chars += len(block)
                continue
            suffix_chars += len(block.lstrip()[end:])
            if isinstance(value, dict):
                decoded.append(value.get('result', value))
        hits = [r for result in decoded if isinstance(result, dict) for kind in ['memories', 'resources', 'skills'] for r in result.get(kind, []) if isinstance(r, dict)]
        # Strip account namespaces; equal paths still do not establish equal contents.
        paths = [r['uri'].split('/memories/', 1)[1] for r in hits if isinstance(r.get('uri'), str) and '/memories/' in r['uri']]
        query = str(call.get('args', {}).get('query', ''))
        searches.append({'querySha256': hashlib.sha256(query.encode()).hexdigest(), 'hits': len(hits), 'memoryPaths': paths,
                         'appendedTextChars': suffix_chars, 'jsonObjects': len(decoded), 'isError': call.get('isError', False)})
    usage = answer.get('usage', {})
    native = answer.get('opening', {}).get('profileBlock') or ''
    resident = answer.get('opening', {}).get('residentBlock') or ''
    opening = native + '\n' + resident
    result = {'openingChars': len(opening), 'openingSha256': hashlib.sha256(opening.encode()).hexdigest(),
              'nativeProfileChars': len(native), 'residentMemoryChars': len(resident),
              'openingHasAvailableMemories': '<available-memories>' in native, 'calls': len(calls),
              'memoryCalls': sum(c.get('name', '').startswith('mcp__openviking__') for c in calls), 'searches': searches,
              'inputTokens': usage.get('promptTokens', usage.get('inputTokens')), 'outputTokens': usage.get('completionTokens', usage.get('outputTokens')),
              'wallMs': answer.get('wallMs', answer.get('ms'))}
    request = answer.get('evidence', {}).get('firstRequest')
    if request and Path(request).exists():
        first = read(request)
        result['toolsOffered'] = sorted(t.get('function', {}).get('name', t.get('name', '')) for t in first.get('tools', []))
    return result


def main():
    p = argparse.ArgumentParser()
    for name in ['selection', 'engine', 'runs', 'out']:
        p.add_argument('--' + name, required=True)
    args = p.parse_args()
    sample = read(args.selection)
    engine = answers(args.engine, sample['users'])
    product = {}
    for directory in args.runs.split(','):
        product.update(answers(directory, sample['users']))
    pairs = []
    for question in sample['questions']:
        qid = question['qid']
        if qid not in product or qid not in engine:
            continue
        a, b = observed(engine[qid]), observed(product[qid])
        ap = {p for s in a['searches'] for p in s['memoryPaths']}
        bp = {p for s in b['searches'] for p in s['memoryPaths']}
        pairs.append({'qid': qid, 'category': question['category'], 'engine': a, 'product': b,
                      'bothSearched': bool(a['searches'] and b['searches']),
                      'querySequenceEqual': [s['querySha256'] for s in a['searches']] == [s['querySha256'] for s in b['searches']],
                      'resultPathJaccard': len(ap & bp) / len(ap | bp) if ap | bp else None})
    metrics = ['openingChars', 'nativeProfileChars', 'residentMemoryChars', 'calls', 'memoryCalls', 'inputTokens', 'outputTokens', 'wallMs']
    summary = {k: {arm: mean(p[arm][k] for p in pairs if p[arm][k] is not None) if any(p[arm][k] is not None for p in pairs) else None
                   for arm in ['engine', 'product']} for k in metrics}
    both = [p for p in pairs if p['bothSearched']]
    summary.update({'completed': len(pairs), 'bothSearched': len(both), 'differentQuerySequencesWhenBothSearched': sum(not p['querySequenceEqual'] for p in both),
                    'productToolsOffered': sorted({t for p in pairs for t in p['product'].get('toolsOffered', [])}),
                    'openingAvailableMemoriesCounts': {arm: sum(p[arm]['openingHasAvailableMemories'] for p in pairs) for arm in ['engine', 'product']}})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'g1-behavior.json').write_text(json.dumps({'summary': summary, 'pairs': pairs, 'limitations': [
        'Observed normalized answer records only; no unasked placeholder is compared.', 'Equal memory paths do not imply equal contents or correct recall.',
        'Search query differences are observed behavior, not an isolated causal estimate of any switch.',
        'Product wall time includes the control-plane run wait; engine time has a different scope. Shared-host timing is not a production benchmark.']}, indent=1))
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
