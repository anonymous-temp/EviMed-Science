#!/usr/bin/env python3
"""Operator-only method ruler: runs production statistics on every frozen reference case and reports the outcome.

Every case that entered the frozen definition stays in the denominator with one of three outcomes and a
reason: agree, disagree, could-not-run. The counts are cases; each case is run twice only to check that
the engine is deterministic. A disagreement is reported, with what the definition already knows about
the reference beside it, and is left unadjudicated: deciding platform error, paper error or reasonable
difference is the disagreement path's, not this script's.
"""
import argparse,hashlib,json,math,os,pathlib,re,subprocess,sys,platform
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

class CouldNotRun(Exception):
 """The ruler could not obtain a result for this case. `code` is a closed reason; the case stays in the denominator."""
 def __init__(self,code):super().__init__(code);self.code=code

def diagnose(case):
 """What the frozen definition already says about a reference the engine did not match. A deterministic
 description of the reference, recorded beside the disagreement; it adjudicates nothing."""
 consistency=case.get('referenceConsistency')
 if not consistency:return None
 if consistency.get('wald196ReproducesPrinted'):return 'engine_differs_from_textbook_formula'
 if consistency.get('waldExactQuantileReproducesPrinted'):return 'reference_follows_exact_normal_quantile'
 return 'reference_not_reproduced_by_textbook_formula_from_its_own_counts'

def main():
 executed_at=datetime.now(timezone.utc).isoformat()
 p=argparse.ArgumentParser();p.add_argument('evaluation_dir');p.add_argument('method_id')
 p.add_argument('--mr-r-library',default=os.environ.get('EVIMED_MR_R_LIBRARY'),help='R library holding TwoSampleMR (default: the MR engine checkout\'s .r-lib)')
 a=p.parse_args()
 if not re.fullmatch('[A-Za-z0-9_-]{1,100}',a.method_id):raise ValueError('Invalid method identity')
 root=pathlib.Path(a.evaluation_dir).resolve();repo=pathlib.Path(__file__).resolve().parents[3];source=root/'paper-gold/candidate-cases'/f'{a.method_id}.json';raw=source.read_bytes();definition=json.loads(raw);assert definition['frozen'] is True and definition['methodId']==a.method_id
 mr_library=pathlib.Path(a.mr_r_library).resolve() if a.mr_r_library else repo/'项目代码/孟德尔随机化/.r-lib'
 # What is executed, said for what it is. Meta and pharmacovigilance run the engine's own statistics
 # function. The MR row does not run the platform's MR engine: its templates (instrument selection,
 # harmonisation, allele flips, `mr(dat)`) are not on this path. It calls two functions of the
 # TwoSampleMR library the engine is built on, so that is what the row is named.
 if a.method_id.startswith('meta-reml-published-data'):engine='meta';execution_kind='actual-existing-engine';sys.path.insert(0,str(repo/'项目代码/meta'));from new_meta.engines.meta_engine import random_effects_reml;from new_meta.schemas.meta_result import StudyEffect
 elif a.method_id.startswith('faers-ror'):engine='pharmacovigilance';execution_kind='actual-existing-engine';sys.path.insert(0,str(repo/'项目代码/药物安全分析agent'));from safety_agent.signals.disproportionality import ror;from safety_agent.signals.tables import ContingencyTable2x2
 elif a.method_id.startswith('mr-ivw-published-data'):engine='mr';execution_kind='library-component'
 else:raise ValueError('This existing engine does not implement the frozen method family')
 def run(case):
  i=case['input']
  if engine=='meta':
   result=random_effects_reml([StudyEffect(study_id=str(n), study_label=str(n), yi=study["yi"], vi=study["vi"], se=math.sqrt(study["vi"])) for n,study in enumerate(i['studies'])],i['effectMeasure'],case['id']).model_dump()
   return {'pooled_log':result['pooled_log'] if result['pooled_log'] is not None else result['pooled_effect'],'ci_lower_log':result['ci_lower_log'] if result['ci_lower_log'] is not None else result['ci_lower'],'ci_upper_log':result['ci_upper_log'] if result['ci_upper_log'] is not None else result['ci_upper'],'tau_squared':result['tau_squared'],'q_statistic':result['q_statistic'],'n_studies':result['n_studies']},'new_meta.engines.meta_engine.random_effects_reml'
  if engine=='pharmacovigilance':
   result=ror(ContingencyTable2x2(**i));return {'ROR':result.value,'lower':result.ci95_lower,'upper':result.ci95_upper},'safety_agent.signals.disproportionality.ror'
  if i.get('correlation') is not None:raise CouldNotRun('correlated_ivw_not_implemented_by_twosamplemr_component')
  function='mr_wald_ratio' if i.get('estimator')=='wald-ratio' else 'mr_ivw_fe'
  vectors=','.join(f'{name}=c({",".join(map(repr,map(float,i[key])))})' for name,key in [('b_exp','bx'),('b_out','by'),('se_exp','bxse'),('se_out','byse')])
  code=f'.libPaths(c({json.dumps(str(mr_library))},.libPaths()));r<-TwoSampleMR::{function}({vectors});z<-qnorm(.975);cat(sprintf("%.17g\\n",c(r$b,r$se,r$b-z*r$se,r$b+z*r$se,r$pval)))'
  try:result=subprocess.run(['Rscript','--vanilla','-e',code],capture_output=True,text=True,check=True,timeout=120)
  except (subprocess.CalledProcessError,subprocess.TimeoutExpired,FileNotFoundError):raise CouldNotRun('twosamplemr_component_execution_failed')
  return dict(zip(['estimate','standardError','lower','upper','pValue'],[float(v) for v in result.stdout.split()])),'TwoSampleMR::'+function+' (library component; the platform MR engine pipeline is not executed)'
 # Every frozen case is run twice (a determinism check) and stays in the denominator whatever happens.
 rows=[]
 for replicate in range(2):
  for case in definition['cases']:
   row={'replicate':replicate,'caseId':case['id'],'engineId':engine,'publicationId':case['publicationId'],'sourceHash':case['sourceHash'],'referenceKind':case.get('kind'),'scope':'deterministic-method-only','fullResearchReproductionValid':False}
   try:actual,implementation=run(case)
   except CouldNotRun as error:rows.append({**row,'passed':False,'outcome':'could-not-run','reason':error.code,'unsupported':error.code});continue
   except Exception as error:rows.append({**row,'passed':False,'outcome':'could-not-run','reason':'engine_raised_'+type(error).__name__,'unsupported':'engine_raised'});continue
   checks={key:within_reference(actual.get(key),ref) for key,ref in case['numeric'].items()};agree=all(checks.values())
   rows.append({**row,'engineImplementation':implementation,'passed':agree,'outcome':'agree' if agree else 'disagree','reason':'within_reference_tolerance' if agree else 'outside_reference_tolerance',
    **({} if agree or diagnose(case) is None else {'diagnosis':diagnose(case),'adjudication':'unadjudicated'}),'checks':checks,'numeric':actual})
 # A case agrees when both of its replicates agree; the counts below are cases, never rows.
 outcomes={};deterministic=True
 for case in definition['cases']:
  pair=[row for row in rows if row['caseId']==case['id']]
  outcomes[case['id']]='could-not-run' if any(row['outcome']=='could-not-run' for row in pair) else 'agree' if all(row['outcome']=='agree' for row in pair) else 'disagree'
  if pair[0].get('numeric')!=pair[1].get('numeric'):deterministic=False
 def count(cases):
  tally={'cases':len(cases),'agree':0,'disagree':0,'couldNotRun':0}
  for case in cases:tally[{'agree':'agree','disagree':'disagree','could-not-run':'couldNotRun'}[outcomes[case['id']]]]+=1
  return tally
 publications=sorted(set(case['publicationId'] for case in definition['cases']))
 by_source={publication:count([case for case in definition['cases'] if case['publicationId']==publication]) for publication in publications}
 diagnoses={}
 for row in rows:
  if row['replicate']==0 and row.get('diagnosis'):diagnoses[row['diagnosis']]=diagnoses.get(row['diagnosis'],0)+1
 excluded=definition.get('excluded',definition.get('rejected',[]))
 summary={**count(definition['cases']),'rows':len(rows),'excludedBeforeScoring':len(excluded),'entered':len(definition['cases'])+len(excluded),'publishedSources':len(publications),
  'sourcesFullyAgreeing':sum(1 for tally in by_source.values() if tally['agree']==tally['cases']),'bySource':by_source,'disagreementDiagnoses':diagnoses,'deterministic':deterministic}
 def digest_files(paths):
  return hashlib.sha256(json.dumps([(name,hashlib.sha256(path.read_bytes()).hexdigest()) for name,path in paths],separators=(',',':')).encode()).hexdigest()
 engine_files={'meta':[(name,repo/name) for name in ['项目代码/meta/new_meta/engines/meta_engine.py','项目代码/meta/new_meta/schemas/meta_result.py']],
  'pharmacovigilance':[(name,repo/name) for name in ['项目代码/药物安全分析agent/safety_agent/signals/disproportionality.py','项目代码/药物安全分析agent/safety_agent/signals/tables.py']],
  # The component that is executed, and nothing that is not: the engine's templates used to be hashed here without ever being run.
  'mr':[(name,mr_library/name) for name in ['TwoSampleMR/R/TwoSampleMR.rdb','TwoSampleMR/DESCRIPTION']]}[engine]
 metadata={'engineDigest':digest_files(engine_files),'scorerDigest':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'runtime':{'python':platform.python_version(),'numpy':importlib.metadata.version('numpy'),'scipy':importlib.metadata.version('scipy'),'R':subprocess.run(['Rscript','--version'],capture_output=True,text=True,check=True).stdout.strip()}}
 metadata['runtimeDigest']=hashlib.sha256(json.dumps(metadata['runtime'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
 report={'executedAt':executed_at,'schemaVersion':2,'methodId':a.method_id,'sourceDefinitionHash':hashlib.sha256(raw).hexdigest(),**metadata,'scored':True,'scope':'deterministic-method-only','executionKind':execution_kind,'replicates':2,'summary':summary,'rows':rows};serialized=json.dumps(report,separators=(',',':'));report_hash=hashlib.sha256(serialized.encode()).hexdigest();out=root/'paper-gold/engine-calibration'/f'{a.method_id}-{report_hash}.json';out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if out.exists():assert out.read_text()==serialized,'Immutable engine receipt changed'
 else:out.write_text(serialized);out.chmod(0o600)
 print(json.dumps({'engineId':engine,'executionKind':execution_kind,'methodId':a.method_id,'sourceDefinitionHash':report['sourceDefinitionHash'],'engineDigest':metadata['engineDigest'],'runtimeDigest':metadata['runtimeDigest'],'scorerDigest':metadata['scorerDigest'],**summary,'reportHash':report_hash,'reportFile':out.name,'fullResearchReproductions':0}))

if __name__=='__main__':main()
