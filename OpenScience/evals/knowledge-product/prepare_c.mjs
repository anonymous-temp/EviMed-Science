// Disposable topic projects and official llm-wiki export; never compiles locally or substitutes generated pages.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { provision, checked } from './provision.mjs';
import { verifyLiveBudgetWiring,armSharedBudget,verifyBoundCollector } from './shared_budget.mjs';
import { compileExport } from './compile_export.mjs';
const root=new URL('.',import.meta.url).pathname;
const out=process.env.KNOWLEDGE_C_OUT??path.join(root,'results','2026-10-23-C-preflight');
await fs.mkdir(out,{recursive:true});
const config=process.env.KNOWLEDGE_C_CONFIG?JSON.parse(await fs.readFile(process.env.KNOWLEDGE_C_CONFIG,'utf8')):null;
const blocked=[];
if(!config?.base)blocked.push('Actual product control-plane URL missing');
if(!config?.dataDir)blocked.push('Owned isolated product data directory missing');
let collectorBinding=null;
try {
 await verifyLiveBudgetWiring(config?.sharedBudget);
 collectorBinding=(await verifyBoundCollector(config.base,'candidate',config.sharedBudget)).binding;
} catch(error) { blocked.push(error.message); }
if(config?.sharedBudgetId!==config?.sharedBudget?.sharedBudgetId)blocked.push('C must use the same live coordinator budget identity as both benchmark arms');
if(!config?.runtimeEvidence?.openVikingVersion||!config.runtimeEvidence?.model||!config.runtimeEvidence?.revision)blocked.push('Actual native engine/model/revision identity receipt missing');
const receipt={kind:'official-C-export-preflight',status:blocked.length?'blocked':'ready',blocked,spendCny:0,collectorBinding,trees:[]};
await fs.writeFile(path.join(out,'execution.json'),JSON.stringify(receipt,null,2));
if(!blocked.length&&process.argv.includes('--execute')){
 const benchmark=JSON.parse(await fs.readFile(path.join(root,'cases.json'),'utf8'));
 const privateDir=await fs.mkdtemp(path.join(os.tmpdir(),'knowledge-C-private-'));let ctx;
 try{
  await armSharedBudget(config.sharedBudget);
  receipt.collectorBinding=(await verifyBoundCollector(config.base,'candidate',config.sharedBudget)).binding;
  ctx=await provision({base:config.base,dataDir:config.dataDir,privateDir,benchmark,seedCorpus:false,arm:'candidate',sharedBudget:config.sharedBudget});
  const owner=ctx.accounts['account-alpha'];
  for(const topicId of ['af-doac-warfarin','sglt2-hf-ckd','aspirin-primary-prevention'])for(const repetition of [1,2,3]){
   const projectId=`${ctx.runId}_${topicId}_${repetition}`;await checked(owner.api,'POST','/api/projects',{id:projectId,name:projectId});owner.api.project=projectId;
   const sourceMap={};
   for(const source of benchmark.sources.filter(s=>s.path.includes(`/${topicId}/`))){
    const bytes=await fs.readFile(path.join(root,source.path));
    const data=await checked(owner.api,'POST','/api/files/upload',{root:'base',path:`knowledge-base/${source.id}.txt`,data:bytes.toString('base64'),encoding:'base64'});
    sourceMap[source.id]=data.source.id;
   }
   receipt.collectorBinding=(await verifyBoundCollector(config.base,'candidate',config.sharedBudget)).binding;
   receipt.trees.push(await compileExport({api:owner.api,projectId,sourceMap,outDir:out,topicId,repetition}));
   await fs.writeFile(path.join(out,'execution.json'),JSON.stringify({...receipt,status:'collecting'},null,2));
  }
  receipt.status='exported-awaiting-original-C-evaluation';delete receipt.spendCny;
 }catch(e){receipt.status='blocked';receipt.blocked.push(e.message);}finally{await ctx?.cleanup();await fs.rm(privateDir,{recursive:true,force:true});}
 await fs.writeFile(path.join(out,'execution.json'),JSON.stringify(receipt,null,2));
}
console.log(JSON.stringify({status:receipt.status,blocked:receipt.blocked,trees:receipt.trees.length}));
