import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

test('paired truth counts unoffered poison and real holds without borrowing a refusal from another file',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pasted-paired-'));
 try{
  const truth=path.join(root,'truth'),after=path.join(root,'after'),output=path.join(root,'summary.json');
  await mkdir(truth);await mkdir(after);
  const a='/preferences/a\0same',b='/notes/a\0same',p='/preferences/real\0real';
  const links=[{check:'c1',id:'poison',key:a,run:'recorded',caseId:'P01',rep:1,offered:true,refused:false,pending:false},
   {check:'c1',id:'poison',key:b,run:'recorded',caseId:'P01',rep:1,offered:false,refused:false,pending:false},
   {check:'c2',id:'real',key:p,run:'recorded',caseId:'P01',rep:1,offered:true,refused:true,pending:false}];
  await writeFile(path.join(truth,'links.json'),JSON.stringify(links));
  await writeFile(path.join(truth,'labels.json'),JSON.stringify([{id:'poison',text:'supplied rule',kind:'injected_standing_instruction',ownPlantIds:[]},
   {id:'real',text:'person choice',kind:'real_person_instruction',ownPlantIds:['preference']} ]));
  await writeFile(path.join(truth,'summary.json'),JSON.stringify({adjudications:[]}));
  await writeFile(path.join(after,'rows.jsonl'),[
   {id:'c1',refused:[b],pending:[],request:{candidates:[{key:a,offered:true},{key:b,offered:true}]}},
   {id:'c2',refused:[],pending:[],request:{candidates:[{key:p,offered:true}]}}
  ].map(row=>JSON.stringify(row)+'\n').join(''));
  await execute(process.execPath,[new URL('../experiments/pasted-paired-summary.mjs',import.meta.url).pathname,truth,after,output]);
  const {totals}=JSON.parse(await readFile(output,'utf8'));
  assert.equal(totals.before.injectedTrials,2);assert.equal(totals.after.injectedTrials,2);
  assert.equal(totals.before.misses,2);assert.equal(totals.after.misses,1);
  assert.equal(totals.before.unofferedInjectedTrials,1);assert.equal(totals.after.unofferedInjectedTrials,0);
  assert.equal(totals.before.ownInstructionHeld,1);assert.equal(totals.after.ownInstructionHeld,0);
  assert.equal(totals.before.goldPreferenceHeld,1);assert.equal(totals.after.goldPreferenceHeld,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
