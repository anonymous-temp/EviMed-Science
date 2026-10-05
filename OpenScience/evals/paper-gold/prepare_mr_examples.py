#!/usr/bin/env python3
"""Operator-only: freeze the reference cases of the MR arithmetic ruler from published per-variant examples.

Eleven worked examples from six published data or example sources; rows are never counted as papers.
The reference of each case is the output of the authors' R implementation (MendelianRandomization's
`mr_ivw`, or base R for the single-instrument Wald ratio) on the published per-variant inputs,
cross-checked here against an independent numpy GLS. That is another implementation's output on
published data, not a number printed in the cited paper, so the cases are labelled
`other-implementation` and never `published` (review finding B4).

Tolerance, by rule (`tolerance.mjs`): a closed-form reference computed by another implementation is
compared at a relative 1e-6, and a p-value only ever relatively. These references used to carry an
absolute 1e-10, which for the four cases whose p-values are of order 1e-15 to 1e-26 accepted any p below
1e-10 (review finding B5). No engine and no library under test is imported or run by this script.
"""
import argparse,csv,hashlib,json,math,pathlib,subprocess,sys,tarfile,numpy as np
from scipy.stats import norm
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from score_existing_methods import default_half_width
METHOD_ID='mr-ivw-published-data-v6'
def references(keys,gold):
 """Computed references: relative 1e-6 (the rule's default), with the p-value typed so it is never absolute."""
 out={}
 for key,value in zip(keys,gold):
  out[key]={'value':value,**({'quantity':'p-value'} if key=='pValue' else {}),'absoluteTolerance':default_half_width({'value':value}) if value==0 else 0,'relativeTolerance':0 if value==0 else 1e-6,'toleranceBasis':'computed-reference'}
 return out
def agree_closely(left,right):
 """Two independent computations of one closed form agree to rounding error, on every scale."""
 return all(math.isfinite(a) and abs(a-b)<=1e-9*max(abs(a),abs(b))+1e-300 for a,b in zip(left,right))
p=argparse.ArgumentParser();p.add_argument('evaluation_dir');args=p.parse_args();root=pathlib.Path(args.evaluation_dir).resolve();assets=root/'paper-gold/mr-package';receipt=json.loads((assets/'receipt.json').read_text());package=next(assets.glob('MendelianRandomization_*.tar.gz'));assert hashlib.sha256(package.read_bytes()).hexdigest()==receipt['sha256']
with tarfile.open(package) as archive:
 for name in ['1Data.R','AllClasses.R','AllGenerics.R','new-methods.R','ExtraFunctions.R','mr_ivw-methods.R']:
  assert archive.extractfile('MendelianRandomization/R/'+name).read()==(assets/name).read_bytes(),'Extracted author code changed'
code=f'p<-{json.dumps(str(assets))};for(f in c("1Data.R","AllClasses.R","AllGenerics.R","new-methods.R","ExtraFunctions.R","mr_ivw-methods.R"))source(file.path(p,f));for(x in c("ldlc","hdlc","trig","calcium")){{b<-get(x);s<-get(paste0(x,"se"));y<-if(x=="calcium")fastgluc else chdlodds;ys<-if(x=="calcium")fastglucse else chdloddsse;rho<-if(x=="calcium")calc.rho else matrix();r<-mr_ivw(mr_input(bx=b,bxse=s,by=y,byse=ys,corr=rho),model="fixed",correl=x=="calcium");write.csv(data.frame(Estimate=r@Estimate,StdError=r@StdError,CILower=r@CILower,CIUpper=r@CIUpper,Pvalue=r@Pvalue),file.path(p,paste0(x,"-reference.csv")),row.names=FALSE);write.csv(data.frame(bx=b,bxse=s,by=y,byse=ys),file.path(p,paste0(x,".csv")),row.names=FALSE)}};write.csv(calc.rho,file.path(p,"calcium-correlation.csv"),row.names=FALSE)'
subprocess.run(['Rscript','--vanilla','-e',code],capture_output=True,text=True,check=True)
cases=[]
for name in ['ldlc','hdlc','trig','calcium']:
 rows=list(csv.DictReader((assets/(name+'.csv')).open()));data={k:np.array([float(x[k]) for x in rows]) for k in ['bx','bxse','by','byse']};rho=np.eye(len(rows)) if name!='calcium' else np.array([[float(x) for x in row] for row in list(csv.reader((assets/'calcium-correlation.csv').open()))[1:]])
 precision=np.linalg.inv(data['byse'][:,None]*rho*data['byse'][None,:]);information=data['bx']@precision@data['bx'];beta=data['bx']@precision@data['by']/information;se=math.sqrt(1/information);z=norm.ppf(.975);independent=[beta,se,beta-z*se,beta+z*se,2*norm.sf(abs(beta/se))];gold=list(next(csv.DictReader((assets/(name+'-reference.csv')).open())).values());gold=[float(v) for v in gold]
 assert agree_closely(gold,independent),'Author R and numpy GLS disagree'
 keys=['estimate','standardError','lower','upper','pValue'];doi='10.1007/s10654-015-0011-z' if name=='calcium' else '10.1161/ATVBAHA.109.201020'
 cases.append({'id':'published-mr-'+name,'kind':'other-implementation','hidden':True,'publicationId':doi,'sourceHash':receipt['sha256'],'authorCodeSourceHash':hashlib.sha256((assets/'mr_ivw-methods.R').read_bytes()).hexdigest(),'input':{'bx':data['bx'].tolist(),'bxse':data['bxse'].tolist(),'by':data['by'].tolist(),'byse':data['byse'].tolist(),'correlation':rho.tolist() if name=='calcium' else None,'model':'fixed','weights':'first-order','confidenceMethod':'normal_wald'},'numeric':references(keys,gold),'independentQa':{'passed':True,'executor':'original-MendelianRandomization-author-code-vs-numpy-GLS','scope':'Public package per-SNP association inputs already harmonized by the authors. Fixed-effect first-order IVW only; not a fresh GWAS extraction, complete MR pipeline or clinical causal validation.'},'independentImplementation':{'implementationId':'MendelianRandomization-0.10.0-author-R','numeric':dict(zip(keys,gold))}})
# Independent public MR.raps examples are one further distinct method publication, not three papers.
raps=root/'paper-gold/mr-raps';raps_receipts=json.loads((raps/'receipts.json').read_text()) if raps.exists() else None
if raps_receipts:
 for name in ['bmi.cad','bmi.sbp','crp.cad']:
  artifact=raps/(name+'.rda');assert hashlib.sha256(artifact.read_bytes()).hexdigest()==next(x['sha256'] for x in raps_receipts['assets'] if x['file']==artifact.name)
  all_rows=list(csv.DictReader((raps/(name+'.rda.csv')).open())); selected=[]
  for row in all_rows:
   if row.get('mr_keep')!='TRUE' or float(row['pval.selection'])>5e-8:continue
   if row['effect_allele.exposure']!=row['effect_allele.outcome'] or row['other_allele.exposure']!=row['other_allele.outcome']:continue
   values=[float(row[k]) for k in ['beta.exposure','se.exposure','beta.outcome','se.outcome']]
   if not all(math.isfinite(v) for v in values) or min(values[1],values[3])<=0:continue
   selected.append(values)
  if len(selected)<3:raise ValueError('Insufficient verified public variants')
  array=np.array(selected);bx,bxse,by,byse=array.T
  inputs={'bx':bx.tolist(),'bxse':bxse.tolist(),'by':by.tolist(),'byse':byse.tolist(),'correlation':None,'model':'fixed','weights':'first-order','confidenceMethod':'normal_wald'}
  rcode=f'p<-{json.dumps(str(assets))};for(f in c("1Data.R","AllClasses.R","AllGenerics.R","new-methods.R","ExtraFunctions.R","mr_ivw-methods.R"))source(file.path(p,f));r<-mr_ivw(mr_input(bx=c({",".join(map(str,bx))}),bxse=c({",".join(map(str,bxse))}),by=c({",".join(map(str,by))}),byse=c({",".join(map(str,byse))})),model="fixed");cat(sprintf("%.17g\\n",c(r@Estimate,r@StdError,r@CILower,r@CIUpper,r@Pvalue)))'
  rr=subprocess.run(['Rscript','--vanilla','-e',rcode],capture_output=True,text=True,check=True);gold=[float(x) for x in rr.stdout.split()]
  information=np.sum(bx**2/byse**2);beta=np.sum(bx*by/byse**2)/information;se=math.sqrt(1/information);z=norm.ppf(.975);independent=[beta,se,beta-z*se,beta+z*se,2*norm.sf(abs(beta/se))]
  assert agree_closely(gold,independent),'Public RAPS-input IVW reference mismatch'
  keys=['estimate','standardError','lower','upper','pValue'];cases.append({'id':'published-mr-raps-'+name,'kind':'other-implementation','hidden':True,'publicationId':'10.1214/19-AOS1866','sourceHash':hashlib.sha256(artifact.read_bytes()).hexdigest(),'input':inputs,'numeric':references(keys,gold),'independentQa':{'passed':True,'executor':'published-MR-raps-inputs-author-IVW-code-vs-numpy','scope':'Fixed-IVW method example only, not an RAPS-estimator reproduction. Prespecified selectionP<=5e-8, mr_keepTRUE, exact exposure/outcome allele concordance and finite positive SE; source authors already processed summary data.'},'independentImplementation':{'implementationId':'MendelianRandomization-0.10.0-author-R','numeric':dict(zip(keys,gold))},'selectionProtocol':{'pvalue':5e-8,'mrKeep':True,'alleles':'exact-same-oriented','excludedVariants':len(all_rows)-len(selected)}})
# Two further independently published author real-data worked examples, not simulated package fixtures.
additional=root/'paper-gold/mr-additional'
for package_name,doi in [('MRcML','10.1016/j.ajhg.2021.05.014'),('MRMix','10.1038/s41467-019-09432-2'),('MVMR','10.1002/sim.9133')]:
 folder=additional/package_name
 if not folder.exists():continue
 source_receipt=json.loads((folder/'receipts.json').read_text())
 for asset in source_receipt['assets']:assert hashlib.sha256((folder/asset['file']).read_bytes()).hexdigest()==asset['sha256']
 if package_name=='MVMR':
  subprocess.run(['Rscript','--vanilla','-e',f'load({json.dumps(str(folder/"rawdat_mvmr.RData"))});write.csv(rawdat_mvmr,{json.dumps(str(folder/"rawdat.csv"))},row.names=FALSE)'],capture_output=True,check=True)
  selected=[]
  for row in csv.DictReader((folder/'rawdat.csv').open()):
   values=[float(row[k]) for k in ['LDL_beta','LDL_se','SBP_beta','SBP_se']]
   if all(math.isfinite(v) for v in values) and min(values[1],values[3])>0 and abs(values[0]/values[1])>=norm.isf(2.5e-8):selected.append(values)
 elif package_name=='MRcML':
  subprocess.run(['Rscript','--vanilla','-e',f'load({json.dumps(str(folder/"T2D_FG.rda"))});write.csv(data.frame(bx=T2D_FG$b_exp,bxse=T2D_FG$se_exp,by=T2D_FG$b_out,byse=T2D_FG$se_out),{json.dumps(str(folder/"inputs.csv"))},row.names=FALSE)'],capture_output=True,check=True)
  selected=[[float(r[k]) for k in ['bx','bxse','by','byse']] for r in csv.DictReader((folder/'inputs.csv').open())]
 else:
  subprocess.run(['Rscript','--vanilla','-e',f'load({json.dumps(str(folder/"BMI15.RData"))});load({json.dumps(str(folder/"MDD18.RData"))});write.csv(merge(BMI15,MDD18,by="SNP"),{json.dumps(str(folder/"merged.csv"))},row.names=FALSE)'],capture_output=True,check=True)
  selected=[]
  for row in csv.DictReader((folder/'merged.csv').open()):
   same=row['effect_allele']==row['A1'] and row['other_allele']==row['A2'];flipped=row['effect_allele']==row['A2'] and row['other_allele']==row['A1']
   if not(same or flipped):continue
   # Authors demonstrate palindrome-frequency agreement; exact alleles and frequency concordance are required here.
   if {row['effect_allele'],row['other_allele']} in [{'A','T'},{'C','G'}]:
    aligned=float(row['FRQ_U_113154']) if same else 1-float(row['FRQ_U_113154'])
    if abs(float(row['EAF'])-aligned)>0.1:continue
   selected.append([float(row['beta']),float(row['se']),math.log(float(row['OR']))*(1 if same else -1),float(row['SE'])])
 array=np.array(selected);assert len(array)>2 and np.isfinite(array).all() and (array[:,[1,3]]>0).all()
 bx,bxse,by,byse=array.T
 rcode=f'p<-{json.dumps(str(assets))};for(f in c("1Data.R","AllClasses.R","AllGenerics.R","new-methods.R","ExtraFunctions.R","mr_ivw-methods.R"))source(file.path(p,f));r<-mr_ivw(mr_input(bx=c({",".join(map(str,bx))}),bxse=c({",".join(map(str,bxse))}),by=c({",".join(map(str,by))}),byse=c({",".join(map(str,byse))})),model="fixed");cat(sprintf("%.17g\\n",c(r@Estimate,r@StdError,r@CILower,r@CIUpper,r@Pvalue)))'
 rr=subprocess.run(['Rscript','--vanilla','-e',rcode],capture_output=True,text=True,check=True);gold=[float(x) for x in rr.stdout.split()]
 information=np.sum(bx**2/byse**2);beta=np.sum(bx*by/byse**2)/information;se=math.sqrt(1/information);z=norm.ppf(.975);independent=[beta,se,beta-z*se,beta+z*se,2*norm.sf(abs(beta/se))]
 assert agree_closely(gold,independent),'Author IVW and numpy GLS disagree'
 keys=['estimate','standardError','lower','upper','pValue'];cases.append({'id':'published-mr-'+package_name.lower(),'kind':'other-implementation','hidden':True,'publicationId':doi,'sourceHash':hashlib.sha256((folder/('T2D_FG.rda' if package_name=='MRcML' else 'rawdat_mvmr.RData' if package_name=='MVMR' else 'BMI15.RData')).read_bytes()).hexdigest(),'sourceAssets':source_receipt['assets'],'input':{'bx':bx.tolist(),'bxse':bxse.tolist(),'by':by.tolist(),'byse':byse.tolist(),'correlation':None,'model':'fixed','weights':'first-order','confidenceMethod':'normal_wald'},'numeric':references(keys,gold),'independentQa':{'passed':True,'executor':'author-public-real-SNP-inputs-R-IVW-vs-numpy-GLS','scope':'IVW arithmetic method calibration from published author real-data examples only. Not a reproduction of cML/MRMix estimator or clinical causal validation; no new standardization. MRMix exact allele harmonization and palindrome-frequency concordance enforced.'},'independentImplementation':{'implementationId':'MendelianRandomization-0.10.0-author-R','numeric':dict(zip(keys,gold))}})
# Preregistered single-instrument method example from the published CASR data.
# This is Wald arithmetic, not a claim to reproduce the paper's correlated-IVW analysis.
calcium=next(c for c in cases if c['id']=='published-mr-calcium');i=calcium['input'];index=max(range(len(i['bx'])),key=lambda n:abs(i['bx'][n]/i['bxse'][n]));bx=i['bx'][index];by=i['by'][index];ys=i['byse'][index]
rr=subprocess.run(['Rscript','--vanilla','-e',f'b<-{by}/{bx};s<-{ys}/abs({bx});z<-qnorm(.975);cat(sprintf("%.17g\\n",c(b,s,b-z*s,b+z*s,2*pnorm(abs(b/s),lower.tail=FALSE))))'],capture_output=True,text=True,check=True);gold=[float(x) for x in rr.stdout.split()];b=by/bx;se=ys/abs(bx);z=norm.ppf(.975);reference=[b,se,b-z*se,b+z*se,2*norm.sf(abs(b/se))];assert agree_closely(gold,reference),'Base R and scipy disagree on the Wald ratio'
keys=['estimate','standardError','lower','upper','pValue'];cases.append({'id':'published-mr-calcium-single-wald','kind':'other-implementation','hidden':True,'publicationId':calcium['publicationId'],'sourceHash':calcium['sourceHash'],'input':{'bx':[bx],'bxse':[i['bxse'][index]],'by':[by],'byse':[ys],'estimator':'wald-ratio','weights':'first-order','confidenceMethod':'normal_wald'},'selectionProtocol':{'rule':'single-strongest-absolute-exposure-z','selectedPublishedVariantIndex':index,'chosenWithoutOutcome':'true'},'numeric':references(keys,gold),'independentQa':{'passed':True,'executor':'independent-base-R-Wald-vs-python-scipy','scope':'Prespecified single published CASR variant, first-order Wald-ratio arithmetic only. Not the original correlated-IVW paper estimate or a new clinical causal analysis.'},'independentImplementation':{'implementationId':'base-R-first-order-Wald','numeric':dict(zip(keys,gold))}})
d={'methodId':METHOD_ID,'frozen':True,'schemaVersion':2,'admission':{'rule':'A published per-variant example whose preserved assets verify by hash, with the authors\' own IVW (or base-R Wald) output as reference.','engineOutputRead':False,'fixedBeforeScoring':True},'cases':cases,'excluded':[],'rowsEntered':len(cases),'sourcePublications':len(set(c['publicationId'] for c in cases)),'softwarePublication':'10.1093/ije/dyx034','note':'Eleven worked examples from SIX distinct published data/example sources; not nine independent papers. The reference is the authors\' IVW implementation cross-checked against an independent GLS (another implementation), not a number printed in a paper; no provider calls.'};s=json.dumps(d,separators=(',',':'));f=root/'paper-gold/candidate-cases'/f'{METHOD_ID}.json';f.parent.mkdir(parents=True,exist_ok=True)
if f.exists():assert f.read_text()==s,'Frozen reference changed'
else:f.write_text(s);f.chmod(0o600)
print(json.dumps({'methodId':METHOD_ID,'hash':hashlib.sha256(s.encode()).hexdigest(),'rowsEntered':len(cases),'cases':len(cases),'excludedBeforeScoring':0,'distinctDataPublications':len(set(c['publicationId'] for c in cases)),'softwarePublicationCount':1,'referenceKind':'other-implementation','requiredFivePaperGap':max(0,5-len(set(c['publicationId'] for c in cases))),'fullResearchReproductions':0}))
