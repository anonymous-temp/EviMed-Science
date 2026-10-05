#!/usr/bin/env python3
"""Operator-only: freeze the published-table reference cases of the pharmacovigilance method ruler.

A ruler reports disagreement; it does not remove it. This script used to admit a published table row
only when (a) the textbook ROR formula applied to the paper's own counts reproduced the printed ROR and
bounds, and (b) the production engine equalled that formula to 1e-10 (an `assert`). The engine was then
scored on what was left: 19 of 65 usable rows had been dropped, and 92/92 could not have been anything
else (review finding B4).

What it does now:
  - it never imports or runs the engine. Nothing here can see an engine output;
  - a row is admitted on source integrity alone: it is a row of the exact preserved table (the file's
    hash is checked), with four integer counts and a printed ROR with both bounds;
  - the only exclusion is fixed by rule before any scoring and is written per row into the frozen
    definition: a zero cell in a source that computes uncorrected ratios, where the ROR is undefined;
  - whether the textbook formula reproduces the printed numbers from the printed counts is recorded on
    the case (`referenceConsistency`), with the 1.96 the engine and most papers use and with the exact
    normal quantile some pipelines use. It is context for reading a disagreement, never a filter;
  - the reference is the printed number, accepted to half a unit of its last printed digit
    (`tolerance.mjs`; the port lives in score_existing_methods.py).

`score_existing_methods.py` then scores the engine on every admitted case and reports agree, disagree and
could-not-run with their reasons.
"""
import argparse,csv,hashlib,json,math,pathlib,re,subprocess,sys,xml.etree.ElementTree as E
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from score_existing_methods import printed_number,default_half_width

METHOD_ID='faers-ror-published-data-v4'
# Each source's own stated specification, quoted from its methods. `correction` is what the source says
# it adds to every cell; a source that computes uncorrected ratios has no finite ROR for a zero cell.
SOURCES=[
 {'publicationId':'10.3390/medsci13040327','kind':'calibration-json','file':'calibration/pharmacovigilance-41440559.json','correction':0,
  'specification':'Published 2x2 counts with point ROR and 95% bounds in separate columns; uncorrected.'},
 {'publicationId':'10.3390/ijerph23081088','kind':'pmc-xml','file':'method-sources/PMC13513629.xml','table':'ijerph-23-01088-t002','ratioColumn':5,'correction':0,
  'specification':'exp[ln(ROR) +/- 1.96 x sqrt(1/a + 1/b + 1/c + 1/d)]; "Uncorrected estimates required nonzero cells."'},
 {'publicationId':'10.3390/ph19081181','kind':'pmc-xml','file':'method-sources/PMC13516650.xml','table':'pharmaceuticals-19-01181-t001','ratioColumn':6,'correction':0.5,
  'specification':'"For all 2 x 2 tables, a Haldane-Anscombe continuity correction of 0.5 was added to every cell to calculate the ROR, PRR, and 95% CI."'},
 {'publicationId':'10.3389/fphar.2025.1682276','kind':'pmc-xml','file':'method-sources/PMC12823856.xml','table':'T2','ratioColumn':6,'correction':0,'section':'FAERS',
  'specification':'ROR 95% CI = exp(ln(ROR) +/- 1.96 x sqrt(1/a + 1/b + 1/c + 1/d)); only the FAERS section of the table (the CVAR and JADER sections are other databases).'},
 {'publicationId':'10.1007/s00210-026-05748-1','kind':'author-csv','file':'method-sources/chei-all_ror_tests.csv','correction':0,
  'specification':'Author aggregate table: primary comparator (C1) rows computed without the Haldane correction; Wald intervals.'},
]
Z_ROUNDED=1.96
Z_EXACT=1.959963984540054  # qnorm(0.975)

def wald(counts,z):
 a,b,c,d=counts;value=a*d/(b*c);se=math.sqrt(1/a+1/b+1/c+1/d)
 return [value,math.exp(math.log(value)-z*se),math.exp(math.log(value)+z*se)]

def reference(value,printed):
 """One printed number as a frozen reference: the tolerance is the printed precision, by rule."""
 row={'value':value,'printed':printed,'quantity':'ratio'}
 return {**row,'absoluteTolerance':default_half_width(row),'relativeTolerance':0,'toleranceBasis':'printed-precision'}

def reproduces(computed,numeric):
 return all(abs(computed[i]-numeric[key]['value'])<=numeric[key]['absoluteTolerance'] for i,key in enumerate(['ROR','lower','upper']))

def rows_of(root,source):
 """Yield (label, counts, printed tokens) for every data row of one preserved source."""
 path=root/'paper-gold'/source['file'];raw=path.read_bytes()
 if source['kind']=='calibration-json':
  manifest=json.loads((pathlib.Path(__file__).resolve().parent/'calibration-manifest.json').read_text())
  record=next(x for x in manifest['cases'] if x['id']=='pharmacovigilance-41440559')
  if hashlib.sha256(raw).hexdigest()!=record['hiddenHash']:raise ValueError('Preserved primary bytes changed')
  text=json.loads(raw)['fullText'];document=E.fromstring(text);source_hash=hashlib.sha256(text.encode()).hexdigest()
  for table in document.findall('.//table-wrap'):
   headers=[' '.join(x.itertext()).strip() for x in table.findall('.//thead//th')]
   if 'Reporting Odds Ratio (ROR)' not in headers:continue
   for index,tr in enumerate(table.findall('.//tbody/tr')):
    cells=[' '.join(c.itertext()).strip() for c in tr.findall('td')]
    yield source_hash,f'row-{index}',cells[4:8],cells[1:4]
   return
  raise ValueError('Primary ROR table not found')
 source_hash=hashlib.sha256(raw).hexdigest()
 if source['kind']=='author-csv':
  for index,row in enumerate(csv.DictReader(raw.decode('utf-8-sig').splitlines())):
   # The selection is the source's own: its primary comparator, computed without the Haldane correction.
   if row['comparator']!='C1' or row.get('haldane')!='0':continue
   yield source_hash,str(index)+row['exposure']+row['family']+row['stratum'],[row[k] for k in 'abcd'],[row[k] for k in ['ror','ci_lo','ci_hi']]
  return
 table=E.fromstring(raw).find(f'.//table-wrap[@id="{source["table"]}"]');active=source.get('section') is None
 for tr in table.findall('.//tbody/tr'):
  cells=[' '.join(c.itertext()).strip() for c in tr.findall('td')]
  if source.get('section') and len(cells)==1 and cells[0] in ['FAERS','CVAR','JADER']:active=cells[0]==source['section']
  if not active or len(cells)<=source['ratioColumn']:continue
  yield source_hash,cells[0],cells[1:5],re.findall(r'\d+(?:\.\d+)?',cells[source['ratioColumn']])[:3]

def main():
 p=argparse.ArgumentParser();p.add_argument('evaluation_dir');a=p.parse_args();root=pathlib.Path(a.evaluation_dir).resolve()
 cases=[];excluded=[];sources=[]
 for source in SOURCES:
  entered=admitted=0
  for source_hash,label,count_cells,printed in rows_of(root,source):
   try:counts=[int(str(x).replace(',','')) for x in count_cells]
   except ValueError:continue
   # A row of the table that prints no ratio with both bounds is not a reference case of any kind.
   if len(counts)!=4 or len(printed)!=3 or min(counts)<0 or any(printed_number(x) is None for x in printed):continue
   entered+=1;identity='faers-'+hashlib.sha256((source['publicationId']+label).encode()).hexdigest()[:24]
   if min(counts)==0 and not source['correction']:
    excluded.append({'id':identity,'publicationId':source['publicationId'],'reason':'zero_cell_ratio_undefined_without_correction','rule':'fixed-before-scoring'});continue
   adjusted=[x+source['correction'] for x in counts];numeric={key:reference(printed_number(printed[i])[0],printed[i]) for i,key in enumerate(['ROR','lower','upper'])}
   rounded=wald(adjusted,Z_ROUNDED);admitted+=1
   cases.append({'id':identity,'kind':'published','hidden':True,'publicationId':source['publicationId'],'sourceHash':source_hash,
    'input':dict(zip('abcd',adjusted)),'originalCounts':dict(zip('abcd',counts)),'continuityCorrection':source['correction'],'numeric':numeric,
    # The row is bonded to its source. Nothing about any engine entered this decision.
    'independentQa':{'passed':True,'executor':'exact-preserved-table-row','scope':'Published complete four-cell aggregate ROR with its printed bounds; not full database ingestion, confounding control, or clinical causation.'},
    'independentImplementation':{'implementationId':'python-normal-log-ror-z1.96','numeric':dict(zip(['ROR','lower','upper'],rounded))},
    'referenceConsistency':{'wald196ReproducesPrinted':reproduces(rounded,numeric),'waldExactQuantileReproducesPrinted':reproduces(wald(adjusted,Z_EXACT),numeric)}})
  sources.append({'publicationId':source['publicationId'],'specification':source['specification'],'continuityCorrection':source['correction'],'rowsEntered':entered,'admitted':admitted,'excludedBeforeScoring':entered-admitted})
 # The independent implementation is checked against base R once, in one process, for every case.
 program='x<-read.csv(file("stdin"),header=FALSE);for(i in seq_len(nrow(x))){v<-as.numeric(x[i,]);r<-v[1]*v[4]/(v[2]*v[3]);s<-sqrt(sum(1/v));cat(sprintf("%.17g,%.17g,%.17g\\n",r,exp(log(r)-1.96*s),exp(log(r)+1.96*s)))}'
 result=subprocess.run(['Rscript','--vanilla','-e',program],input='\n'.join(','.join(repr(float(case['input'][k])) for k in 'abcd') for case in cases)+'\n',capture_output=True,text=True,check=True)
 for case,line in zip(cases,result.stdout.strip().splitlines(),strict=True):
  if any(abs(float(x)-case['independentImplementation']['numeric'][key])>1e-12*max(1,abs(float(x))) for x,key in zip(line.split(','),['ROR','lower','upper'])):raise ValueError('Python and R disagree on the textbook formula')
 definition={'methodId':METHOD_ID,'frozen':True,'schemaVersion':2,
  'admission':{'rule':'A row of the exact preserved table with four integer counts and a printed ROR with both bounds. Excluded only when a cell is zero and the source computes uncorrected ratios.','engineOutputRead':False,'fixedBeforeScoring':True},
  'cases':cases,'excluded':excluded,'sources':sources,'rowsEntered':sum(s['rowsEntered'] for s in sources),'distinctPublications':len(set(c['publicationId'] for c in cases)),'fullDatabaseReproductions':0}
 serialized=json.dumps(definition,separators=(',',':'));out=root/'paper-gold/candidate-cases'/f'{METHOD_ID}.json';out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if out.exists():assert out.read_text()==serialized,'Frozen reference changed'
 else:out.write_text(serialized);out.chmod(0o600)
 consistency=[c['referenceConsistency'] for c in cases]
 print(json.dumps({'methodId':METHOD_ID,'hash':hashlib.sha256(serialized.encode()).hexdigest(),'rowsEntered':definition['rowsEntered'],'cases':len(cases),'excludedBeforeScoring':len(excluded),
  'distinctPublications':definition['distinctPublications'],'sources':sources,
  'referenceConsistency':{'wald196':sum(x['wald196ReproducesPrinted'] for x in consistency),'exactQuantileOnly':sum(x['waldExactQuantileReproducesPrinted'] and not x['wald196ReproducesPrinted'] for x in consistency),'neither':sum(not x['waldExactQuantileReproducesPrinted'] and not x['wald196ReproducesPrinted'] for x in consistency)},
  'fullResearchReproductions':0}))

if __name__=='__main__':main()
