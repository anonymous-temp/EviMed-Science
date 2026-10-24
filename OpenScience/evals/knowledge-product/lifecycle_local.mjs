// Local real PostgreSQL + real HTTP boundary. Mock kernel only: never answer-quality evidence.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createWebApiApp } from '../../apps/server/src/server.mjs';
import { provision, runLifecycle } from './provision.mjs';
import { compileExport } from './compile_export.mjs';
const databaseUrl=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
if(!databaseUrl)throw new Error('Set OPEN_SCIENCE_TEST_POSTGRES_URL to the owned isolated PostgreSQL database');
const url=new URL(databaseUrl);
if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/evimed_test_knowledge_evaluation_'))throw new Error('Refuse non-owned test database');
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'evimed-knowledge-eval-'));
const app=createWebApiApp({dataDir,port:0,runtimeMode:'mock',devAuth:false,authMode:'local',bootstrapUser:'',bootstrapPassword:'',stateStore:'postgres',requireSharedStateStore:true,databaseUrl,sourceIngestionEnabled:true,sourceIngestionPollMs:10000,sourceMetadataEnabled:false,modelGatewayEnabled:false,kbSearchEnabled:false,ovKnowledgeEnabled:false,autopilotEnabled:false});
let ctx;
try{
 const addr=await app.listen(0,'127.0.0.1');
 await app.sourceWorker?.close();
 const benchmark=JSON.parse(await fs.readFile(new URL('./cases.json',import.meta.url),'utf8'));
 ctx=await provision({base:`http://127.0.0.1:${addr.port}`,dataDir,privateDir:path.join(dataDir,'credentials'),benchmark,runtimeMode:'mock'});
 const report=await runLifecycle(benchmark,ctx);
 report.sourceBindings=Object.keys(ctx.bindings.accounts['account-alpha'].projects['project-alpha'].sourceMap).length;
 report.runtimeMode='mock'; report.modelSpendCny=0;
 report.originalRoundTrips=[];
 const owner=ctx.accounts['account-alpha'];owner.api.project=owner.projects['project-alpha'].id;
 for(const id of ['general-support','general-budget']){
   const source=benchmark.sources.find(s=>s.id===id),original=owner.projects['project-alpha'].originalFiles[id];
   const response=await fetch(`${ctx.base}/api/files/download/${encodeURIComponent(original)}?root=${source.originalOnly?'workspace':'base'}`,{headers:{Cookie:owner.api.cookie,'x-open-science-project':owner.api.project}});
   const bytes=Buffer.from(await response.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
   if(response.status!==200||sha256!==source.sha256)throw new Error('Original PDF/ZIP upload/download integrity failed');
   report.originalRoundTrips.push({sourceId:id,format:source.originalOnly?'zip-original-only':'pdf',status:response.status,sha256,bytes:bytes.length,parserExecuted:false,qualityClaim:false});
 }

 try {
  const owner=ctx.accounts['account-alpha'];
  await compileExport({api:owner.api,projectId:owner.projects['project-alpha'].id,sourceMap:owner.projects['project-alpha'].sourceMap,outDir:path.join(dataDir,'C-export'),topicId:'af-doac-warfarin',repetition:1,timeoutMs:1000});
  throw new Error('Unexpected official compile in lifecycle-only mock exercise');
 } catch(error) { report.officialCPreflight={status:'blocked',reason:error.message,trees:0}; }
 const out=process.env.KNOWLEDGE_EVAL_OUT??new URL('./results/2026-10-23-lifecycle-http',import.meta.url).pathname;
 await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'lifecycle.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({kind:report.kind,counts:report.counts,sourceBindings:report.sourceBindings,modelSpendCny:0}));
}finally{
 try{await ctx?.cleanup();}finally{await app.close();await fs.rm(dataDir,{recursive:true,force:true});}
}
