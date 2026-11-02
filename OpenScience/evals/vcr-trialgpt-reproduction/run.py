"""Frozen 2x2 model/missingness experiment over upstream TrialGPT prompts."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'vcr-model-comparison'))
from api import ProviderClient, digest, model_matches, request_digest, write_json

ARMS = {'original_flash': ('deepseek-v4-flash', False),
        'original_pro': ('deepseek-v4-pro', False),
        'strict_flash': ('deepseek-v4-flash', True),
        'strict_pro': ('deepseek-v4-pro', True),
        'reasoned_pro': ('deepseek-v4-pro', False)}


def payload(row, arm):
    model, strict = ARMS[arm]
    return {'model': model, 'temperature': 0, 'thinking': {'type': 'enabled' if arm=='reasoned_pro' else 'disabled'},
            'max_tokens': 8192, 'stream': False,
            'response_format': {'type': 'json_object'},
            'messages': [{'role': 'system', 'content': row['strict_system'] if strict else row['system']},
                         {'role': 'user', 'content': row['user']}]}


def label(row, arm):
    return arm + '-' + digest(row['id'])[:20]


def freeze(prepared, out, arms=None):
    arms = list(arms or [a for a in ARMS if a != 'reasoned_pro'])
    rows = json.loads((prepared / 'requests.json').read_text())
    manifest = json.loads((prepared / 'manifest.json').read_text())
    protocol = {'version': 1, 'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'prepared_sha256': hashlib.sha256((prepared / 'requests.json').read_bytes()).hexdigest(),
                'manifest_sha256': hashlib.sha256((prepared / 'manifest.json').read_bytes()).hexdigest(),
                'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'api_sha256': hashlib.sha256((HERE.parent / 'vcr-model-comparison/api.py').read_bytes()).hexdigest(),
                'arms': {a:ARMS[a] for a in arms}, 'dev_patients': manifest['dev_patients'], 'evaluation_patients': manifest['evaluation_patients'],
                'requests': {label(r,a): request_digest('deepseek', payload(r,a)) for r in rows for a in arms},
                'adaptations': ['Original pure prompt functions from pinned upstream.', 'Annotation-aligned criterion units with original full trial background.',
                                'JSON response mode, thinking disabled and bounded8192output tokens on both models.',
                                'Strict arms replace only absence inference instructions.'],
                'scoring': 'Expert labels primary, stored GPT4 answers historical control; all1015 retained,3 upstream-parser omissions; same pre-existing10/43 patient groups; public regression not clinical holdout.',
                'failures': 'One first request per label. Provider errors and malformed outputs stay in denominator; no answer tuning retries.',
                'budget': 'Shared DeepSeek receipt directory, CNY50; returned usage replaces reserves; uncertain calls retain reserve.'}
    f = out / 'FROZEN.json'
    if f.exists() and json.loads(f.read_text()) != protocol:
        raise ValueError('An existing frozen protocol differs')
    write_json(f, protocol)
    return protocol


def run(prepared, out, arms):
    protocol = json.loads((out / 'FROZEN.json').read_text())
    if hashlib.sha256((prepared / 'requests.json').read_bytes()).hexdigest() != protocol['prepared_sha256']:
        raise ValueError('Frozen request source differs')
    if hashlib.sha256((prepared / 'manifest.json').read_bytes()).hexdigest() != protocol['manifest_sha256']:
        raise ValueError('Frozen prepared manifest differs')
    rows = json.loads((prepared / 'requests.json').read_text())
    client = ProviderClient(out / 'receipts')
    def one(row, arm):
        body, ident = payload(row, arm), label(row, arm)
        if request_digest('deepseek', body) != protocol['requests'][ident]:
            raise ValueError('Frozen payload differs')
        return client.request('deepseek', ARMS[arm][0], body, ident)
    # Real first probes are retained; do not dispatch a mass auth/model failure.
    for arm in arms:
        result = one(rows[0], arm)
        print(json.dumps({'probe':arm,'status':result['status'],'error':result['error']}),flush=True)
        if result['error']:
            raise ValueError('First model probe failed; inspect retained receipt')
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(one,row,arm):(row,arm) for row in rows[1:] for arm in arms}
        done = len(arms)
        for future in as_completed(futures):
            result = future.result()
            done += 1
            if done % 20 == 0 or result['error']:
                print(json.dumps({'completed':done,'total':len(rows)*len(arms),'error':result['error']}),flush=True)
            if result['status'] in (401,402,403):
                for pending in futures: pending.cancel()
                raise ValueError('Provider credentials/payment refused; stopped')


def score_all(prepared, out, gold_file):
    from score import score
    protocol = json.loads((out / 'FROZEN.json').read_text())
    if hashlib.sha256((prepared / 'requests.json').read_bytes()).hexdigest() != protocol['prepared_sha256']:
        raise ValueError('Scoring input freeze mismatch')
    if hashlib.sha256((prepared / 'manifest.json').read_bytes()).hexdigest() != protocol['manifest_sha256']:
        raise ValueError('Scoring manifest freeze mismatch')
    rows = json.loads((prepared / 'requests.json').read_text())
    target = json.loads((out / 'TARGETS.json').read_text())
    if hashlib.sha256(gold_file.read_bytes()).hexdigest() != target['gold_sha256']:
        raise ValueError('Reference targets differ from their bound bytes')
    if target['protocol_sha256'] != hashlib.sha256((out / 'FROZEN.json').read_bytes()).hexdigest():
        raise ValueError('Target/protocol binding differs')
    gold = json.loads(gold_file.read_text())
    if not isinstance(gold,list) or len(gold)!=1015 or len({r['annotation_id'] for r in gold})!=1015:
        raise ValueError('Expected the full 1015 reference annotations')
    results = {}
    for arm in protocol['arms']:
        bodies, receipts = {}, []
        for row in rows:
            ident = label(row,arm)
            p = out / 'receipts' / (ident+'.json')
            if not p.exists():continue
            receipt = json.loads(p.read_text()); receipts.append(receipt)
            if (receipt['request_sha256'] != protocol['requests'][ident] or receipt['requested_model'] != ARMS[arm][0]):
                raise ValueError('Receipt input/model ownership mismatch')
            if receipt['error'] or receipt['status'] !=200:continue
            if not model_matches('deepseek',ARMS[arm][0],receipt['body'].get('model')):
                raise ValueError('Served model mismatch')
            bodies[row['id']] = receipt['body']
        measures = {part:score(rows,bodies,gold,patients) for part,patients in [('all',None),('dev',protocol['dev_patients']),('evaluation',protocol['evaluation_patients'])]}
        measures['requests'] = {'attempted':len(receipts),'expected':len(rows),'failed':sum(bool(r['error']) for r in receipts),
                                'cost_cny':sum(r['cost'] or 0 for r in receipts),'billing_unknown':sum(r['cost'] is None for r in receipts),
                                'served_models':sorted({r['body']['model'] for r in receipts if isinstance(r.get('body'),dict) and 'model' in r['body']})}
        results[arm] = measures
    write_json(out/'summary.json',results)
    return results


if __name__ == '__main__':
    p=argparse.ArgumentParser()
    p.add_argument('mode',choices=['freeze','run','score','bind-targets'])
    p.add_argument('--prepared',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--arms',nargs='+',choices=list(ARMS))
    p.add_argument('--gold',type=Path)
    a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    if a.mode=='bind-targets':
        frozen=json.loads((a.out/'FROZEN.json').read_text())
        manifest=json.loads((a.prepared/'manifest.json').read_text())
        if hashlib.sha256((a.prepared/'manifest.json').read_bytes()).hexdigest()!=frozen['manifest_sha256']:
            raise ValueError('Prepared manifest differs')
        acquired=HERE.parents[2]/'.evimed-local/acceptance/vcr-benchmark-20261029/matching/inputs/trialgpt-all-criteria.json'
        if hashlib.sha256(acquired.read_bytes()).hexdigest()!=manifest['input_sha256']:
            raise ValueError('Acquired model inputs differ')
        truth=json.loads(a.gold.read_text()); original=json.loads(acquired.read_text())
        fields=set(original[0])
        if not isinstance(truth,list) or len(truth)!=1015 or [{k:r[k] for k in fields} for r in truth]!=original:
            raise ValueError('Reference does not belong to the frozen model inputs')
        target={'gold_sha256':hashlib.sha256(a.gold.read_bytes()).hexdigest(),
                'input_sha256':manifest['input_sha256'],
                'protocol_sha256':hashlib.sha256((a.out/'FROZEN.json').read_bytes()).hexdigest(),
                'bound_at_epoch':time.time(),
                'timing':'Targets bound before new scoring, after inference began; this is previously used public regression data.'}
        destination=a.out/'TARGETS.json'
        if destination.exists():
            old=json.loads(destination.read_text())
            if any(old[k]!=target[k] for k in ['gold_sha256','input_sha256','protocol_sha256']):raise ValueError('Existing targets differ')
        else:write_json(destination,target)
        print('Reference targets bound; no scoring performed')
    elif a.mode=='freeze':print(json.dumps({'requests':len(freeze(a.prepared,a.out,a.arms)['requests'])}))
    elif a.mode=='run':run(a.prepared,a.out,a.arms or list(json.loads((a.out/'FROZEN.json').read_text())['arms']))
    else:
        result=score_all(a.prepared,a.out,a.gold)
        print(json.dumps({k:{part:v[part].get('accuracy') for part in ['all','dev','evaluation']} for k,v in result.items()},indent=2))
