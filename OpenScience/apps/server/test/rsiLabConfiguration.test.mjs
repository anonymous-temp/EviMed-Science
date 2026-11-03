import test from 'node:test';
import assert from 'node:assert/strict';
import { rsiLabConfigurationIssues } from '../src/rsiLabConfiguration.mjs';
export function boundLab(accountId = 'lab-test') { return {host:{provider:'alibaba',purpose:'rsi-lab',instanceId:'i-lab',region:'cn-shanghai'},transport:{endpoint:'https://oss-cn-shanghai.aliyuncs.com',region:'cn-shanghai',incidentBucket:'lab-input',bundleBucket:'lab-output'},signer:{keyId:'kms-lab',publicKeySha256:'a'.repeat(64)},authority:{role:'rsi-lab',accountId,dataDir:'/srv/rsi-lab',databaseRole:'rsi_lab'},budget:{campaignCny:1000,monthCny:30000},providers:{qwenMax:{provider:'dashscope',model:'qwen3.8-max',credentialRef:'lab:dashscope'}}}; }
test('unbound resources fail closed and isolated configuration passes',()=>{assert.ok(rsiLabConfigurationIssues({}).includes('campaign_host_unavailable'));assert.deepEqual(rsiLabConfigurationIssues(boundLab()),[]);});
test('production authority, shared buckets, excessive limits and raw keys refuse',()=>{for(const change of [c=>c.authority.role='production',c=>c.host.role='production',c=>c.authority.dataDir='/srv/rsi-lab/../production',c=>c.transport.bundleBucket=c.transport.incidentBucket,c=>c.budget.campaignCny=1001,c=>c.signer.apiKey='secret',c=>c.providers.qwenMax.apiKey='secret']){const c=boundLab();change(c);assert.ok(rsiLabConfigurationIssues(c).length);}});
test('every configuration object rejects inline credentials and unknown fields',()=>{
 for(const section of ['host','transport','signer','authority','budget','providers']){const c=boundLab();c[section].rawCredential='secret';assert.ok(rsiLabConfigurationIssues(c).includes('campaign_lab_configuration_invalid'),section);}
 const c=boundLab();c.rawCredential='secret';assert.deepEqual(rsiLabConfigurationIssues(c),['campaign_lab_configuration_invalid']);
});
test('the lab holds exactly one provider credential, the frontier jury\'s Qwen 3.8 Max: a missing or wrong row is campaign_lab_provider_unavailable, any other provider key is an unknown key',()=>{
 assert.deepEqual(boundLab().providers,{qwenMax:{provider:'dashscope',model:'qwen3.8-max',credentialRef:'lab:dashscope'}});
 const without=boundLab();delete without.providers;assert.deepEqual(rsiLabConfigurationIssues(without),['campaign_lab_configuration_invalid','campaign_lab_provider_unavailable']);
 for(const providers of [{},null,[],'x',{qwenMax:null},{qwenMax:{}}]) assert.ok(rsiLabConfigurationIssues({...boundLab(),providers}).includes('campaign_lab_provider_unavailable'),JSON.stringify(providers));
 for(const change of [row=>row.provider='deepseek',row=>row.provider='anthropic',row=>row.model='qwen3.8-plus',row=>row.model='deepseek-flash',row=>row.credentialRef='',row=>row.credentialRef='dashscope',row=>row.credentialRef='lab:',row=>row.credentialRef=7,row=>{delete row.credentialRef},row=>row.apiKey='sk-x']){
  const c=boundLab();change(c.providers.qwenMax);assert.deepEqual(rsiLabConfigurationIssues(c),['campaign_lab_provider_unavailable'],String(change));
 }
 // The DeepSeek row of the earlier configuration, and any other provider, stay gone: an unknown key, not a second credential.
 for(const extra of [{deepseekFlash:{provider:'deepseek',model:'deepseek-flash',credentialRef:'lab:deepseek'}},{claude:{provider:'anthropic',model:'claude-sonnet-5-5',credentialRef:'lab:claude'}}]){
  const c=boundLab();c.providers={...c.providers,...extra};assert.deepEqual(rsiLabConfigurationIssues(c),['campaign_lab_configuration_invalid'],Object.keys(extra)[0]);
  assert.deepEqual(rsiLabConfigurationIssues({...boundLab(),providers:extra}),['campaign_lab_configuration_invalid','campaign_lab_provider_unavailable'],Object.keys(extra)[0]);
 }
});
