import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportArtifacts, validateArtifacts } from './artifact-export.mjs';

test('every declared artifact is registered before download and failure survives as export_failed',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'artifact-export-'));let saves=[];
  try {
    const result={run:{outputFiles:['timeout.txt','stream.txt','large.bin','ok.txt']}};
    const fetcher=async url=>{assert.equal(result.artifacts.length,4);if(url.endsWith('timeout.txt'))throw Object.assign(new Error('timeout'),{name:'TimeoutError'});if(url.endsWith('stream.txt'))return{ok:true,body:(async function*(){yield Buffer.from('part');throw new Error('stream error');})()};if(url.endsWith('large.bin'))return{ok:true,body:(async function*(){yield Buffer.alloc(10*1024*1024+1);})()};return{ok:true,body:(async function*(){yield Buffer.from('ok');})()};};
    await exportArtifacts({result,caseId:'01',base:'http://local',headers:{},projectId:'p',root,fetcher,save:async()=>{saves.push(structuredClone(result.artifacts));}});
    assert.deepEqual(saves[0].map(x=>x.status),['pending','pending','pending','pending']);
    assert.deepEqual(result.artifacts.map(x=>x.status),['export_failed','export_failed','export_failed','saved']);
    assert.match(result.artifacts[0].error,/timeout/);assert.match(result.artifacts[1].error,/stream/);assert.match(result.artifacts[2].error,/size_limit/);
    await assert.rejects(validateArtifacts(result,root));
    result.artifacts=result.artifacts.slice(3);result.run.outputFiles=['ok.txt'];result.artifacts[0].index=0;await validateArtifacts(result,root);
    result.artifacts=[];await assert.rejects(validateArtifacts(result,root),/coverage/);
  }finally{await rm(root,{recursive:true,force:true});}
});
