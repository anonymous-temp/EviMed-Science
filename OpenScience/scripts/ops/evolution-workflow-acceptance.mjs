// Engineering smoke only. Reuses the dedicated acceptance ledger; never scores papers or resets budgets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {createEvolutionWorkflowSmoke} from '../../apps/server/src/evolutionWorkflowSmoke.mjs';
import { waitForEvolutionTranscript } from './evolution-transcript-wait.mjs';
import {sourceToolResult} from './evolution-isolation-acceptance.mjs';
const sha=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function workflowAcceptanceFixture(probeId='v1'){
 if(!/^[a-z0-9_-]{1,40}$/.test(probeId))throw new Error('Invalid workflow probe identity.');
 return {methodId:'workflow-deduplication',caseId:`engineering-workflow-${probeId}`,replicate:0,
 input:{items:[{id:'a',title:'Synthetic alpha'},{id:'b',title:'Synthetic alpha'},{id:'c',title:'Synthetic beta'}]},
 candidate:{id:`workflow-deduplication-${probeId}`,track:'M',toolKind:'workflow',publicationKind:'skill',capabilityIds:['statistical-analysis'],executionTools:['evidence_deduplicate'],files:{'SKILL.md':'---\nname: workflow-deduplication\ndescription: Deduplicate supplied synthetic evidence records using the existing offline tool.\n---\n\nIn the current root run call the existing evidence_deduplicate tool with the exact supplied input.items. Do not delegate, write code, retrieve literature or calculate scientific results. Return workflowOutput:{uniqueCount:<length of actual tool data.items>,duplicateCount:<length of actual tool data.duplicates>}. Keep this skill unchanged in tool-candidate.json. Do not declare success without the tool result.\n'}}};
}
/** Actual DSH + production smoke helper; no runtime, tool or transcript substitute is accepted here. */
export async function runEvolutionWorkflowAcceptance({app,probeId='v1',signal,stagePublication=false}){
 assert.ok(app.config.dataDir==='/acceptance'&&String(app.config.databaseUrl??app.config.productDatabaseUrl).includes('evimed_test_evolution'),'Only the dedicated acceptance environment is permitted.');
 assert.ok(app.evolution?.runs&&app.evolution?.service&&app.store);
 assert.notEqual(app.evolution.worker?.running,true,'Wait for the preceding evolution job before this smoke.');app.evolution.worker?.stop();
 const fixture=workflowAcceptanceFixture(probeId),execute=createEvolutionWorkflowSmoke({service:app.evolution.service,runs:app.evolution.runs,store:app.store});
 const receipt=await execute({...fixture,signal});assert.equal(receipt.executed,true,'The workflow needs a complete successful actual-tool receipt.');assert.deepEqual(receipt.toolsCalled,['evidence_deduplicate']);
 const identity=sha([fixture.candidate.files,fixture.candidate.executionTools,fixture.input,fixture.caseId,fixture.methodId,fixture.replicate]).slice(0,32),userId=await app.evolution.service.owner();
 const project=await app.store.requireProject(await app.store.userById(userId),`eval-paper-workflow-${identity}`),transcript=await waitForEvolutionTranscript(project,receipt.runId, { signal });assert.equal(transcript.header.completeness,'complete');
 const calls=transcript.messages.flatMap(message=>message.parts??[]).filter(part=>part.type==='tool'&&part.status==='completed'&&String(part.tool).replace(/^mcp__evimed__/,'').split('/').at(-1)==='evidence_deduplicate').map(part=>sourceToolResult(part.output)).filter(result=>result?.ok===true);
 assert.ok(calls.length,'A successful existing-tool result must appear in the durable transcript.');const result=calls.at(-1).data;
 assert.equal(result.items.length,2);assert.equal(result.duplicates.length,1);assert.equal(receipt.output.uniqueCount,result.items.length);assert.equal(receipt.output.duplicateCount,result.duplicates.length);
 let staged=null;if(stagePublication){staged=await app.evolution.supply.publish(fixture.candidate,{card:{toolKind:'workflow'},evaluation:{ok:true,verificationLevel:'V0',smokePassed:true},activate:false});const frozen=await app.evolution.supply.candidateForEvaluation({id:staged.id,digest:staged.digest,revision:staged.revision});assert.equal(frozen.publicationKind,'skill');assert.deepEqual(frozen.files,fixture.candidate.files);}
 return {kind:'live-script-free-workflow-engineering-control',scored:false,runId:receipt.runId,projectId:project.id,toolsCalled:receipt.toolsCalled,transcriptHash:receipt.transcriptHash,uniqueCount:result.items.length,duplicateCount:result.duplicates.length,staged,activated:false};
}
async function main(){
 const probeId=process.argv.find(value=>value.startsWith('--probe='))?.slice(8)??'v1';
 if(!process.argv.includes('--execute')){process.stdout.write(JSON.stringify({kind:'workflow-acceptance-plan',scored:false,fixture:workflowAcceptanceFixture(probeId)},null,2)+'\n');return;}
 const input=JSON.parse(await fs.readFile(process.env.EVIMED_EVOLUTION_ACCEPTANCE_INPUT,'utf8'));
 assert.ok(input.dataDir==='/acceptance'&&String(input.databaseUrl).includes('evimed_test_evolution')&&String(input.runtimeImage).startsWith('evimed-evolution-acceptance:')&&String(input.network).startsWith('evimed-evolution-acceptance'));
 const {createEvolutionConfiguration}=await import('./evolution-acceptance-config.mjs'),{loadConfig}=await import('../../apps/server/src/config.mjs'),{createRuntimeController}=await import('../../apps/server/src/runtimeControllerServer.mjs'),{RuntimeControllerClient}=await import('../../apps/server/src/runtimeControllerClient.mjs'),{createWebApiApp}=await import('../../apps/server/src/server.mjs');
 const credentials=JSON.parse(await fs.readFile('/control-state/acceptance-credentials.json','utf8')),overrides=createEvolutionConfiguration(input,credentials),config=loadConfig(overrides),controller=createRuntimeController(config),abort=new AbortController();let app;
 process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
 try{await controller.listen();app=createWebApiApp({...overrides,evolutionController:new RuntimeControllerClient(config)});await app.listen(8787,'0.0.0.0');app.evolution.worker.stop();await app.store.bootstrapUserState();const result=await runEvolutionWorkflowAcceptance({app,probeId,signal:abort.signal,stagePublication:process.argv.includes('--stage-publication')});await fs.writeFile(path.join(input.dataDir,`workflow-acceptance-${probeId}.json`),JSON.stringify(result,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(result)+'\n');}finally{await app?.close();await controller.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
