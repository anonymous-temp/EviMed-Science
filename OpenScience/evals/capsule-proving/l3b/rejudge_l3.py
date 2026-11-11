#!/usr/bin/env python3
"""Offline targeted re-judgment of immutable old L3 records; preserve every unrelated check and old Qwen verdict."""
import argparse
import copy
import json
import sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
SUITE=HERE.parent.parent/'general-tasks'
sys.path.insert(0,str(SUITE/'judges'))
import checks

def main():
    p=argparse.ArgumentParser(); p.add_argument('--root',type=Path,default=Path('/srv/evimed/runs')); p.add_argument('--out',type=Path,required=True); args=p.parse_args()
    cases={r['id']:r for r in json.loads((SUITE/'cases.json').read_text())['cases']}
    truth=json.loads((SUITE/'fixtures/ground_truth.json').read_text()); report={}
    for arm in 'ABDEF':
        folder=args.root/f'l3-{arm}-1'; rows=[]
        for file in sorted((folder/'records').glob('exam-*.json')):
            record=json.loads(file.read_text()); id=record['cell']; old=json.loads((folder/'judged'/file.name).read_text())['entries'][id]
            new=copy.deepcopy(old); replacements=[]
            ctx=checks.Ctx(cases[id],record,file.with_name(file.stem+'.files'),SUITE/'fixtures',truth)
            for spec in cases[id].get('checks',[]):
                if spec['type']=='numbers_from_source' or (spec['type']=='reply_forbidden' and 'medical_disclaimer' in spec['kinds']) or spec['type']=='weekly':
                    if spec['type']=='reply_forbidden':spec={**spec,'kinds':['medical_disclaimer']}
                    replacements.extend(checks.CHECKS[spec['type']](spec,ctx))
            byid={r['id']:r for r in replacements}; new['checks']=[byid.get(r['id'],r) for r in new['checks']]
            required=[r for r in new['checks'] if r['required']]; failed=[r['id'] for r in required if r['ok'] is False]
            new.update(failedChecks=failed,required=len(required),passed=sum(r['ok'] is True for r in required),status='fail' if failed else 'unjudged' if any(r['ok'] is None for r in required) else 'pass')
            semantic=json.loads((folder/'model-judged'/file.name).read_text()).get('entries',{}).get(id,{})
            composite=lambda e: e['status']=='pass' and semantic.get('verdict')=='satisfied'
            row=dict(name=file.stem,old=old['status'],new=new['status'],oldComposite=composite(old),newComposite=composite(new),
                     removedFailures=[c for c in old['failedChecks'] if c not in failed],remainingFailures=failed,semanticVerdict=semantic.get('verdict'),
                     semanticIssues=semantic.get('issues'),replacements=replacements)
            rows.append(row)
            dst=args.out/arm/file.name; dst.parent.mkdir(parents=True,exist_ok=True); dst.write_text(json.dumps(new,ensure_ascii=False,indent=2)+'\n')
        report[arm]=dict(n=len(rows),oldComposite=sum(r['oldComposite'] for r in rows),newComposite=sum(r['newComposite'] for r in rows),
                         oldDeterministic=sum(r['old']=='pass' for r in rows),newDeterministic=sum(r['new']=='pass' for r in rows),
                         flips=[r for r in rows if r['old']!=r['new'] or r['oldComposite']!=r['newComposite']], changed=[r for r in rows if r['removedFailures']])
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out/'summary.json').write_text(json.dumps(dict(arms=report,modelCalls=0,note='Old Qwen verdicts retained, including possible influence from old automatic-check context. New deterministic passes do not override a semantic failure. Question phrases are advisory; no new semantic verdict fabricated.'),ensure_ascii=False,indent=2)+'\n')
    for a,r in report.items():print(a,r['oldComposite'],'->',r['newComposite'],'/',r['n'],'deterministic',r['oldDeterministic'],'->',r['newDeterministic'])
if __name__=='__main__':main()
