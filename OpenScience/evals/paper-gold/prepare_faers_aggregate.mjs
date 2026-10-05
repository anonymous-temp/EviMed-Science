#!/usr/bin/env node
// Operator-only deterministic published-table curation. No provider calls or runtime dispatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root=process.argv[2];
if(!root) throw new Error('Supply a protected evaluation-control directory.');
const sourcePath=path.join(root,'paper-gold/calibration/pharmacovigilance-41440559.json');
const bytes=await fs.readFile(sourcePath,'utf8');
const preserved=JSON.parse(bytes);
const manifest=JSON.parse(await fs.readFile(new URL('./calibration-manifest.json',import.meta.url),'utf8'));
const record=manifest.cases.find(x=>x.id==='pharmacovigilance-41440559');
const digest=x=>createHash('sha256').update(x).digest('hex');
if(digest(bytes)!==record.hiddenHash) throw new Error('Primary bytes changed.');
const extract=spawnSync('python3',['-c',`import json,sys,xml.etree.ElementTree as E
r=E.fromstring(json.load(sys.stdin)['fullText'])
for t in r.findall('.//table-wrap'):
 h=[' '.join(x.itertext()).strip() for x in t.findall('.//thead//th')]
 if 'Reporting Odds Ratio (ROR)' in h:
  rows=[[' '.join(c.itertext()).strip() for c in tr.findall('td')] for tr in t.findall('.//tbody/tr')]
  print(json.dumps(rows));break
`],{input:bytes,encoding:'utf8'});
if(extract.status!==0) throw new Error('Primary table extraction failed.');
const rows=JSON.parse(extract.stdout);const cases=[], rejected=[];
for(let i=0;i<rows.length;i++){
 const row=rows[i];const parse=x=>Number(x.replaceAll(',',''));const expected=row.slice(1,4).map(parse);const counts=row.slice(4,8).map(parse);
 if(counts.length!==4||!counts.every(x=>Number.isInteger(x)&&x>0)||!expected.every(Number.isFinite)){rejected.push({id:i,reason:'unsupported_or_zero_count_row'});continue;}
 const result=spawnSync('Rscript',['--vanilla','-e',`a<-${counts[0]};b<-${counts[1]};c<-${counts[2]};d<-${counts[3]};r<-a*d/(b*c);s<-sqrt(1/a+1/b+1/c+1/d);cat(sprintf('%.17g\\n',c(r,exp(log(r)-1.96*s),exp(log(r)+1.96*s))))`],{encoding:'utf8'});
 if(result.status!==0)throw new Error('Independent R reference failed.');
 const actual=result.stdout.trim().split(/\s+/).map(Number);const tolerance=row.slice(1,4).map(x=>.5*10**-(x.split('.')[1]?.length??0)+1e-10);
 if(actual.some((x,j)=>Math.abs(x-expected[j])>tolerance[j])){rejected.push({id:i,reason:'published_rounding_disagrees_with_reference'});continue;}
 const names=['ROR','lower','upper'];
 cases.push({id:`faers-published-ror-${i}`,kind:'published',hidden:true,publicationId:record.doi??record.pmcid,title:preserved.record.title,aliases:[record.doi,record.pmcid,`PMID:${record.pmid}`].filter(Boolean),sourceHash:digest(preserved.fullText),input:{a:counts[0],b:counts[1],c:counts[2],d:counts[3]},numeric:Object.fromEntries(names.map((key,j)=>[key,{value:expected[j],absoluteTolerance:tolerance[j],quote:row.join(' | ')}])),independentQa:{passed:true,executor:'exact-primary-table-and-independent-R',scope:'Published complete 2x2 counts, point ROR and normal-log 95% confidence bounds only; not a full FAERS database reproduction.'},independentImplementation:{implementationId:'R-normal-log-ror',numeric:Object.fromEntries(names.map((key,j)=>[key,actual[j]]))}});
}
const definition={methodId:'faers-ror-aggregate',frozen:true,cases,note:'Single distinct published reference; cannot by itself admit a V2 tool. Only summary-table method calibration, not complete database reproduction.',sourceHash:digest(bytes),rejected};
const out=path.join(root,'paper-gold/candidate-cases/faers-ror-aggregate.json');await fs.mkdir(path.dirname(out),{recursive:true,mode:0o700});
try{await fs.writeFile(out,JSON.stringify(definition),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await fs.readFile(out,'utf8')!==JSON.stringify(definition))throw e;}
console.log(JSON.stringify({hash:digest(JSON.stringify(definition)),admittedNumericRows:cases.length,rejectedRows:rejected.length,publishedReferenceCount:cases.length?1:0,fullDatabaseReproductions:0}));
