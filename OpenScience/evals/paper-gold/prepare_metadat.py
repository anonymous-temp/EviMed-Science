#!/usr/bin/env python3
"""Operator-only: freeze the reference cases of the meta-analysis method ruler from pinned metadat datasets.

The reference of each case is metafor's REML fit of the dataset. That is another implementation's
output on published data, not a number printed in the cited paper, so the cases are labelled
`other-implementation` (the kind `method-records.json` already has) and never `published`.

This script used to run the production engine on each dataset and drop the dataset when the engine
differed from metafor (`production_reference_disagreement`), after which the engine was scored on what
was left (review finding B4). It no longer imports the engine: a dataset is admitted on source integrity
alone (pinned file hashes and a citable source), and `score_existing_methods.py` reports agreement or
disagreement for every one.

Tolerance, by rule (`tolerance.mjs`): tau-squared and the three quantities that depend on it carry an
absolute 1e-5 under the named reason `iterative-estimator`, because metafor's REML stops when tau-squared
changes by less than 1e-5 (its default `threshold`), so the reference itself is known no closer; Q is a
closed form and is compared at the computed default; the study count is exact.
"""
import argparse,csv,hashlib,html,json,pathlib,re,subprocess,sys,tempfile
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from score_existing_methods import default_half_width
parser=argparse.ArgumentParser();parser.add_argument('evaluation_dir');parser.add_argument('--r-library',required=True);args=parser.parse_args()
root=pathlib.Path(args.evaluation_dir).resolve();assets=root/'paper-gold/metadat';receipts=json.loads((assets/'receipts.json').read_text()); hashes={x['file']:x['sha256'] for x in receipts['assets']}
METHOD_ID='meta-reml-published-data-v3'
def reference(key,value):
 if key=='n_studies':return {'value':value,'quantity':'count','absoluteTolerance':0,'relativeTolerance':0,'toleranceBasis':'exact-count'}
 if key=='q_statistic':return {'value':value,'absoluteTolerance':default_half_width({'value':value}) if value==0 else 0,'relativeTolerance':0 if value==0 else 1e-6,'toleranceBasis':'computed-reference'}
 return {'value':value,'absoluteTolerance':1e-5,'relativeTolerance':0,'toleranceBasis':'named-reason','toleranceReason':'iterative-estimator'}
cases=[]
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
  # Admitted on source integrity alone: the pinned dataset, its citable source and metafor's fit of it.
  cases.append({'id':name,'kind':'other-implementation','hidden':True,'publicationId':html.unescape(doi.group(1)),'sourceHash':hashes[name+'.rda'],'authorCodeSourceHash':hashes[name+'.html'],'input':{'studies':inputs,'effectMeasure':measure,'tauEstimator':'REML','confidenceMethod':'normal_wald'},'numeric':{k:reference(k,v) for k,v in gold.items()},'independentQa':{'passed':True,'executor':'pinned-public-dataset-and-metafor-reml','scope':'Same-data REML method calibration against another implementation; not full clinical research reproduction and not an assertion of the cited paper\'s printed pooled results.'},'independentImplementation':{'implementationId':'metafor-'+run.stdout.strip(),'numeric':gold}})
definition={'methodId':METHOD_ID,'frozen':True,'schemaVersion':2,'admission':{'rule':'A pinned metadat dataset with verified file hashes and a citable source publication.','engineOutputRead':False,'fixedBeforeScoring':True},'cases':cases,'excluded':[],'rowsEntered':len(cases),'sourceCommit':receipts['commit'],'note':'Five source publications with public same-version datasets. The reference is metafor REML on the dataset (another implementation), not a number printed in the paper; no model calls.'}
serialized=json.dumps(definition,separators=(',',':'));p=root/'paper-gold/candidate-cases'/f'{METHOD_ID}.json';p.parent.mkdir(parents=True,exist_ok=True)
if p.exists():assert p.read_text()==serialized,'Frozen reference changed'
else:p.write_text(serialized);p.chmod(0o600)
print(json.dumps({'methodId':METHOD_ID,'hash':hashlib.sha256(serialized.encode()).hexdigest(),'rowsEntered':len(cases),'cases':len(cases),'excludedBeforeScoring':0,'distinctPublications':len(set(x['publicationId'] for x in cases)),'referenceKind':'other-implementation','fullResearchReproductions':0}))
