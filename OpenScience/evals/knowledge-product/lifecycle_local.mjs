// Local real PostgreSQL + real HTTP boundary. Mock kernel only: never answer-quality evidence.
import fs from 'node:fs/promises';
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
 ctx=await provision({base:`http://127.0.0.1:${addr.port}`,dataDir,privateDir:path.join(dataDir,'credentials'),benchmark});
 const report=await runLifecycle(benchmark,ctx);
 report.sourceBindings=Object.keys(ctx.bindings.accounts['account-alpha'].projects['project-alpha'].sourceMap).length;
 report.runtimeMode='mock'; report.modelSpendCny=0;
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
