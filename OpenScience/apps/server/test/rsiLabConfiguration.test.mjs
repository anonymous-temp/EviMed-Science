import test from 'node:test';
import assert from 'node:assert/strict';
import { rsiLabConfigurationIssues } from '../src/rsiLabConfiguration.mjs';
export function boundLab(accountId = 'lab-test') { return {host:{provider:'alibaba',purpose:'rsi-lab',instanceId:'i-lab',region:'cn-shanghai'},transport:{endpoint:'https://oss-cn-shanghai.aliyuncs.com',region:'cn-shanghai',incidentBucket:'lab-input',bundleBucket:'lab-output'},signer:{keyId:'kms-lab',publicKeySha256:'a'.repeat(64)},authority:{role:'rsi-lab',accountId,dataDir:'/srv/rsi-lab',databaseRole:'rsi_lab'},budget:{campaignCny:1000,monthCny:30000}}; }
test('unbound resources fail closed and isolated configuration passes',()=>{assert.ok(rsiLabConfigurationIssues({}).includes('campaign_host_unavailable'));assert.deepEqual(rsiLabConfigurationIssues(boundLab()),[]);});
test('production authority, shared buckets, excessive limits and raw keys refuse',()=>{for(const change of [c=>c.authority.role='production',c=>c.host.role='production',c=>c.authority.dataDir='/srv/rsi-lab/../production',c=>c.transport.bundleBucket=c.transport.incidentBucket,c=>c.budget.campaignCny=1001,c=>c.signer.apiKey='secret']){const c=boundLab();change(c);assert.ok(rsiLabConfigurationIssues(c).length);}});
test('every configuration object rejects inline credentials and unknown fields',()=>{
 for(const section of ['host','transport','signer','authority','budget']){const c=boundLab();c[section].rawCredential='secret';assert.ok(rsiLabConfigurationIssues(c).includes('campaign_lab_configuration_invalid'),section);}
 const c=boundLab();c.rawCredential='secret';assert.deepEqual(rsiLabConfigurationIssues(c),['campaign_lab_configuration_invalid']);
});
test('the lab calls no model and holds no provider key: a providers block, of any shape, is an unknown key and is refused',()=>{
 assert.equal('providers' in boundLab(),false);
 for(const providers of [{},null,[],'x',{deepseekFlash:{provider:'deepseek',model:'deepseek-flash',credentialRef:'lab:deepseek'},qwenMax:{provider:'dashscope',model:'qwen3.8-max',credentialRef:'lab:qwen'}},{claude:{provider:'anthropic',model:'claude-sonnet-5-5',credentialRef:'lab:claude'}}])
  assert.deepEqual(rsiLabConfigurationIssues({...boundLab(),providers}),['campaign_lab_configuration_invalid'],JSON.stringify(providers));
});
