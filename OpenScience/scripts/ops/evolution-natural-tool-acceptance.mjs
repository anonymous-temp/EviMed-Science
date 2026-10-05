import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForEvolutionTranscript, evolutionTranscriptHash } from './evolution-transcript-wait.mjs';
/** Closed proof of natural installed-tool routing and its exact actual execution receipt. */
export function verifyNaturalToolAcceptance({ run, tool, capabilityId, receipts, transcript }) {
  assert.equal(run.status, 'succeeded');
  assert.ok(String(run.effectiveRouteReason).startsWith('installed-tool:'));
  assert.equal(run.effectiveAgentId, capabilityId);
  assert.equal(transcript.header.completeness, 'complete');
  const matching = receipts.filter(row => {
    const value = row.payload;
    return value.runId === run.id && value.toolId === tool.id && value.digest === tool.payload.artifactDigest && value.revision === tool.payload.revision && value.result?.ok === true && value.callId && value.resultEvidence?.substantive === true && value.resultEvidence.kind === 'structured' && value.resultEvidence.explicitlyUnsupported !== true;
  });
  assert.ok(matching.length, 'Actual successful structured output from this pinned tool is required.');
  return { runId: run.id, effectiveAgentId: run.effectiveAgentId, effectiveRouteReason: run.effectiveRouteReason, receiptIds: matching.map(row => row.id), transcriptHash: evolutionTranscriptHash(transcript), scored: false };
}
/** No execution on import. Root calls this only in the isolated acceptance app after preceding jobs.
 * Credentials remain caller-owned and are never returned or printed. */
export async function runEvolutionNaturalToolAcceptance({ app, ownerId, password, tool, capabilityId, publicInput, probeId = 'v1', signal, baseUrl = 'http://127.0.0.1:8787' }) {
  assert.equal(app.config.dataDir, '/acceptance');
  assert.ok(String(app.config.databaseUrl ?? app.config.productDatabaseUrl).includes('evimed_test_evolution'));
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl));
  assert.ok(/^[a-z0-9_-]{1,40}$/.test(probeId));
  assert.ok(tool.payload.capabilityIds.includes(capabilityId));
  const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ownerId, password }), signal });
  assert.ok(login.ok);
  const identity = await login.json();
  const headers = { 'content-type': 'application/json', 'x-evimed-automated': '1', Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Open-Science-CSRF': identity.data.csrfToken };
  const request = async (url, body, method = 'POST') => {
    const response = await fetch(baseUrl + url, { method, headers, body: JSON.stringify(body), signal });
    assert.ok(response.ok, `Acceptance HTTP request failed: ${response.status}`);
    return (await response.json()).data;
  };
  const projectId = `evolution-natural-acceptance-${probeId}`;
  const listing = await fetch(baseUrl + '/api/projects', { headers, signal });
  assert.ok(listing.ok);
  const listed = (await listing.json()).data;
  const project = (Array.isArray(listed) ? listed : listed.projects ?? []).find(item => item.id === projectId) ?? await request('/api/projects', { id: projectId, name: `进化工具自然路由验收 ${probeId}` });
  headers['X-Open-Science-Project'] = project.id;
  const owned = await app.store.requireProject(await app.store.userById(ownerId), project.id);
  const dispatchId = `acceptance_evolution_natural_${probeId}`;
  let run = (await app.agentRuns.list(owned)).find(item => item.dispatchId === dispatchId);
  assert.ok(!run || run.status === 'succeeded', 'Existing natural acceptance run is incomplete; do not redispatch.');
  if (!run) {
    const session = await request('/api/runtime/sessions', {});
    await request(`/api/research-sessions/${encodeURIComponent(session.id)}`, { mode: 'open-domain' }, 'PUT');
    const dispatched = await request('/api/agent-runs/dispatch', { sessionId: session.id, dispatchId, text: `调用平台工具 ${tool.id}。使用以下公开合成输入执行一次，报告实际结构化数值结果，不使用替代工具：${JSON.stringify(publicInput)}`, automated: true });
    const runId = dispatched.id ?? dispatched.run?.id, deadline = Date.now() + app.config.evolutionEvaluationTimeoutMs;
    do { await delay(1000, undefined, { signal }); run = (await app.agentRuns.list(owned)).find(item => item.id === runId); } while (Date.now() < deadline && (!run || ['queued', 'dispatching', 'running'].includes(run.status)));
  }
  const transcript = await waitForEvolutionTranscript(owned, run.id, { signal });
  return { projectId: project.id, ...verifyNaturalToolAcceptance({ run, tool, capabilityId, receipts: await app.evolution.service.list('use', ownerId), transcript }) };
}
