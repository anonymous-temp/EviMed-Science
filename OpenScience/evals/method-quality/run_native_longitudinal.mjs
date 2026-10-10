#!/usr/bin/env node
// Real multi-turn DSH + existing VCR MCP/gateways. Synthetic data only; the
// provider key is read by the control plane and never passed to either child.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNativeDsh } from './native_dsh.mjs';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { createModelGatewayHandler } from '../../apps/server/src/modelGateway.mjs';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { UsageLedger } from '../../apps/server/src/usageLedger.mjs';
import { composeVcr } from '../../apps/server/src/vcrComposition.mjs';
import { createVcrCloudEgress } from '../../apps/server/src/vcrCloudEgress.mjs';
import { createVcrGatewayHandler } from '../../apps/server/src/vcrGateway.mjs';
import { vcrCloudDestinations } from '../../apps/server/src/vcrCloudProjection.mjs';

import { createGeoTestDatabase } from '../../apps/server/test/helpers/geoTestDatabase.mjs';

const {values}=parseArgs({options:Object.fromEntries(['out','dsh','key-file','postgres','dump'].map(key=>[key,{type:'string'}]))});
for(const key of ['out','dsh','key-file','postgres','dump'])if(!values[key])throw new Error(`Required --${key}`);
const root=path.resolve(values.out);await fs.mkdir(root,{recursive:true,mode:0o700});
const product=fileURLToPath(new URL('../../',import.meta.url));
const tracked=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','OpenScience/apps/server/src','OpenScience/packages/domain','OpenScience/evals/method-quality','OpenScience/capabilities/vcr-analysis','OpenScience/runtime/mcp/evimed-research/vcr_platform.py'],{cwd:path.dirname(product.replace(/\/$/,'')),encoding:'utf8'}).split('\0').filter(Boolean);
const sourceFiles={};for(const name of tracked)sourceFiles[name]=createHash('sha256').update(await fs.readFile(path.join(product,'..',name))).digest('hex');
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({schema:1,createdAt:new Date().toISOString(),
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:product,encoding:'utf8'}).trim(),sourceFiles,
  executableVersion:execFileSync(values.dsh,['--version'],{encoding:'utf8',env:{PATH:process.env.PATH,DSH_HOME:path.join(root,'version'),DSH_TELEMETRY_MODE:'DISABLED'}}).trim(),
  model:'deepseek-flash',maxTokens:4000,thinking:'disabled',dataClass:'synthetic',
  limitation:'Native DSH with production MCP, VCR and model gateways in an isolated process; not a full hosted deployment test.'},null,2)+'\n',{mode:0o600});
const config=loadConfig({localAutoConfig:false,dataDir:path.join(root,'control'),deepseekApiKeyFile:path.resolve(values['key-file']),deepseekProviderEnabled:true,
  production:false,modelGatewayTimeoutMs:120000,userDailySpendLimit:3,userWeeklySpendLimit:3,userRunSpendLimit:2,modelGatewayMaxOutputTokens:4000,
  vcrEnabled:true,vcrAudience:'all',vcrClinicalStudyIds:[],vcrDataPlaneDir:path.join(root,'protected')});
const isolated=await createGeoTestDatabase(values.postgres,'native_forecast');
const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:2000});
const ledger=new UsageLedger(database);await ledger.health();
const vcr=composeVcr({config,productDatabase:database});await vcr.store.ready();
const userId=`native-vcr-${randomUUID()}`,projectId=`eval-${randomUUID()}`,runId=`run-${randomUUID()}`;
await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Synthetic native VCR','development')",[userId]);
await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Synthetic native VCR',10485760)",[userId,projectId]);
const study=await vcr.store.createStudy({userId,projectId,name:'Synthetic multi-turn evaluation',question:'Synthetic research',dataTier:'T0'});
config.vcrClinicalStudyIds.push(study.id);
const token=randomUUID();let sessionId=null,checks=0;
const privacyCanaries=['RAW-SYNTHETIC-'];let providerAttempts=0,canaryLeaks=0;
const runtimeManager={assertActiveModelGatewayToken(value){if(value!==token)throw new Error('Invalid workload');return{userId,projectId,runId,runLimit:2};},boundedRuntimeScope(){return{runId};}};
const egress=createVcrCloudEgress({store:vcr.store,resolveSession:async caller=>caller.sessionId,destinations:()=>vcrCloudDestinations(config)});
const model=createModelGatewayHandler(config,runtimeManager,{usageLedger:ledger,attributeRun:async()=>runId,
  fetchImpl:async(url,init)=>{providerAttempts++;if(privacyCanaries.some(value=>String(init.body).includes(value))){canaryLeaks++;throw new Error('Synthetic privacy canary reached provider boundary');}return globalThis.fetch(url,init);},
  assertModelAccess:async(caller,body)=>{
  if(++checks>120)throw new Error('Native request budget');sessionId=caller.sessionId;await egress(caller,body);
}});
const gateway=createVcrGatewayHandler(config,runtimeManager,{vcr,readProducerRun:async()=>({sessionId,runId})});
const server=createServer((req,res)=>{
  if(req.url.startsWith('/internal/vcr/')){
    return gateway(req,res,()=>{});
  }
  return model(req,res,()=>{});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const native=await createNativeDsh({root,executable:values.dsh,dump:await fs.readFile(values.dump,'utf8'),gateway:base+'/internal/model/v1',token,mcpGateway:base+'/internal/vcr/v1'});
const source=await vcr.dataPlane.registerSource({userId,studyId:study.id,name:'Authored synthetic T2D history',valueSource:'synthetic'});
// Keep the heldout synthetic group large enough for the unchanged aggregate
// display policy, so this pilot exercises metric reading as well as submission.
const syntheticSubjects=200;
const lines=['PATIENT,AT,AVAILABLE,HBA1C'];
for(let i=0;i<syntheticSubjects;i++)for(const [at,inc] of [['2025-12-01',0],['2026-01-01',.2],['2026-01-31',.4]])lines.push(`RAW-SYNTHETIC-${i},${at},${at},${6+i/100+inc}`);
await vcr.dataPlane.storeUpload({actor:userId,studyId:study.id,sourceId:source.id,name:'events.csv',stream:Readable.from([lines.join('\n')])});
const mapped=await vcr.dataPlane.proposeFieldMap({actor:userId,studyId:study.id,sourceId:source.id,columns:[
  {table:'events.csv',column:'PATIENT',role:'subject_key',identifier:true},
  {table:'events.csv',column:'AT',role:'visit_date',timeKind:'occurred_at',type:'date'},
  {table:'events.csv',column:'AVAILABLE',role:'other',timeKind:'visible_at',type:'date'},
  {table:'events.csv',column:'HBA1C',role:'measurement',parameter:'HBA1C',unit:'%',type:'number'}]});
await vcr.dataPlane.confirmFieldMap({actor:userId,studyId:study.id,sourceId:source.id,hash:mapped.hash});
const {snapshot}=await vcr.dataPlane.freezeSnapshot({userId,studyId:study.id,sourceId:source.id});
const mappings=[{inputId:`${snapshot.id}:1`,subjectColumn:'USUBJID',code:'HbA1c',valueColumn:'HBA1C',unit:'%',occurredColumn:'AT',availableColumn:'AVAILABLE',basis:'dictionary_stated'}];
const skill=await fs.readFile(new URL('../../capabilities/vcr-analysis/SKILL.md',import.meta.url),'utf8');
const guidance=skill.slice(skill.indexOf('## Longitudinal'));
if(guidance.length<200)throw new Error('Longitudinal guidance not found');
const receipts=[];
async function turn(id,prompt,resume=true){
  const result=await native({prompt,filename:id,sessionId:resume?sessionId:null});sessionId=result.sessionId;
  receipts.push({id,promptHash:createHash('sha256').update(prompt).digest('hex'),...result});
  await fs.writeFile(path.join(root,'receipts.json'),JSON.stringify(receipts,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({id,code:result.code,latencyMs:result.latencyMs,toolCalls:result.events.filter(e=>e.type==='tool_call').length}));
  if(result.code !== 0 || result.timedOut) throw new Error(`Native turn ${id} did not finish within its budget; receipts are preserved.`);
}
try{
  await turn('01-literature',`我们做虚拟临研，仅用云端 API。请先读取纵向研究能力；当前没有专用世界模型 API，也没有后续验证结果，说明还能怎样推进文献情景分析。这一轮只读取并解释可用路径，不提交研究对象或作业。不要编造已经验证的模型。\n${guidance}`);
  await turn('02-freeze',`现在已上传合成随访表。请实际调用工具冻结预测起点的历史，按患者划分训练/校准/测试，用 split {mode:"patient",seed:"pilot"}。不要计算或生成预测数值。输入元数据：${JSON.stringify({snapshotId:snapshot.id,asOf:'2026-01-01',mappings})}`);
  const history=(await vcr.longitudinal.view(study)).records.find(r=>r.kind==='history');
  if(!history)throw new Error('Native agent did not freeze history');
  const outcome=await vcr.longitudinal.freezeHistory(study,{snapshotId:snapshot.id,asOf:'2026-02-01',mappings},userId);
  const external={schema:1,historyId:history.id,origin:history.summary.origin,subjectKeyMode:'source_identifier',endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30],model:{name:'authored-synthetic-fixture',version:'1'},
    rows:Array.from({length:syntheticSubjects},(_,i)=>({subjectKey:`RAW-SYNTHETIC-${i}`,horizonDays:30,point:6+i/100+.3+.05*Math.sin(i),sd:.5,uncertainty:'predictive'}))};
  const prediction=await vcr.longitudinal.importPrediction(study,external,userId);
  await turn('03-evaluate',`外部预测与后续观测已导入，请实际提交 evaluate_forecast 作业，bootstrap=30，split=test。${JSON.stringify({predictionId:prediction.id,outcomeHistoryId:outcome.id})}。不要心算指标。`);
  // The real queue leases at most one job per study per sweep. The agent may
  // have queued an optional profile first; drain successive sweeps as the
  // hosted worker does, rather than assuming our evaluation is first in line.
  for(let sweep=0;sweep<20;sweep++){
    const claimed=await vcr.jobs.claim();
    if(!claimed.length)break;
    for(const job of claimed)await vcr.jobs.advance(job);
    if((await vcr.longitudinal.view(study)).records.some(r=>r.kind==='evaluation'))break;
  }
  const evaluation=(await vcr.longitudinal.view(study)).records.find(r=>r.kind==='evaluation');
  if(!evaluation)throw new Error('No evaluation completed after the controlled worker sweeps.');
  await turn('04-read-results','读取纵向验证结果，对比朴素基线，引用实际算出的指标；说明这批合成数据能证明什么、不能证明什么。');
  const control=await vcr.longitudinal.importPrediction(study,{...external,rows:external.rows.map(r=>({...r,point:r.point+.3})),scenario:{label:'synthetic-control'}},userId);
  await turn('05-design',`请将两个已保存的预测衔接试验设计，实际调用 vcr_write 的 what=forecast_design（不是 simulate kind），horizonDays=30。${JSON.stringify({predictionId:prediction.id,controlPredictionId:control.id})}。说明这属于模型情景推演，不是因果治疗效果。`);
  await turn('06-prognostic-design',`请用刚才的留出验证结果衔接连续终点的预后协变量设计，调用 vcr_write what=forecast_design，参数 ${JSON.stringify({predictionId:prediction.id,controlPredictionId:control.id,horizonDays:30,prognosticEvaluationId:evaluation.id,randomizationAt:'2026-03-01',lambda:.8})}。不要把这次合成数据验证称为真实临床验证。`);
  await turn('07-unavailable-provider',`请尝试提交 forecast_trajectories，providerId=unconfigured-healthflux，historyId=${history.id}，endpoint={code:"HbA1c",type:"continuous",unit:"%"}，horizonsDays=[30]。如果未配置，继续提交 compare_forecasts 对比已有的两套预测，bootstrap=30：${JSON.stringify({predictionId:prediction.id,otherPredictionId:control.id})}。再读取并简述已完成的验证；把可做的工作执行到位。`);
  const records=(await vcr.longitudinal.view(study)).records;
  const jobs=await vcr.jobs.listForStudy(study.id);
  const usage=(await database.query('SELECT model,observed_model,status,actual_cost,currency FROM evimed_usage.model_requests WHERE user_id=$1',[userId])).rows;
  const summary={dataClass:'synthetic',syntheticSubjects,studyId:study.id,records,jobs,usage,privacy:{providerAttempts,canaryLeaks},
    turns:receipts.map(({events:_events,...rest})=>rest),checks:{historyCreated:!!history,evaluationCreated:records.some(r=>r.kind==='evaluation'),designQueued:jobs.some(r=>r.kind==='design_analytic'),prognosticQueued:jobs.some(r=>r.kind==='procova'),fallbackComparisonQueued:jobs.some(r=>r.kind==='compare_forecasts'),allTurnsExited:receipts.every(r=>r.code===0&&!r.timedOut)},
    limitation:'Native pinned DSH, real DeepSeek API, production gateways, isolated PostgreSQL and authored synthetic fixtures. Dedicated forecast API and clinical performance are not validated.'};
  await fs.writeFile(path.join(root,'observations.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
  if (!Object.values(summary.checks).every(Boolean) || canaryLeaks > 0) process.exitCode = 1;
}finally{await new Promise(resolve=>server.close(resolve));await database.close();await isolated.drop();}
