#!/usr/bin/env python3
"""Stream fixed PhysioNet 2012 cohorts; baseline/first 48h only; no identifiers in exported analyses."""
import csv, gzip, tarfile, io, json, hashlib, pathlib, collections, math, os, subprocess
WORKSPACE=pathlib.Path(__file__).resolve().parents[3]
ROOT=pathlib.Path(os.environ.get('VCR_EVAL_OUTPUT', WORKSPACE/'.evimed-local/acceptance/vcr-professional-full-20261105/clinical')).resolve()
RAW=pathlib.Path(os.environ.get('VCR_EVAL_RAW_DIR', WORKSPACE/'.evimed-local/acceptance/vcr-benchmark-20261029/numeric/raw')).resolve()
if '--show-paths' in os.sys.argv:
 print(json.dumps({'input':str(RAW),'output':str(ROOT)})); raise SystemExit(0)
ROOT.mkdir(parents=True,exist_ok=True)
FEATURES=['Age','Gender','Height','ICUType','Weight','Albumin','ALP','ALT','AST','Bilirubin','BUN','Cholesterol','Creatinine','DiasABP','FiO2','GCS','Glucose','HCO3','HCT','HR','K','Lactate','Mg','MAP','MechVent','Na','NIDiasABP','NIMAP','NISysABP','PaCO2','PaO2','pH','Platelets','RespRate','SaO2','SysABP','Temp','TroponinI','TroponinT','Urine','WBC']
static={'Age','Gender','Height','ICUType','Weight'}
out={}; idsets={}
for split in 'abc':
 labels={}
 with (RAW/f'Outcomes-{split}.txt').open(newline='') as f:
  for row in csv.DictReader(f): labels[row['RecordID']]=int(row['In-hospital_death'])
 records={}; counts=collections.Counter(); valid=collections.Counter(); patient_seen=collections.defaultdict(set); times=collections.defaultdict(collections.Counter); rows=0; abnormal=collections.Counter(); outside=0
 with tarfile.open(RAW/f'set-{split}.tar.gz','r:gz') as archive:
  for member in archive:
   if not member.isfile() or not member.name.endswith('.txt'): continue
   rd=csv.DictReader(io.TextIOWrapper(archive.extractfile(member),encoding='utf-8-sig',newline=''))
   pid=pathlib.PurePosixPath(member.name).stem; per=collections.defaultdict(list); seen_id=None
   for row in rd:
    rows+=1; field=row['Parameter']; counts[field]+=1
    if field=='RecordID': seen_id=row['Value'].strip();continue
    if field not in FEATURES: abnormal[field]+=1; continue
    try:
     h,m=map(int,row['Time'].split(':')); minute=h*60+m; value=float(row['Value'])
    except (ValueError,KeyError): abnormal['invalid_row']+=1;continue
    if minute<0 or minute>2880: outside+=1;continue
    if not math.isfinite(value) or value==-1: continue
    if field in static and minute!=0: continue
    valid[field]+=1; patient_seen[field].add(pid); times[field][minute]+=1
    per[field].append(value)
   if seen_id != pid or pid in records or pid not in labels: raise ValueError('patient mapping mismatch')
   records[pid]={k:(sum(v)/len(v) if v else None) for k,v in per.items()}
 idsets[split]=set(records)
 if len(records)!=4000 or len(labels)!=4000 or set(labels)!=set(records): raise ValueError('unexpected cohort size')
 # Records preserve split ordering, identifiers mapped to opaque ordinal within split, never exported beyond local ignored directory.
 fields=['USUBJID']+FEATURES+(['mortality'] if split=='a' else [])
 with (ROOT/f'phys_{split}_features.csv').open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
  for i,pid in enumerate(sorted(records)):
   row={'USUBJID':f'{split.upper()}{i+1:04d}',**records[pid]}
   if split=='a':row['mortality']=labels[pid]
   w.writerow(row)
 if split!='a':
  with (ROOT/f'phys_{split}_labels.csv').open('w',newline='') as f:
   w=csv.writer(f);w.writerow(['USUBJID','mortality']);w.writerows((f'{split.upper()}{i+1:04d}',labels[pid]) for i,pid in enumerate(sorted(records)))
 out[split]={'patients':len(records),'raw_rows':rows,'variables_seen':dict(sorted(counts.items())),'valid_first48h_rows':dict(sorted(valid.items())),'missing_patients_by_feature':{k:4000-len(patient_seen[k]) for k in FEATURES},'unique_time_points':{k:len(times[k]) for k in FEATURES},'outside_48h_rows':outside,'unexpected_rows':dict(abnormal),'mortality_events':sum(labels.values())}
assert not (idsets['a'] & idsets['b'] or idsets['a'] & idsets['c'] or idsets['b'] & idsets['c'])
(ROOT/'phys_audit.json').write_text(json.dumps({'splits':out,'feature_count':len(FEATURES),'method':'Admission descriptors at 00:00; remaining variables mean of observed values through 48:00; no imputation during extraction; no outcomes among predictors. Original irregular times preserved in raw archives; counts and distinct time points retained in audit.','no_id_overlap':True},indent=2))
print(json.dumps({s:{k:out[s][k] for k in ['patients','raw_rows','mortality_events']} for s in out}))
# Fit preprocessing only on split A and carry the frozen recipe to B/C.
def readrows(p):
 with p.open(newline='') as f:return list(csv.DictReader(f))
def median(x):
 x=sorted(x); n=len(x); return (x[(n-1)//2]+x[n//2])/2
train=readrows(ROOT/'phys_a_features.csv'); prepared={s:readrows(ROOT/f'phys_{s}_features.csv') for s in 'abc'}
recipe={}; skipped=[]
for name in FEATURES:
 vals=[float(r[name]) for r in train if r[name] != '']
 if not vals or len(set(vals))<2: skipped.append(name);continue
 recipe[name]={'median':median(vals),'missingIndicator':len(vals)<len(train)}
columns=['USUBJID']+[x for name,info in recipe.items() for x in ([name, name+'_missing'] if info['missingIndicator'] else [name])]
for split,data in prepared.items():
 path=ROOT/('engine_train.csv' if split=='a' else f'analysis_{split}.csv')
 with path.open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=columns+(['mortality'] if split=='a' else []));w.writeheader()
  for r in data:
   outrow={'USUBJID':r['USUBJID']}
   for name,info in recipe.items():
    missing=r[name]=='';outrow[name]=info['median'] if missing else float(r[name])
    if info['missingIndicator']:outrow[name+'_missing']=int(missing)
   if split=='a':outrow['mortality']=int(r['mortality'])
   w.writerow(outrow)
(ROOT/'preprocessing.json').write_text(json.dumps({'feature_method':'A-only median imputation and missing indicators; omitted A-constant variables; same recipe applied to B/C','recipe':recipe,'skipped':skipped,'output_predictors':len(columns)-1},indent=2))
