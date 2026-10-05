#!/usr/bin/env python3
"""Operator-only method ruler. Runs actual production statistics against frozen independent references."""
import argparse,hashlib,json,math,pathlib,re,subprocess,sys,platform
import importlib.metadata
from datetime import datetime,timezone
executed_at=datetime.now(timezone.utc).isoformat()
p=argparse.ArgumentParser();p.add_argument('evaluation_dir');p.add_argument('method_id');a=p.parse_args()
if not re.fullmatch('[A-Za-z0-9_-]{1,100}',a.method_id):raise ValueError('Invalid method identity')
root=pathlib.Path(a.evaluation_dir).resolve();repo=pathlib.Path(__file__).resolve().parents[3];source=root/'paper-gold/candidate-cases'/f'{a.method_id}.json';raw=source.read_bytes();definition=json.loads(raw);assert definition['frozen'] is True and definition['methodId']==a.method_id
if a.method_id.startswith('meta-reml-published-data'):engine='meta';sys.path.insert(0,str(repo/'项目代码/meta'));from new_meta.engines.meta_engine import random_effects_reml;from new_meta.schemas.meta_result import StudyEffect
elif a.method_id.startswith('faers-ror'):engine='pharmacovigilance';sys.path.insert(0,str(repo/'项目代码/药物安全分析agent'));from safety_agent.signals.disproportionality import ror;from safety_agent.signals.tables import ContingencyTable2x2
elif a.method_id.startswith('mr-ivw-published-data'):engine='mr'
else:raise ValueError('This existing engine does not implement the frozen method family')
rows=[]
for replicate in range(2):
 for case in definition['cases']:
  i=case['input'];row={'replicate':replicate,'caseId':case['id'],'engineId':engine,'publicationId':case['publicationId'],'sourceHash':case['sourceHash'],'scope':'deterministic-method-only','fullResearchReproductionValid':False}
  if engine=='meta':
   result=random_effects_reml([StudyEffect(study_id=str(n), study_label=str(n), yi=study["yi"], vi=study["vi"], se=math.sqrt(study["vi"])) for n,study in enumerate(i['studies'])],i['effectMeasure'],case['id']).model_dump()
   actual={'pooled_log':result['pooled_log'] if result['pooled_log'] is not None else result['pooled_effect'],'ci_lower_log':result['ci_lower_log'] if result['ci_lower_log'] is not None else result['ci_lower'],'ci_upper_log':result['ci_upper_log'] if result['ci_upper_log'] is not None else result['ci_upper'],'tau_squared':result['tau_squared'],'q_statistic':result['q_statistic'],'n_studies':result['n_studies']};row['engineImplementation']='new_meta.engines.meta_engine.random_effects_reml'
  elif engine=='pharmacovigilance':
   result=ror(ContingencyTable2x2(**i));actual={'ROR':result.value,'lower':result.ci95_lower,'upper':result.ci95_upper};row['engineImplementation']='safety_agent.signals.disproportionality.ror'
  else:
   if i.get('correlation') is not None:
    rows.append({**row,'passed':False,'unsupported':'correlated-IVW-not-implemented-by-production-TwoSampleMR-component'});continue
   function='mr_wald_ratio' if i.get('estimator')=='wald-ratio' else 'mr_ivw_fe'
   vectors=','.join(f'{name}=c({",".join(map(str,i[key]))})' for name,key in [('b_exp','bx'),('b_out','by'),('se_exp','bxse'),('se_out','byse')])
   code=f'.libPaths(c({json.dumps(str(repo/"项目代码/孟德尔随机化/.r-lib"))},.libPaths()));r<-TwoSampleMR::{function}({vectors});z<-qnorm(.975);cat(sprintf("%.17g\\n",c(r$b,r$se,r$b-z*r$se,r$b+z*r$se,r$pval)))'
   result=subprocess.run(['Rscript','--vanilla','-e',code],capture_output=True,text=True,check=True);actual=dict(zip(['estimate','standardError','lower','upper','pValue'],[float(v) for v in result.stdout.split()]));row['engineImplementation']='production-TwoSampleMR::'+function
  checks={key:math.isfinite(actual.get(key,float('nan'))) and abs(actual[key]-ref['value'])<=ref['absoluteTolerance'] for key,ref in case['numeric'].items()};rows.append({**row,'passed':all(checks.values()),'checks':checks,'numeric':actual})
def digest_files(paths):
 return hashlib.sha256(json.dumps([(str(path.relative_to(repo)),hashlib.sha256(path.read_bytes()).hexdigest()) for path in paths],separators=(',',':')).encode()).hexdigest()
engine_files={'meta':[repo/'项目代码/meta/new_meta/engines/meta_engine.py',repo/'项目代码/meta/new_meta/schemas/meta_result.py'],'pharmacovigilance':[repo/'项目代码/药物安全分析agent/safety_agent/signals/disproportionality.py',repo/'项目代码/药物安全分析agent/safety_agent/signals/tables.py'],'mr':[repo/'项目代码/孟德尔随机化/r_scripts/templates.py',repo/'项目代码/孟德尔随机化/.r-lib/TwoSampleMR/R/TwoSampleMR.rdb',repo/'项目代码/孟德尔随机化/.r-lib/TwoSampleMR/DESCRIPTION']}[engine]
metadata={'engineDigest':digest_files(engine_files),'scorerDigest':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'runtime':{'python':platform.python_version(),'numpy':importlib.metadata.version('numpy'),'scipy':importlib.metadata.version('scipy'),'R':subprocess.run(['Rscript','--version'],capture_output=True,text=True,check=True).stdout.strip()}}
metadata['runtimeDigest']=hashlib.sha256(json.dumps(metadata['runtime'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
report={'executedAt':executed_at,'schemaVersion':1,'methodId':a.method_id,'sourceDefinitionHash':hashlib.sha256(raw).hexdigest(),**metadata,'scored':True,'scope':'deterministic-method-only','executionKind':'actual-existing-engine','replicates':2,'rows':rows};serialized=json.dumps(report,separators=(',',':'));report_hash=hashlib.sha256(serialized.encode()).hexdigest();out=root/'paper-gold/engine-calibration'/f'{a.method_id}-{report_hash}.json';out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
if out.exists():assert out.read_text()==serialized,'Immutable engine receipt changed'
else:out.write_text(serialized);out.chmod(0o600)
print(json.dumps({'engineId':engine,'methodId':a.method_id,'sourceDefinitionHash':report['sourceDefinitionHash'],'engineDigest':metadata['engineDigest'],'runtimeDigest':metadata['runtimeDigest'],'scorerDigest':metadata['scorerDigest'],'methodCases':len(rows),'passed':sum(row['passed'] for row in rows),'unsupported':sum('unsupported' in row for row in rows),'passedPublishedSources':len(set(row['publicationId'] for row in rows if row['passed'])),'reportHash':report_hash,'reportFile':out.name,'fullResearchReproductions':0}))
