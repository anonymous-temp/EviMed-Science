"""Measure opt-in guidance with the unchanged paired scorer and retain reasoning for diagnosis.

Run on the lab: python3 evals/capsule-proving/p20/remembered-format.py --out DIR
  [--config memoryFormatGroundingEnabled=true] [--diagnose /srv/evimed/runs/gx-g8-1/cells-enabled.jsonl]
Outputs are resumable; use a new directory for each prompt revision. At most four model calls run concurrently.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'evals/remembered-format'))
import remembered_format as rf
import run as runner

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--config', action='append', default=[])
parser.add_argument('--diagnose', type=Path)
parser.add_argument('--retry-incomplete', action='store_true')
args = parser.parse_args()
config = dict((key, json.loads(value)) for key, value in (item.split('=', 1) for item in args.config))
args.out.mkdir(parents=True, exist_ok=True)
key = Path('/srv/evimed/secrets/deepseek.api-key').read_text().strip()
cases = rf.load_cases()
assert len(cases) == 30 and not [p for c in cases for p in rf.case_issues(c)]
texts = json.loads(subprocess.check_output(['node', str(ROOT / 'evals/remembered-format/texts.mjs'), '--config', json.dumps(config)], cwd=ROOT))
arm = rf.arms_from(texts, cases, ['current'], None)['current']
selected = {}
if args.diagnose:
    for row in map(json.loads, args.diagnose.read_text().splitlines()):
        if row['variant'] == 'partial' and row.get('invented') and row['case'] not in selected:
            selected[row['case']] = row['sample']
        if len(selected) == 20:
            break
jobs = ([(c, 'partial', selected[c['id']]) for c in cases if c['id'] in selected] if args.diagnose else
        [(c, v, i) for c in cases for v in ('full', 'partial') for i in range(3)])
metadata = {'automated': True, 'config': config, 'diagnose': str(args.diagnose) if args.diagnose else None,
            'model': 'deepseek-flash', 'thinking': 'enabled', 'reasoningEffort': 'high',
            'judgeModel': 'deepseek-flash', 'judgeThinking': 'disabled', 'workers': 4,
            'guidanceSha256': hashlib.sha256(texts['guidance'].encode()).hexdigest(),
            'personaSha256': hashlib.sha256(texts['persona'].encode()).hexdigest()}
meta = args.out / 'run.json'
if meta.exists():
    assert json.loads(meta.read_text()) == metadata, 'changed prompt: use a new output directory'
else:
    meta.write_text(json.dumps(metadata, indent=2) + '\n')
(args.out / 'texts.json').write_text(json.dumps(texts, ensure_ascii=False, indent=2) + '\n')
rowfile = args.out / 'cells.jsonl'
rows = [json.loads(line) for line in rowfile.read_text().splitlines()] if rowfile.exists() else []
if args.retry_incomplete:
    incomplete = [r for r in rows if r.get('noText') or r.get('pass') is None]
    with (args.out / 'incomplete-attempts.jsonl').open('a') as attempts:
        for row in incomplete:
            attempts.write(json.dumps(row, ensure_ascii=False) + '\n')
    rows = [r for r in rows if not r.get('noText') and r.get('pass') is not None]
    rowfile.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))
done = {(r['case'], r['variant'], r['sample']) for r in rows}
jobs = [job for job in jobs if (job[0]['id'], job[1], job[2]) not in done]
original_request = rf.request_body

def request(case, variant, arm, model):
    return {**original_request(case, variant, arm, model), 'thinking': {'type': 'enabled'}, 'reasoning_effort': 'high'}

rf.request_body = request

def one(job):
    usages, reasoning = [], []
    def post(body, key):
        is_answer = 'thinking' in body
        response = rf.post(body if is_answer else {**body, 'thinking': {'type': 'disabled'}}, key)
        usages.append(response.get('usage', {}))
        if is_answer:
            reasoning.append(response.get('choices', [{}])[0].get('message', {}).get('reasoning_content', ''))
        return response
    row = runner.run_cell(job[0], job[1], arm, job[2], 'deepseek-flash', 'deepseek-flash', key, post=post)
    return {**row, 'reasoning': reasoning, 'usage': usages}

with rowfile.open('a') as output, cf.ThreadPoolExecutor(max_workers=4) as pool:
    futures = [pool.submit(one, job) for job in jobs]
    for future in cf.as_completed(futures):
        row = future.result()
        rows.append(row)
        output.write(json.dumps(row, ensure_ascii=False) + '\n')
        output.flush()
        print('DONE', len(rows), row['case'], row['variant'], row['sample'], flush=True)
summary = rf.summarize(rows)
(args.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(runner.table(summary), flush=True)
