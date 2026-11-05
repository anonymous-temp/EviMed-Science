#!/usr/bin/env python3
"""Compare declared filled-value relationships on every generated row and copy."""
import collections, csv, json, os, pathlib
p=pathlib.Path(os.environ['VCR_EVAL_OUTPUT']).resolve()
recipe=json.loads((p/'preprocessing.json').read_text())['recipe']
fields={k:v for k,v in recipe.items() if v['missingIndicator']}
with (p/'engine_train.csv').open(newline='') as f:
 rows=list(csv.DictReader(f))
anchors={}
for name in fields:
 vals={float(r[name]) for r in rows if r[name+'_missing']=='1'}
 if len(vals)!=1: raise ValueError('Source encoding does not bind exactly one value: '+name)
 anchors[name]=vals.pop()
counts=collections.Counter(); violations=collections.Counter();invalid=collections.Counter()
with (p/'full-engine-output'/'synthetic-population.csv').open(newline='') as f:
 for row in csv.DictReader(f):
  copy=row['copy'];counts[copy]+=1
  for name in fields:
   try: flag=float(row[name+'_missing']);value=float(row[name])
   except (ValueError,KeyError): invalid[(copy,name)]+=1;continue
   if flag not in (0,1): invalid[(copy,name)]+=1
   elif flag==1 and value!=anchors[name]: violations[(copy,name)]+=1
out={'declaredRuleCount':len(fields),'sourceRows':len(rows),'rowsByCopy':dict(counts),
     'violationsByCopy':{copy:sum(v for (c,_),v in violations.items() if c==copy) for copy in counts},
     'invalidByCopy':{copy:sum(v for (c,_),v in invalid.items() if c==copy) for copy in counts},
     'scope':'Exact IEEE double equality to the marked source-table fill; no inference from column names.'}
(p/'encoding-validation.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out))
