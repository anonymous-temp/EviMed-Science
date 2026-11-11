#!/usr/bin/env python3
"""Paired descriptive report. Exact McNemar is reported with an explicit repeated-account dependence warning."""
import argparse
import json
import math
from pathlib import Path


def wilson(k, n):
    if not n:
        return None
    z=1.959963984540054; p=k/n; d=1+z*z/n
    mid=(p+z*z/(2*n))/d; half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return [mid-half, mid+half]

def mcnemar(a, b):
    keys=sorted(a.keys() & b.keys())
    gain=sum(not a[k] and b[k] for k in keys); loss=sum(a[k] and not b[k] for k in keys)
    n=gain+loss
    return dict(n=len(keys), gain=gain, loss=loss, difference=(gain-loss)/len(keys) if keys else None,
                exactP=(min(1, 2*sum(math.comb(n,i) for i in range(min(gain,loss)+1))/2**n) if n else 1) if keys else None)

def rate(values):
    n=len(values); k=sum(values)
    return dict(passed=k, n=n, rate=k/n if n else None, wilson95=wilson(k,n))

def read(file, default=None):
    return json.loads(file.read_text()) if file.exists() else default

def arm_report(root, arm):
    out=root/f'l3b-{arm}-1'; rows=[]; judge_usage=dict(inputTokens=0,outputTokens=0,estimatedCostCny=0)
    learn=read(out/'learning-complete.json', {})
    methods=learn.get('state',{}).get('methods',[])
    trace=[]
    for f in sorted((out/'records').glob('learning-*.json')):
        r=read(f); ids={t.get('runId') for t in r['turns']}
        associated=[]
        for method in methods:
            p=method['payload']; prov=p.get('provenance',{})
            sources={prov.get('runId'), *prov.get('sourceRunIds',[]), *[e.get('runId') for e in prov.get('evidence',[])]}
            if sources & ids:
                associated.append(dict(id=method['id'], status=p.get('status'), name=p.get('name') or p.get('frontmatter',{}).get('name')))
        trace.append(dict(id=r['id'], methods=associated, learned=bool(associated), approved=any(m['status']=='approved' for m in associated), mounted=0, opened=0))
    for f in sorted((out/'records').glob('exam-*.json')):
        r=read(f); s=read(out/'judged'/f.name, {})
        judge_usage['inputTokens'] += s.get('usage',{}).get('prompt_tokens',0)
        judge_usage['outputTokens'] += s.get('usage',{}).get('completion_tokens',0)
        judge_usage['estimatedCostCny'] += s.get('estimatedCostCny',0)
        mounted=[]; opened=[]
        for t in r['turns']:
            obs=t.get('methodObservation') or t.get('run') or {}
            mounted.extend(obs.get('methodsLoaded',[])); opened.extend(obs.get('methodsInvoked',[]))
        row=dict(id=r['id'],rep=r['rep'],passed=s.get('passed'),behavior=s.get('behavior'),quality=s.get('quality'),
                 profile=r.get('memory',{}).get('profileBlockPresent'), preferencePresent=s.get('preferencePresent'),
                 searched=len(r.get('memory',{}).get('searchCalls',[]))>0,
                 searchSucceeded=any(not t.get('error') for t in r.get('memory',{}).get('searchCalls',[])), mounted=mounted, opened=opened)
        rows.append(row)
        for t in trace:
            if t['id'] != r['id']:
                continue
            ids={m['id'] for m in t['methods']}; names={m['name'] for m in t['methods'] if m['name']}
            for key, observed in [('mounted',mounted),('opened',opened)]:
                t[key] += int(any((m.get('id') or m.get('methodId')) in ids or m.get('name') in names for m in observed if isinstance(m,dict)))
    paired=[r for r in rows if r['id'].startswith('P')]; controls=[r for r in rows if r['id'].startswith('U')]
    scores={(r['id'],r['rep']):r['passed'] for r in paired if type(r['passed']) is bool}
    behavior={(r['id'],r['rep']):r['behavior'] for r in paired if type(r['behavior']) is bool}
    majority={}
    for id in sorted({r['id'] for r in paired}):
        vals=[r['passed'] for r in paired if r['id']==id and type(r['passed']) is bool]
        if len(vals)==3: majority[id]=sum(vals)>=2
    return dict(arm=arm,paired=rate(list(scores.values())),behavior=rate(list(behavior.values())),
                ordinaryQuality=rate([r['quality'] for r in paired if type(r['quality']) is bool]),
                controls=rate([r['passed'] for r in controls if type(r['passed']) is bool]),
                unknown=sum(r['passed'] is None for r in rows), recorded=len(rows), expected=54, missingRecords=max(0,54-len(rows)),
                trace=trace, correctionsLearned=sum(t['learned'] for t in trace), correctionsApproved=sum(t['approved'] for t in trace),
                correctionsMounted=sum(t['mounted']>0 for t in trace), correctionsOpened=sum(t['opened']>0 for t in trace),
                memory=dict(profile=sum(bool(r['profile']) for r in paired), relevantPreference=sum(r['preferencePresent'] is True for r in paired), searchAttempted=sum(r['searched'] for r in paired), searchSucceeded=sum(r['searchSucceeded'] for r in paired), n=len(paired)),
                usage=read(out/'account-usage.json'), judgeUsage=judge_usage, learningComplete=bool(learn), complete=(out/'complete.json').exists(), rows=rows), scores, behavior, majority

def main():
    p=argparse.ArgumentParser(); p.add_argument('--root',type=Path,default=Path('/srv/evimed/runs')); p.add_argument('--out',type=Path)
    args=p.parse_args(); arms={}; maps={}; behaviors={}; majorities={}
    for a in 'ABCD': arms[a],maps[a],behaviors[a],majorities[a]=arm_report(args.root,a)
    for a in 'BCD':
        arms[a]['vsA']=mcnemar(maps['A'],maps[a])
        arms[a]['behaviorVsA']=mcnemar(behaviors['A'],behaviors[a])
        arms[a]['rep1VsA']=mcnemar({k:v for k,v in maps['A'].items() if k[1]==1},{k:v for k,v in maps[a].items() if k[1]==1})
        arms[a]['caseMajorityVsA']=mcnemar(majorities['A'],majorities[a])
    arms['C']['vsB']=mcnemar(maps['B'],maps['C'])
    for a in 'BCD':
        base={(r['id'],r['rep']):r['passed'] for r in arms['A']['rows'] if r['id'].startswith('U') and type(r['passed']) is bool}
        candidate={(r['id'],r['rep']):r['passed'] for r in arms[a]['rows'] if r['id'].startswith('U') and type(r['passed']) is bool}
        arms[a]['controlsVsA']=mcnemar(base,candidate)
    report=dict(arms=arms, uncertainty='Wilson and exact McNemar on 36 repeated exams are descriptive: repetitions share one account per arm and 12 task pairs. Report rep-1 and case-majority sensitivities; population inference needs independent accounts. C versus B isolates added method learning; C versus A combines memory and learning.',
                judgeCost='Qwen token usage and CNY estimated from the repository reference price list are saved per verdict; provider-billed CNY is not returned. DeepSeek account ledger includes learning; shared balance delta is a conservative envelope, not lane-specific attribution.')
    target=args.out or args.root/'l3b-report.json'; target.write_text(json.dumps(report,indent=2)+'\n')
    for a,r in arms.items():
        print(a, 'paired',r['paired'],'controls',r['controls'],'unknown',r['unknown'],'vsA',r.get('vsA'))
if __name__=='__main__':main()
