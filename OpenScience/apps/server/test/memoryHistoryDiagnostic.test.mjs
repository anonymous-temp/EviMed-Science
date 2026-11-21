import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countRecordedHits, probeKnownQuote } from '../../../scripts/ops/memory-history-diagnostic.mjs';
import { recallDigest } from '../src/memoryRecallReceipt.mjs';

test('historical hit counts deduplicate cumulative ledger rows across segments and exclude probe traffic', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rcl-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const at = '2026-11-20T12:00:00Z';
  const row = {event:'learning', id:'r',at,memoryRecall:{version:1,operations:[
    {id:'one',entry:'mcp.search',at,refs:[0]}, {id:'two',entry:'mcp.search',at,refs:[]},
    {id:'old',entry:'mcp.search',at:'2025-01-01',refs:[0]}],references:[{source:'history'}]}};
  for (const file of ['runs.jsonl','runs.000001.jsonl']) await writeFile(path.join(dir,file),JSON.stringify(row)+'\n');
  const counts = await countRecordedHits([dir],7,Date.parse('2026-11-21'));
  assert.equal(counts.recordedSearches,2);
  assert.equal(counts.searchesWithHistory,1);
  assert.equal(counts.historicalHit,'observed');
});

test('known-quote probe requires exact account, project, session, speaker and source permissions', async () => {
  const request = {base:'https://example.test', key:'test-credential',owner:'internal',projectId:'p',sessionId:'s',quote:'a known line'};
  const requiredScopes = ['memory.read','memory.history.read'];
  const status = {accountHash:recallDigest('internal'),speaksFor:'account',capabilities:{rawConversationRecall:{available:true}},scopes:requiredScopes};
  const hit = {uri:'history:a',projectId:'p',sessionId:'s',contextOnly:true,confirmed:false,messages:[{sourceRole:'user',text:request.quote}]};
  const data = {history:[hit],historyAccess:{ownerHash:status.accountHash,scope:'project',projectId:'p',requiredScopes}};
  const call = async (_url, options) => ({ok:true,json:async()=>({data:options.method==='GET'?status:data})});
  assert.equal((await probeKnownQuote(request,call)).matched,true);
  hit.messages[0].sourceRole='assistant';
  assert.equal((await probeKnownQuote(request,call)).matched,false);
  await assert.rejects(probeKnownQuote({...request,owner:'different'},call),/permission/);
});
