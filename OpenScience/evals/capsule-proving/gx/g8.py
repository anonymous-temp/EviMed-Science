"""Run the existing paired instrument with explicit product answer settings; keep its scorer unchanged."""
import concurrent.futures as cf
import hashlib
import json
import sys
import time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'evals/remembered-format'))
import remembered_format as rf
import run as runner
OUT = Path('/srv/evimed/runs/gx-g8-1')
OUT.mkdir(parents=True, exist_ok=True)
key = Path('/srv/evimed/secrets/deepseek.api-key').read_text().strip()
cases = rf.load_cases()
assert len(cases) == 30 and not [p for c in cases for p in rf.case_issues(c)]
texts = rf.load_texts(model='deepseek-flash')
arm = rf.arms_from(texts, cases, ['current'], None)['current']
original_request = rf.request_body
summary = {'automated': True, 'model': 'deepseek-flash', 'judgeModel': 'deepseek-flash', 'samples': 3,
           'referenceInvented': 58, 'referenceN': 90, 'settings': {},
           'promptAudit': {'personaSha256': hashlib.sha256(texts['persona'].encode()).hexdigest(),
             'guidanceSha256': hashlib.sha256(texts['guidance'].encode()).hexdigest(),
             'source': 'remembered-format/texts.mjs imports checkout buildGuidanceText and persona preset',
             'limits': 'Simulated memory and read exchange; not a full kernel session. See prompt-audit.json.'}}
for mode in ['enabled', 'disabled']:
    start = time.time()
    def request(case, variant, arm, model):
        body = original_request(case, variant, arm, model)
        body['thinking'] = {'type': mode}
        if mode == 'enabled': body['reasoning_effort'] = 'high'
        return body
    rf.request_body = request
    rows = []
    rowfile = OUT / ('cells-' + mode + '.jsonl')
    if rowfile.exists():
        with rowfile.open() as f:
            rows = [json.loads(line) for line in f if line.strip()]
    done = {(r['case'], r['variant'], r['sample']) for r in rows}
    jobs = [(c,v,i) for c in cases for v in ('full','partial') for i in range(3) if (c['id'],v,i) not in done]
    def one(job):
        usages = []
        def post(body, key):
            # Judge stays identical in both arms, explicitly non-thinking for stable bounded calls.
            if 'thinking' not in body: body = {**body, 'thinking': {'type':'disabled'}}
            response = rf.post(body,key)
            usages.append(response.get('usage', {}))
            return response
        row = runner.run_cell(job[0], job[1], arm, job[2], 'deepseek-flash', 'deepseek-flash', key, post=post)
        return {**row, 'usage': usages}
    with rowfile.open('a') as output, cf.ThreadPoolExecutor(max_workers=2) as pool:
        for row in pool.map(one,jobs):
            rows.append(row); output.write(json.dumps(row,ensure_ascii=False)+'\n'); output.flush()
            with (OUT/'STATUS').open('a') as f: f.write(f'{mode} DONE {row["case"]} {row["variant"]} {row["sample"]}\n')
    summary['settings'][mode] = {'summary': rf.summarize(rows)['current'], 'cells': len(rows),
      'errors': sum(bool(r.get('error')) for r in rows), 'judgeUnreadable': sum(r.get('judgeReadable') is False for r in rows),
      'wallSeconds': time.time()-start,
      'usage': {'prompt': sum(u.get('prompt_tokens',0) for r in rows for u in r['usage']),
                'completion': sum(u.get('completion_tokens',0) for r in rows for u in r['usage']),
                'cached': sum(u.get('prompt_cache_hit_tokens',0) for r in rows for u in r['usage'])}}
    (OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(mode,json.dumps(summary['settings'][mode]),flush=True)
