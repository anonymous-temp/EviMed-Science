#!/usr/bin/env python3
"""Operator-only method ruler. Runs actual production statistics against frozen independent references."""
import argparse,hashlib,json,math,pathlib,re,subprocess,sys,platform
import importlib.metadata
from datetime import datetime,timezone

# --- Tolerance: a line-for-line port of boundedHalfWidth in tolerance.mjs -------------------------------
# The rule lives in tolerance.mjs (why a tolerance is derived from the printed number and bounded in
# code). tolerance.test.mjs runs both implementations over tolerance-vectors.json, and the control
# plane re-scores every row of the receipt this script writes, so a drift between the two is an error.
TOLERANCE_LIMITS={'printedLoosening':4,'relativeCeiling':0.03,'computedRelative':1e-6,'computedRelativeCeiling':1e-3,'zeroAbsolute':1e-9,'zeroAbsoluteCeiling':1e-6}
TOLERANCE_REASONS=('inputs-rounded-in-source','iterative-estimator','stochastic-method','specification-variant')
ROUNDING_SLACK=1e-9
_PRINTED=re.compile(r'^([+-]?)(?:([0-9]+)(?:\.([0-9]+))?|\.([0-9]+))(?:\s*(?:[eE]|[\u00d7x*]\s*10\s*\^?\s*)([+-]?[0-9]+))?\s*(%)?$')
def printed_number(token):
 """(value, half unit of the last printed digit) of a number as a paper prints it, or None."""
 if not isinstance(token,str):return None
 text=re.sub(r'(?<=[0-9])[,\u2009\u202f](?=[0-9]{3}(?:[^0-9]|$))','',token.strip().translate({0x2212:'-',0x2012:'-',0x2013:'-'}))
 match=_PRINTED.match(text)
 if not match:return None
 fraction=match.group(3) or match.group(4) or '';exponent=int(match.group(5) or 0)-(2 if match.group(6) else 0)
 value=float(f"{'-' if match.group(1)=='-' else ''}{match.group(2) or '0'}{'.'+fraction if fraction else ''}e{exponent}");half=float(f'5e{exponent-len(fraction)-1}')
 return (value,half) if math.isfinite(value) and math.isfinite(half) and half>0 else None
def _shortest_printed(value):
 # JavaScript prints 13.0 as "13"; repr() would print "13.0" and read one decimal too many.
 if isinstance(value,int) or (float(value).is_integer() and abs(value)<1e21):return printed_number(str(int(value)))
 return printed_number(repr(float(value)))
def _stated_half_width(reference):
 return max(float(reference.get('absoluteTolerance') or 0),abs(reference.get('value') or 0)*float(reference.get('relativeTolerance') or 0))
def default_half_width(reference):
 printed=printed_number(reference.get('printed'))
 if printed:return printed[1]*(1+ROUNDING_SLACK)
 return TOLERANCE_LIMITS['zeroAbsolute'] if reference['value']==0 else abs(reference['value'])*TOLERANCE_LIMITS['computedRelative']
def half_width_ceiling(reference):
 magnitude=abs(reference['value']);printed=printed_number(reference.get('printed'))
 if printed:
  unit=printed[1]*(1+ROUNDING_SLACK)
  if reference.get('toleranceReason') not in TOLERANCE_REASONS:return unit
  loosened=unit*TOLERANCE_LIMITS['printedLoosening']
  return loosened if reference['toleranceReason']=='inputs-rounded-in-source' else max(loosened,magnitude*TOLERANCE_LIMITS['relativeCeiling'])
 if reference['value']==0:return TOLERANCE_LIMITS['zeroAbsoluteCeiling']
 inferred=_shortest_printed(reference['value']) if 'printed' not in reference else None
 return max(magnitude*TOLERANCE_LIMITS['computedRelativeCeiling'],inferred[1]*(1+ROUNDING_SLACK) if inferred else 0)
def bounded_half_width(reference):
 """[half-width a score uses, whether the frozen reference asked for more than the bound]."""
 unstated='absoluteTolerance' not in reference and 'relativeTolerance' not in reference
 stated=default_half_width(reference) if unstated and printed_number(reference.get('printed')) else _stated_half_width(reference)
 ceiling=half_width_ceiling(reference)
 return [ceiling,True] if stated>ceiling else [stated,False]
def within_reference(actual,reference):
 """The comparison numericScore makes, written the same way so a boundary value cannot differ by an ulp."""
 if not isinstance(actual,(int,float)) or isinstance(actual,bool) or not math.isfinite(actual):return False
 tolerance=bounded_half_width(reference)[0]
 return actual>=reference['value']-tolerance and actual<=reference['value']+tolerance

def main():
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
   checks={key:within_reference(actual.get(key),ref) for key,ref in case['numeric'].items()};rows.append({**row,'passed':all(checks.values()),'checks':checks,'numeric':actual})
 def digest_files(paths):
  return hashlib.sha256(json.dumps([(str(path.relative_to(repo)),hashlib.sha256(path.read_bytes()).hexdigest()) for path in paths],separators=(',',':')).encode()).hexdigest()
 engine_files={'meta':[repo/'项目代码/meta/new_meta/engines/meta_engine.py',repo/'项目代码/meta/new_meta/schemas/meta_result.py'],'pharmacovigilance':[repo/'项目代码/药物安全分析agent/safety_agent/signals/disproportionality.py',repo/'项目代码/药物安全分析agent/safety_agent/signals/tables.py'],'mr':[repo/'项目代码/孟德尔随机化/r_scripts/templates.py',repo/'项目代码/孟德尔随机化/.r-lib/TwoSampleMR/R/TwoSampleMR.rdb',repo/'项目代码/孟德尔随机化/.r-lib/TwoSampleMR/DESCRIPTION']}[engine]
 metadata={'engineDigest':digest_files(engine_files),'scorerDigest':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'runtime':{'python':platform.python_version(),'numpy':importlib.metadata.version('numpy'),'scipy':importlib.metadata.version('scipy'),'R':subprocess.run(['Rscript','--version'],capture_output=True,text=True,check=True).stdout.strip()}}
 metadata['runtimeDigest']=hashlib.sha256(json.dumps(metadata['runtime'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
 report={'executedAt':executed_at,'schemaVersion':1,'methodId':a.method_id,'sourceDefinitionHash':hashlib.sha256(raw).hexdigest(),**metadata,'scored':True,'scope':'deterministic-method-only','executionKind':'actual-existing-engine','replicates':2,'rows':rows};serialized=json.dumps(report,separators=(',',':'));report_hash=hashlib.sha256(serialized.encode()).hexdigest();out=root/'paper-gold/engine-calibration'/f'{a.method_id}-{report_hash}.json';out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if out.exists():assert out.read_text()==serialized,'Immutable engine receipt changed'
 else:out.write_text(serialized);out.chmod(0o600)
 print(json.dumps({'engineId':engine,'methodId':a.method_id,'sourceDefinitionHash':report['sourceDefinitionHash'],'engineDigest':metadata['engineDigest'],'runtimeDigest':metadata['runtimeDigest'],'scorerDigest':metadata['scorerDigest'],'methodCases':len(rows),'passed':sum(row['passed'] for row in rows),'unsupported':sum('unsupported' in row for row in rows),'passedPublishedSources':len(set(row['publicationId'] for row in rows if row['passed'])),'reportHash':report_hash,'reportFile':out.name,'fullResearchReproductions':0}))

if __name__=='__main__':main()
