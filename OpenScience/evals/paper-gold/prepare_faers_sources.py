#!/usr/bin/env python3
"""Operator-only published aggregate calibration: primary tables vs independent R vs actual ADR engine."""
import argparse,csv,hashlib,json,math,pathlib,re,subprocess,sys,xml.etree.ElementTree as E
p=argparse.ArgumentParser();p.add_argument('evaluation_dir');a=p.parse_args();root=pathlib.Path(a.evaluation_dir).resolve();sources=root/'paper-gold/method-sources';repo=pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0,str(repo/'项目代码/药物安全分析agent'))
from safety_agent.signals.disproportionality import ror
from safety_agent.signals.tables import ContingencyTable2x2
old=json.loads((root/'paper-gold/candidate-cases/faers-ror-aggregate.json').read_text());cases=list(old['cases']);rejected=[];health=[]
def add(identity,label,counts,printed,source,correction=0):
 if min(counts)<=0:return
 adjusted=[x+correction for x in counts]
 result=subprocess.run(['Rscript','--vanilla','-e',f'x<-c({",".join(map(str,adjusted))});r<-x[1]*x[4]/(x[2]*x[3]);s<-sqrt(sum(1/x));cat(sprintf("%.17g\\n",c(r,exp(log(r)-1.96*s),exp(log(r)+1.96*s))))'],capture_output=True,text=True,check=True)
 expected=[float(x) for x in result.stdout.split()];tolerance=[.5*10**-len(v.split('.')[1]) if '.' in v else .5 for v in printed]
 if any(abs(expected[i]-float(printed[i]))>tolerance[i]+1e-10 for i in range(3)):
  rejected.append({'publicationId':identity,'label':label,'reason':'published_rounding_disagrees'});return
 actual=ror(ContingencyTable2x2(*adjusted));observed=[actual.value,actual.ci95_lower,actual.ci95_upper];assert all(abs(x-expected[i])<=1e-10 for i,x in enumerate(observed))
 keys=['ROR','lower','upper'];cases.append({'id':'faers-'+hashlib.sha256((identity+label).encode()).hexdigest()[:24],'kind':'published','hidden':True,'publicationId':identity,'sourceHash':hashlib.sha256(source).hexdigest(),'input':dict(zip('abcd',adjusted)),'originalCounts':dict(zip('abcd',counts)),'continuityCorrection':correction,'numeric':{k:{'value':float(printed[i]),'absoluteTolerance':tolerance[i]+1e-10} for i,k in enumerate(keys)},'independentQa':{'passed':True,'executor':'exact-primary-counts-R-reference-vs-production-ADR-ror','scope':'Published complete four-cell aggregate ROR method calibration only; not full database ingestion, confounding control, or clinical causation.'},'independentImplementation':{'implementationId':'R-normal-log-ror','numeric':dict(zip(keys,expected))}})
 health.append({'caseId':cases[-1]['id'],'engineId':'pharmacovigilance','passed':True,'reference':'independent-R','engine':'safety_agent.signals.disproportionality.ror'})
def parse_ratio(text):return re.findall(r'\d+(?:\.\d+)?',text)[:3]
for pmc,doi,table,offset,corr in [('PMC13513629','10.3390/ijerph23081088','ijerph-23-01088-t002',5,0),('PMC13516650','10.3390/ph19081181','pharmaceuticals-19-01181-t001',6,.5),('PMC12823856','10.3389/fphar.2025.1682276','T2',6,0)]:
 b=(sources/(pmc+'.xml')).read_bytes();r=E.fromstring(b);t=r.find(f'.//table-wrap[@id="{table}"]');active=pmc!='PMC12823856'
 for tr in t.findall('.//tbody/tr'):
  row=[' '.join(c.itertext()).strip() for c in tr.findall('td')]
  if pmc=='PMC12823856' and len(row)==1 and row[0] in ['FAERS','CVAR','JADER']:active=row[0]=='FAERS'
  if not active or len(row)<=offset:continue
  try:counts=[int(x.replace(',','')) for x in row[1:5]]
  except ValueError:continue
  printed=parse_ratio(row[offset])
  if len(printed)!=3:continue
  add(doi,row[0],counts,printed,b,corr)
b=(sources/'chei-all_ror_tests.csv').read_bytes()
for index,row in enumerate(csv.DictReader(b.decode('utf-8-sig').splitlines())):
 if row['comparator']!='C1' or row.get('haldane')!='0':continue
 add('10.1007/s00210-026-05748-1',str(index)+row['exposure']+row['family']+row['stratum'],[int(row[k]) for k in 'abcd'],[row[k] for k in ['ror','ci_lo','ci_hi']],b)
# Previously frozen references are also checked against the actual production engine.
for case in old['cases']:
 x=ror(ContingencyTable2x2(**case['input']));v=[x.value,x.ci95_lower,x.ci95_upper]
 assert all(abs(v[i]-case['numeric'][k]['value'])<=case['numeric'][k]['absoluteTolerance'] for i,k in enumerate(['ROR','lower','upper']))
 health.append({'caseId':case['id'],'engineId':'pharmacovigilance','passed':True,'engine':'safety_agent.signals.disproportionality.ror'})
d={'methodId':'faers-ror-published-data-v3','frozen':True,'cases':cases,'rejected':rejected,'distinctPublications':len(set(c['publicationId'] for c in cases)),'fullDatabaseReproductions':0};s=json.dumps(d,separators=(',',':'));out=root/'paper-gold/candidate-cases/faers-ror-published-data-v3.json'
if out.exists():assert out.read_text()==s
else:out.write_text(s);out.chmod(0o600)
(root/'paper-gold/engine-calibration/faers-published-method-health.json').write_text(json.dumps({'scored':True,'scope':'deterministic-method-only','rows':health}))
print(json.dumps({'hash':hashlib.sha256(s.encode()).hexdigest(),'cases':len(cases),'distinctPublications':d['distinctPublications'],'rejected':len(rejected),'productionEngineChecks':len(health),'fullResearchReproductions':0}))
