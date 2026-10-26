#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { campaignPlan, runCampaign, labPreflight, productCampaignStore } from './campaign_runner.mjs';
import { rsiLabConfigurationIssues } from '../../apps/server/src/rsiLabConfiguration.mjs';
const [command, manifestPath, inputsPath, configPath] = process.argv.slice(2);
const json = async path => JSON.parse(await readFile(path,'utf8'));
if (!['plan','preflight','run','resume','report'].includes(command)) throw new Error('Usage: run.mjs plan|preflight|run|resume|report manifest.json inputs.json [lab-config.json]');
const manifest = await json(manifestPath);
if(command==='plan') console.log(JSON.stringify(campaignPlan(manifest),null,2));
else {
 const configuration = configPath ? await json(configPath) : {};
 const issues = rsiLabConfigurationIssues(configuration);
 if(issues.length) {console.log(JSON.stringify({status:'not-qualified',reason:issues.includes('campaign_host_unavailable')?'campaign_host_unavailable':issues[0]}));process.exitCode=2;}
 else {
  // Only the deployment-owned launcher supplies this connection reference. No model environment is forwarded.
  const {ControlPlaneDatabase} = await import('../../apps/server/src/controlPlaneDatabase.mjs');
  const database = new ControlPlaneDatabase({databaseUrl:process.env.RSI_LAB_DATABASE_URL,databasePoolMax:4,databaseConnectionTimeoutMs:5000});
  const attestLab = async()=>{
   const result=await database.query('SELECT current_user AS role,current_database() AS database');
   const metadata=await fetch('http://100.100.100.200/latest/meta-data/instance-id',{signal:AbortSignal.timeout(2000)});
   if(!metadata.ok) throw new Error('campaign_host_unavailable');
   return {...result.rows[0],hostInstanceId:(await metadata.text()).trim(),hostPurpose:await readFile('/run/rsi-lab/purpose','utf8').then(x=>x.trim())};
  };
  try {
   const store=productCampaignStore(database,configuration.authority.accountId);
   let result;
   if(command==='preflight') result=await labPreflight(configuration,attestLab);
   else if(command==='report') {const ready=await labPreflight(configuration,attestLab);result=ready.status==='ready'?await store.withCampaign(manifest.id,async cp=>cp.read()):ready;}
   else result=await runCampaign({manifest,inputs:await json(inputsPath),configuration,store,attestLab});
   console.log(JSON.stringify(result,null,2));
   if(result?.status!=='completed' && result?.status!=='ready' && command!=='report')process.exitCode=2;
  } finally {await database.close();}
 }
}
