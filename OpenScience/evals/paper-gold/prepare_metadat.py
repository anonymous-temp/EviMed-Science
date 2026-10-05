#!/usr/bin/env python3
"""Operator-only published data calibration: pinned metadat, metafor REML and production MetaEngine.
Reference outputs are reproduced author-software values, not claims about a paper's original analysis.
"""
import argparse,csv,hashlib,html,json,math,pathlib,re,subprocess,sys,tempfile
parser=argparse.ArgumentParser();parser.add_argument('evaluation_dir');parser.add_argument('--r-library',required=True);args=parser.parse_args()
root=pathlib.Path(args.evaluation_dir).resolve();assets=root/'paper-gold/metadat';receipts=json.loads((assets/'receipts.json').read_text()); hashes={x['file']:x['sha256'] for x in receipts['assets']}
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[3]/'项目代码/meta'))
from new_meta.engines.meta_engine import random_effects_reml
from new_meta.schemas.meta_result import StudyEffect
cases=[];rejected=[]
for name in ['dat.bcg','dat.bangertdrowns2004','dat.hackshaw1998','dat.linde2005','dat.normand1999']:
 for suffix in ['.rda','.html']:
  assert hashlib.sha256((assets/(name+suffix)).read_bytes()).hexdigest()==hashes[name+suffix]
 doc=(assets/(name+'.html')).read_text();source=doc.split('id="source"')[-1].split('id="references"')[0];doi=re.search(r'https://doi.org/([^"<\s]+)',source)
 if not doi:raise ValueError('Primary dataset citation unavailable')
 measure={'dat.bcg':'RR','dat.bangertdrowns2004':'SMD','dat.hackshaw1998':'OR','dat.linde2005':'RR','dat.normand1999':'MD'}[name]
 transforms={'dat.bcg':'d<-escalc(measure="RR",ai=tpos,bi=tneg,ci=cpos,di=cneg,data=d)', 'dat.linde2005':'d<-escalc(measure="RR",ai=ai,bi=n1i-ai,ci=ci,di=n2i-ci,data=d)', 'dat.normand1999':'d<-escalc(measure="MD",m1i=m1i,sd1i=sd1i,n1i=n1i,m2i=m2i,sd2i=sd2i,n2i=n2i,data=d)'}
 with tempfile.TemporaryDirectory(dir=assets) as tmp:
  tmp=pathlib.Path(tmp);inp=tmp/'input.csv';out=tmp/'output.csv'
  code=f'.libPaths(c({json.dumps(str(pathlib.Path(args.r_library).resolve()))},.libPaths()));library(metafor);e<-new.env();load({json.dumps(str(assets/(name+".rda")))},envir=e);d<-e[[ls(e)[1]]];'+transforms.get(name,'invisible(NULL)')+f';d<-d[is.finite(d$yi)&is.finite(d$vi)&d$vi>0,];r<-rma(yi,vi,data=d,method="REML");write.csv(d[,c("yi","vi")],{json.dumps(str(inp))},row.names=FALSE);write.csv(data.frame(pooled_log=as.numeric(r$b),ci_lower_log=r$ci.lb,ci_upper_log=r$ci.ub,tau_squared=r$tau2,q_statistic=r$QE,n_studies=r$k),{json.dumps(str(out))},row.names=FALSE);cat(as.character(packageVersion("metafor")))'
  run=subprocess.run(['Rscript','--vanilla','-e',code],capture_output=True,text=True,check=True)
  inputs=[{'yi':float(x['yi']),'vi':float(x['vi'])} for x in csv.DictReader(inp.open())]; gold={k:float(v) for k,v in next(csv.DictReader(out.open())).items()}
  studies=[StudyEffect(study_id=str(i),study_label=str(i),yi=x['yi'],vi=x['vi'],se=math.sqrt(x['vi'])) for i,x in enumerate(inputs)]
  actual=random_effects_reml(studies,measure,name).model_dump(); mapping={'pooled_log':actual['pooled_log'] if actual['pooled_log'] is not None else actual['pooled_effect'],'ci_lower_log':actual['ci_lower_log'] if actual['ci_lower_log'] is not None else actual['ci_lower'],'ci_upper_log':actual['ci_upper_log'] if actual['ci_upper_log'] is not None else actual['ci_upper'],'tau_squared':actual['tau_squared'],'q_statistic':actual['q_statistic'],'n_studies':actual['n_studies']}
  if any(not math.isfinite(mapping[k]) or abs(mapping[k]-v)>1e-5 for k,v in gold.items()):rejected.append({'id':name,'reason':'production_reference_disagreement'});continue
  cases.append({'id':name,'kind':'published','hidden':True,'publicationId':html.unescape(doi.group(1)),'sourceHash':hashes[name+'.rda'],'authorCodeSourceHash':hashes[name+'.html'],'input':{'studies':inputs,'effectMeasure':measure,'tauEstimator':'REML','confidenceMethod':'normal_wald'},'numeric':{k:{'value':v,'absoluteTolerance':1e-5} for k,v in gold.items()},'independentQa':{'passed':True,'executor':'pinned-author-data-metafor-vs-production-meta-engine','scope':'Same-data REML method calibration, not full clinical research reproduction or an assertion of original paper pooled results.'},'independentImplementation':{'implementationId':'metafor-'+run.stdout.strip(),'numeric':gold}})
definition={'methodId':'meta-reml-published-data-v2','frozen':True,'cases':cases,'rejected':rejected,'sourceCommit':receipts['commit'],'note':'Five distinct source publications with public same-version datasets. Author metafor REML reference vs actual production MetaEngine; no model calls.'}
serialized=json.dumps(definition,separators=(',',':'));p=root/'paper-gold/candidate-cases/meta-reml-published-data-v2.json';p.parent.mkdir(parents=True,exist_ok=True)
if p.exists():assert p.read_text()==serialized,'Frozen reference changed'
else:p.write_text(serialized);p.chmod(0o600)
print(json.dumps({'hash':hashlib.sha256(serialized.encode()).hexdigest(),'admitted':len(cases),'distinctPublications':len(set(x['publicationId'] for x in cases)),'rejected':len(rejected),'fullResearchReproductions':0}))
