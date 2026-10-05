#!/usr/bin/env node
// Public published interval inputs; expected transformations are independently derived, never described as paper-reported gold.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { calibrationTextView } from '../../apps/server/src/paperGoldCalibration.mjs';
const root=process.argv[2];if(!root)throw new Error('Supply the protected evaluation-control directory.');
const manifest=JSON.parse(await fs.readFile(new URL('./calibration-manifest.json',import.meta.url),'utf8'));
const digest=x=>createHash('sha256').update(x).digest('hex');
const number='[-+−]?(?:£|\\$)?\\d+(?:,\\d{3})*(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
const pattern=new RegExp(`(${number})\\s*%?\\s*[,;(]?\\s*(?:\\(\\s*)?95\\s*%\\s*(?:CI|confidence interval)(?:\\s*\\(CI\\))?\\s*[:=,(\\[]?\\s*(${number})\\s*%?\\s*(?:to|–|−|‐|-|,)\\s*(${number})`,'gi');
const cases=[],missing=[];
for(const record of manifest.cases){
 const raw=await fs.readFile(path.join(root,'paper-gold/calibration',`${record.id}.json`),'utf8');if(digest(raw)!==record.hiddenHash)throw new Error('Primary bytes changed.');
 const primary=JSON.parse(raw);const text=calibrationTextView(primary.fullText);let admitted=false;
 for(const match of text.matchAll(pattern)){
  const values=match.slice(1,4).map(s=>Number(s.replace('−','-').replaceAll(',','').replace(/[£$]/g,'')));const [effect,lower,upper]=values;
  const context=text.slice(Math.max(0,match.index-100),match.index+match[0].length);const scale=/\b(?:OR|HR|RR|ROR|PRR|odds ratio|hazard ratio|risk ratio)\b/i.test(context)?'log-ratio':/(?:\b(?:SMD|WMD|MD|g|beta|mean difference|effect estimate|costs|QALYs)\b|β)/i.test(context)?'identity':null;
  if(!scale||!values.every(Number.isFinite)||!(lower<effect&&effect<upper)||(scale==='log-ratio'&&lower<=0))continue;
  const r=spawnSync('Rscript',['--vanilla','-e',`x<-c(${values.join(',')});if('${scale}'=='log-ratio')x<-log(x);cat(sprintf('%.17g\\n',c(x[1],(x[3]-x[2])/(2*1.959963984540054))))`],{encoding:'utf8'});if(r.status!==0)throw new Error('Independent R interval transformation failed.');
  const outputs=r.stdout.trim().split(/\s+/).map(Number);const independent=[scale==='log-ratio'?Math.log(effect):effect,((scale==='log-ratio'?Math.log(upper):upper)-(scale==='log-ratio'?Math.log(lower):lower))/(2*1.959963984540054)];
  if(outputs.some((x,i)=>!Number.isFinite(x)||Math.abs(x-independent[i])>1e-12))throw new Error('Cross-implementation disagreement.');
  cases.push({id:`interval-${record.id}`,track:record.track,kind:'published',hidden:true,publicationId:record.doi??record.pmcid,title:primary.record.title,aliases:[record.doi,record.pmcid,record.pmid?`PMID:${record.pmid}`:null].filter(Boolean),sourceHash:digest(primary.fullText),sourceViewHash:digest(text),input:{effect,lower,upper,scale,confidence:.95},inputQuote:context,numeric:{transformedEffect:{value:outputs[0],absoluteTolerance:1e-12},approximateStandardError:{value:outputs[1],absoluteTolerance:1e-12}},independentQa:{passed:true,executor:'exact-primary-interval-and-R-JavaScript',scope:'Normal-approximation interval transformation of published inputs only. Derived reference outputs, not paper-reported estimates; not original model standard errors or full research reproduction.'},independentImplementation:{implementationId:'R-interval-transform',numeric:{transformedEffect:outputs[0],approximateStandardError:outputs[1]}}});admitted=true;break;
 }
 if(!admitted)missing.push({id:record.id,reason:'explicit_effect_interval_not_machine_extractable'});
}
const definition={methodId:'published-interval-transformation-v2',frozen:true,cases,missing,note:'Public input intervals and mathematically derived independent references only. No claim to reproduce original models or database analyses.'};
const file=path.join(root,'paper-gold/candidate-cases/published-interval-transformation-v2.json');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
try{await fs.writeFile(file,JSON.stringify(definition),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await fs.readFile(file,'utf8')!==JSON.stringify(definition))throw e;}
console.log(JSON.stringify({hash:digest(JSON.stringify(definition)),byTrack:Object.fromEntries(['meta','pharmacovigilance','mr'].map(track=>[track,cases.filter(x=>x.track===track).length])),missing:missing.length,fullResearchReproductions:0}));
