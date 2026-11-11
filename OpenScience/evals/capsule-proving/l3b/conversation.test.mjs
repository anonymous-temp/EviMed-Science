import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runConversation } from '../lx/conversation.mjs';

test('an interrupted learning conversation resumes its correction without replaying the completed first turn', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'l3b-resume-'));
  const calls=[], checkpoints=[];
  const api={call:async(method,url,body)=>{
    calls.push({method,url,body});
    if(url==='/api/projects')return {status:201};
    if(url==='/api/agent-runs/dispatch')return {status:202,json:{data:{id:'r2',status:'succeeded',automated:false}}};
    if(url==='/api/agent-runs')return {status:200,json:{data:[{id:'r2',status:'succeeded',automated:false}]}};
    return {status:200};
  }};
  try {
    const transcripts=`${dir}/users/u/projects/p/.openscience/transcripts`;
    await fs.mkdir(transcripts,{recursive:true});
    await fs.writeFile(`${transcripts}/r2.jsonl`,[{}, {role:'assistant',turn:0,parts:[{type:'text',text:'Corrected output'}]}].map(JSON.stringify).join('\n'));
    const resumeRecord={schema:'lx-conversation/1',projectId:'p',sessionId:'s',startedAt:new Date().toISOString(),turns:[{index:0,text:'Initial request',runId:'r1',reply:'Original output'}]};
    const record=await runConversation({api,userId:'u',projectId:'p',sessionId:'s',first:'Initial request',next:(_turn,i)=>i===0?'My explicit correction':null,
      dataDir:dir,outDir:`${dir}/saved`,timeoutMs:1000,log:()=>{},waitMemoryTools:false,maxTurns:2,resumeRecord,
      onTurn:async r=>checkpoints.push(structuredClone(r))});
    const dispatches=calls.filter(c=>c.url==='/api/agent-runs/dispatch');
    assert.equal(dispatches.length,1);assert.equal(dispatches[0].body.text,'My explicit correction');
    assert.equal(dispatches[0].body.dispatchId,'d_s_1');assert.equal(dispatches[0].body.automated,undefined);
    assert.deepEqual(record.turns.map(t=>t.runId),['r1','r2']);assert.equal(checkpoints[0].turns.length,2);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('a checkpoint from another session is refused before any API mutation',async()=>{
  await assert.rejects(runConversation({api:{call:()=>assert.fail('must not call')},userId:'u',projectId:'p',sessionId:'s',
    resumeRecord:{projectId:'other',sessionId:'s'},first:'x',next:()=>null,dataDir:'/unused',outDir:'/unused',timeoutMs:1,log:()=>{}}),/identity mismatch/);
});
