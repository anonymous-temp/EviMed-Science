#!/usr/bin/env node
import { createNativeDsh } from './native_dsh.mjs';
// Bounded native DSH adapter for clinical_metrics.py. Prediction never opens a
// reference file. The operator key stays in the control plane, behind its real
// gateway and usage ledger. Only synthetic cases are accepted by this adapter.
import fs from 'node:fs/promises';
import { CLINICAL_FACT_CONTRACT } from '../../packages/domain/index.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { createModelGatewayHandler } from '../../apps/server/src/modelGateway.mjs';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { UsageLedger } from '../../apps/server/src/usageLedger.mjs';
import { composeVcr, vcrMatchingExecutor } from '../../apps/server/src/vcrComposition.mjs';
import { createVcrCloudEgress } from '../../apps/server/src/vcrCloudEgress.mjs';
import { vcrRuntimeWrite } from '../../apps/server/src/vcrGateway.mjs';
import { projectionHash, vcrCloudDestinations } from '../../apps/server/src/vcrCloudProjection.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['inputs','out','dsh','key-file','postgres','dump','repeats','limit'].map(key=>[key,{type:'string'}])) });
for (const key of ['inputs','out','dsh','key-file','postgres','dump']) if (!values[key]) throw new Error(`Required: --${key}`);
const root = path.resolve(values.out), product = fileURLToPath(new URL('../../',import.meta.url));
const cases = JSON.parse(await fs.readFile(values.inputs,'utf8'));
if (cases.dataClass !== 'synthetic' || !Array.isArray(cases.cases)) throw new Error('Only explicitly synthetic prediction inputs are accepted');
const repeats = Number(values.repeats ?? 2), limit = Number(values.limit ?? cases.cases.length);
if (!Number.isInteger(repeats) || repeats < 2 || repeats > 3 || limit < 1 || limit > 50) throw new Error('Invalid bounded evaluation size');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
await fs.mkdir(root,{recursive:true,mode:0o700});
const write = (name,data) => fs.writeFile(path.join(root,name),JSON.stringify(data,null,2)+'\n',{mode:0o600});
const skill = await fs.readFile(path.join(product,'capabilities/vcr-matching/SKILL.md'),'utf8');
const guidance = skill.slice(skill.indexOf('## Evidence-preserving cloud extraction'));
if (!guidance || guidance.length < 100) throw new Error('Clinical guidance heading not found');
const dump = await fs.readFile(values.dump,'utf8');
const pin = JSON.parse(await fs.readFile(path.join(product,'deps-version.json'),'utf8')).dsh;
const executableVersion = execFileSync(values.dsh,['--version'],{encoding:'utf8',env:{PATH:process.env.PATH,DSH_HOME:path.join(root,'version'),DSH_TELEMETRY_MODE:'DISABLED'}}).trim();
const identity = {schema:1,inputHash:hash(cases),skillHash:hash(skill),guidanceHash:hash(guidance),dumpHash:hash(dump),dsh:pin,executableVersion,
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:product,encoding:'utf8'}).trim(),
  sourceDiffHash:hash(execFileSync('git',['diff','HEAD'],{cwd:product,encoding:'utf8',maxBuffer:16*1024*1024})),repeats,limit,model:'deepseek-flash',maxTokens:4000,thinking:'disabled'};
const sourceFiles = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','OpenScience/apps/server/src','OpenScience/packages/domain','OpenScience/evals/method-quality','OpenScience/capabilities/vcr-matching'],{cwd:path.dirname(product.replace(/\/$/,'')),encoding:'utf8'}).split('\0').filter(Boolean);
identity.sourceFiles = {};
for (const name of sourceFiles) identity.sourceFiles[name] = hash(await fs.readFile(path.join(product,'..',name)));
await fs.writeFile(path.join(root,'source.patch'),execFileSync('git',['diff','HEAD'],{cwd:product,maxBuffer:16*1024*1024}),{mode:0o600});
const digest = hash(identity);
let existing;
try { existing=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')); } catch(error) { if(error.code!=='ENOENT')throw error; }
if (existing && existing.digest !== digest) throw new Error('Input/configuration changed; use a new output directory');
const manifest=existing ?? {...identity,digest,createdAt:new Date().toISOString(),runId:randomUUID()};
await write('manifest.json',manifest);
const config=loadConfig({localAutoConfig:false,dataDir:path.join(root,'control'),deepseekApiKeyFile:path.resolve(values['key-file']),deepseekProviderEnabled:true,
  production:false,modelGatewayTimeoutMs:120000,userDailySpendLimit:5,userWeeklySpendLimit:5,userRunSpendLimit:0.5,modelGatewayMaxOutputTokens:4000,
  vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:path.join(root,'protected')});
const database=new ControlPlaneDatabase({databaseUrl:values.postgres,databasePoolMax:3,databaseConnectionTimeoutMs:2000});
const ledger=new UsageLedger(database);await ledger.health();
const vcr=composeVcr({config,productDatabase:database});await vcr.store.ready();
const userId=`clinical-eval-${manifest.runId}`;
await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Synthetic clinical evaluation','development') ON CONFLICT DO NOTHING",[userId]);
const token=randomUUID();let active, requestChecks=0;
const runtimeManager={assertActiveModelGatewayToken(value){if(value!==token || !active)throw new Error('Invalid evaluation workload');return{userId,projectId:active.projectId,runId:active.runId,runLimit:0.5};}};
const egress=createVcrCloudEgress({store:vcr.store,resolveSession:async caller=>caller.sessionId,destinations:()=>vcrCloudDestinations(config)});
const handler=createModelGatewayHandler(config,runtimeManager,{usageLedger:ledger,attributeRun:async()=>active?.runId??null,
  assertModelAccess:async(caller,body)=>{if(++requestChecks>600)throw new Error('Evaluation request limit');active.sessionId=caller.sessionId;await egress(caller,body);}});
const server=createServer((req,res)=>handler(req,res,()=>{}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/internal/model/v1`;
const native=await createNativeDsh({root,executable:values.dsh,dump,gateway:base,token});
const predictions=[];
try {
  for(let repeat=0;repeat<repeats;repeat++) for(const example of cases.cases.slice(0,limit)) for(const arm of (repeat%2?['off','on','native']:['native','on','off'])) {
    const cell=`${example.id}-${arm}-${repeat}`, receiptPath=path.join(root,cell+'.json');
    try { const cached=JSON.parse(await fs.readFile(receiptPath,'utf8'));if(cached.digest!==digest)throw new Error('Receipt mismatch');predictions.push(cached);continue; } catch(error) { if(error.code!=='ENOENT')throw error; }
    const projectId=`eval-${randomUUID()}`,runId=`run-${randomUUID()}`;
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Synthetic clinical evaluation',10485760)",[userId,projectId]);
    const study=await vcr.store.createStudy({userId,projectId,name:'Synthetic extraction evaluation',question:'Synthetic regression',dataTier:'T0'});
    active={projectId,runId,sessionId:null};
    const source=await vcr.dataPlane.registerSource({userId,studyId:study.id,name:'Authored synthetic fixture'});
    const upload=await vcr.dataPlane.storeUpload({actor:userId,studyId:study.id,sourceId:source.id,name:'synthetic.txt',role:'document',subject:example.group,
      visibleAt:'2026-09-01T00:00:00Z',stream:Readable.from([example.text])});
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:userId,permission:{status:'approved',dataClass:'synthetic',purpose:'vcr',
      destinations:vcrCloudDestinations(config),reference:'Authored synthetic regression',retention:'unknown',training:'unknown',humanReview:'unknown'}});
    const projection=await vcr.dataPlane.createDocumentProjection({studyId:study.id,documentId:upload.file.id,actor:userId,sourceHash:projectionHash(example.text),spans:[],attestation:'Synthetic, no real person'});
    const subjectKey=upload.file.detail.subjectKey;
    const context={study,store:vcr.store,service:vcr.service,documents:vcr.documents,matching:vcr.matching,matchStore:vcr.matchStore,orchestrator:null,report:()=>{}};
    const protocol=await vcrRuntimeWrite({...context,what:'criteria',items:[{title:example.id,criteria:example.criteria}]});
    if(!protocol.ok)throw new Error(JSON.stringify(protocol.issues));
    const projected=await vcr.dataPlane.projectionText({studyId:study.id,documentId:projection.id,principal:userId},true);
    const prompt=`Extract sourced facts for this synthetic study. Return only JSON {"facts":[...]}. Each fact has subjectKey, documentId, variable, value (number or text), unit (optional), polarity (affirmed/negated/hypothetical/family), occurredAt (ISO date if explicit), surface (exact substring), quote (exact substring). Do not calculate eligibility. Optional clinical metadata follows the supplied schema when guidance is present. No invented measurements. Omit optional unknown fields. Clinical metadata belongs only inside clinical.\n${arm==='on'?guidance+'\n'+JSON.stringify({factContract:CLINICAL_FACT_CONTRACT}):''}\n${JSON.stringify({subjectKey,documentId:projection.id,text:projected.text,criteria:example.criteria,asOf:manifest.createdAt})}`;
    const started=Date.now();
    const {code,text:final}=await native({prompt,filename:cell});
    const output=await fs.readFile(path.join(root,cell+'.events.jsonl'),'utf8');
    let facts=[],parseError=null;
    try {const parsed=JSON.parse(final.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));if(!Array.isArray(parsed.facts))throw new Error('facts_missing');facts=parsed.facts;}catch(error){parseError=error.message;}
    const provenance={...await vcr.matchStore.producerContext(study,runId),skillDigest:arm==='on'?hash(skill):null,promptHash:hash(prompt),nativeSessionId:active.sessionId};
    const saved=await vcrRuntimeWrite({...context,what:'fact',items:facts,caller:{runtimeRunId:runId,provenance}});
    const built=await vcr.matching.matchScenario(study,{protocolVersionId:protocol.ids[0],subjectKeys:[subjectKey]});
    const evaluated=await vcrMatchingExecutor({store:vcr.store,matchStore:vcr.matchStore,documents:vcr.documents})({job:{id:runId,studyId:study.id,scenario:built.scenario,inputs:built.inputs},onProgress:async()=>{}});
    const usage=(await database.query('SELECT model,observed_model,status,request_fingerprint,actual_cost,currency,cache_hit_tokens,cache_miss_tokens,output_tokens FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=$2',[userId,runId])).rows;
    const receipt={digest,cell,caseId:example.id,group:example.group,arm,repeat,dataClass:'synthetic',code,parseError,latencyMs:Date.now()-started,sessionId:active.sessionId,
      predictionHash:hash(output),promptHash:hash(prompt),inputSnapshotId:evaluated.diagnostics.inputSnapshotId,usage,writeIssues:saved.issues,
      predicted:{labels:{[example.id]:evaluated.assessments[0]?.summary??'unknown'}},assessment:evaluated.assessments[0]??null,extractedFacts:facts};
    await write(cell+'.json',receipt);predictions.push(receipt);console.log(JSON.stringify({cell,code,parseError,writeIssues:saved.issues.length,summary:receipt.predicted.labels[example.id]}));
  }
  await write('predictions.json',{manifest,predictions});
} finally {await new Promise(r=>server.close(r));await database.close();}
