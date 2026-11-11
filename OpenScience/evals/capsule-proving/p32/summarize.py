"""Build the small reviewable P32 receipt from preserved lab evidence; never overwrite raw runs."""
import collections
import hashlib
import json
import math
import random
from pathlib import Path

BASE=Path('/srv/evimed/runs')
HERE=Path(__file__).resolve().parent

def load(name):
    return [json.loads(line) for line in (BASE/name/'scores.jsonl').read_text().splitlines() if line.strip()]

def groups(rows):
    result={}
    for arm,variant in sorted({(r['arm'],r['variant']) for r in rows}):
        group=[r for r in rows if (r['arm'],r['variant'])==(arm,variant)]
        result[f'{arm}/{variant}']={'n':len(group),'fabricating':sum(r['fabricating'] is True for r in group),
          'unusable':sum(r['fabricating'] is None for r in group),
          'allGivenLexical':sum(r['lexicalGiven']['found']==r['lexicalGiven']['total'] for r in group),
          'allGivenSemantic':sum(r['verdict']['allGiven'] for r in group)}
    return result

def paired(rows,left,right):
    by=collections.defaultdict(dict)
    for r in rows:
        if r['arm'] in (left,right): by[(r['case'],r['sample'])][r['arm']]=r['fabricating']
    valid={k:v for k,v in by.items() if all(v.get(a) is not None for a in (left,right))}
    clusters=collections.defaultdict(list)
    for (case,_),v in valid.items(): clusters[case].append(int(v[left])-int(v[right]))
    values=list(clusters.values()); rng=random.Random(20261111)
    differences=[]
    for _ in range(10000):
        sample=[d for group in rng.choices(values,k=len(values)) for d in group]
        differences.append(sum(sample)/len(sample))
    differences.sort()
    b=sum(v[left] and not v[right] for v in valid.values())
    c=sum(v[right] and not v[left] for v in valid.values())
    n=b+c
    p=min(1,2*sum(math.comb(n,i) for i in range(min(b,c)+1))/2**n) if n else 1
    return {'left':left,'right':right,'usablePairs':len(valid),'leftOnly':b,'rightOnly':c,
            'rateDifference':sum(d for ds in values for d in ds)/len(valid),
            'caseClusterBootstrap95':[differences[249],differences[9749]],
            'mcnemarExactPUnclustered':p,'warning':'Three samples share one fixture; bootstrap resamples fixtures. Overlap is not proof of equivalence.'}

def compact(rows):
    return [{**{k:r[k] for k in ('arm','case','variant','sample','fabricating')}, 'allGivenLexical':r['lexicalGiven']['found']==r['lexicalGiven']['total'], 'allGivenSemantic':r['verdict']['allGiven']} for r in rows]

def main():
    controls=load('p32-controls-v3'); historical=load('p32-gx-v3'); product=load('p32-product-grounded'); calibration=load('p32-calibration-v3')
    answers=[json.loads(line) for line in (BASE/'p32-controls/answers.jsonl').read_text().splitlines()]
    assert (len(answers),len(historical),len(product),len(calibration))==(270,180,20,30), 'incomplete measurement'
    key=lambda r:(r['arm'],r['case'],r['variant'],r['sample'])
    assert len({key(r) for r in controls})==len(controls), 'duplicate verdicts'
    missing=sorted({key(r) for r in answers}-{key(r) for r in controls})
    assert len(controls)+len(missing)==270, 'unexpected verdicts'
    control_table=groups(controls)
    for value in control_table.values():
        value['scored']=value['n'];value['n']=90;value['unjudged']=90-value['scored']
    audit=json.loads((HERE/'hand-audit.json').read_text())
    cal={(r['case'],r['sample']):r for r in calibration}
    agreements=collections.Counter()
    for r in audit['rows']:
        if r['verdict'] in ('real','benign'):
            expected=r['verdict']=='real'; actual=cal[(r['case'],r['sample'])]['fabricating']
            agreements['truePositive' if actual and expected else 'falsePositive' if actual else 'falseNegative' if expected else 'trueNegative']+=1
    sample={r['case'] for r in product}
    engine=[r for r in controls if r['arm']=='recalled' and r['sample']==0 and r['case'] in sample]
    source_names=['p32-controls','p32-controls-v3','p32-gx-rescore','p32-gx-v3','p32-calibration','p32-calibration-v3','p32-product-score','p32-product-grounded']
    hashes={name:hashlib.sha256((BASE/name/'scores.jsonl').read_bytes()).hexdigest() for name in source_names}
    report={'lane':'P32/p10','automated':True,'productBehaviorChanged':False,
      'reference':{'source':'evals/remembered-format/results/2026-10-25-current+pre-1025+conditional-method-deepseek-flash.json',
        'arm':'current','fabricating':58,'n':90,'meaning':'Historical simulated-memory arm, never a no-memory control; answer/judge thinking implicit.'},
      'controls':control_table,'unjudgedControls':missing,'paired':paired(controls,'recalled','pasted'),'withoutFormat':paired(controls,'recalled','none'),
      'gxSameAnswersRescored':groups(historical),'firstQwenRubricControls':groups(load('p32-controls')),
      'handRead':audit['split'],'calibrationAgreementExcludingAmbiguousAndInvalid':dict(agreements),
      'calibrationLimitation':'The manual audit informed rubric development; this is calibration, not independent judge validation.',
      'productSample':{'product':groups(product),'sameItemsEngine':groups(engine),'lockIsolation':True,
        'seedRoute':'POST /api/memory/remember; native extraction, then automated answer turn',
        'withMemoryReads':sum(bool(r['memoryReads']) for r in product),'withArtifacts':sum(bool(r['artifacts']) for r in product),
        'runStatuses':dict(collections.Counter(r['runStatus'] for r in product)),
        'attemptExcluded':'p32-product: automated seed turn correctly refused long-term writes; no usable recalled-format exposure.',
        'knownScorerDisagreements':[{'case':'grant-paragraph','qwen':False,'manualConcern':'The supplied facts establish a cohort and some preliminary experiments, not a specimen bank, complete workflows or technical facilities. The draft asserts those outside blanks.'},{'case':'project-progress','qwen':True,'manualConcern':'The status is explicitly marked as provisional and awaiting confirmation inline; the rubric excludes clearly labelled assumptions.'}],
        'comparisonLimits':'Automated turns carry the product instruction to finish with labelled assumptions; GX omits it. First 20 fixture cases, sample 0. Real native memory/tool use and full kernel prompt versus forced GX context; not a single-variable kernel ablation.'},
      'conclusion':{'verified':'Invention occurs without memory and with a pasted format; all twenty product cases completed with real memory reads. Native storage fixtures contain formats, not filled examples.',
        'inference':'This corpus supports a general drafting failure rather than a memory-specific increase. No new capsule behavior is justified by these controls.',
        'scorerLimits':'Qwen still misses unsupported assertions around blanks and sometimes penalizes labelled assumptions/general knowledge. Exact quote checks verify evidence location, not semantic truth.',
        'remaining':'General drafting fabrication is unresolved. No product remedy or on/off scenario acceptance is claimed.'},
      'acceptance':{'featureAccepted':False,'reason':'No product candidate; diagnostics and scorer changes only. Revised rates must not be presented as a reduction caused by a product fix.',
        'redLine':'Memory must not worsen fabrication relative to the same request with the format supplied by the person.',
        'historicalFullLexical':83,'targetPartial':36,'scenariosOnOff':'Not run: no behavior switch or product code change.'},
      'balanceBeforeFirstRead':'2026-11-11T05:08:04Z balance 1864.20',
      'balanceBefore':json.loads((BASE/'p32-controls/metadata.json').read_text())['balanceBefore'],
      'balanceAfter':(BASE/'BUDGET-LAST').read_text().strip(),'spendCaveat':'Shared DeepSeek balance movement, not isolated lane spend; Qwen billed separately.',
      'evidenceSha256':hashes,'tests':{'p32':7,'existingRememberedFormat':26,'nodeSyntaxCheck':True,'shellSyntaxCheck':True},
      'rows':compact(controls)+compact(historical)+compact(product),
    }
    (HERE/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ('rows','evidenceSha256')},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
