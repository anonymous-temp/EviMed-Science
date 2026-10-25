import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { nativeInputText } from '@evimed/harness-port';
import { createWebApiApp } from '../src/server.mjs';
import { NativeHandbookContext } from '../src/nativeHandbookContext.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !databaseUrl && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured', timeout: 30000 };
const UI_ORIGIN = 'https://science.example:8443';

/**
 * A GEO project whose conversation is opened as the page opens it: the owner's explicit open of its primary (`conversation/open`, which
 * begins the session in the kernel and registers it with the GEO authority, the authority every selection is bound under). The prompt
 * then goes through the owner's own frame of the control project (`scoped: false`, the pipeline these identity bounds were written for)
 * or the frame the page issues for the descriptor's scope (`scoped: true`, which journals each input under its identity). The kernel is
 * a socket the runtime's own proxy reaches over HTTP and the mux alike; it accepts every prompt and records what was forwarded.
 */
async function fixture(t, wire, { scoped = false } = {}) {
  const isolated = await createGeoTestDatabase(databaseUrl, 'nativerouteidentity');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'evimed-native-identity-'));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: 'mock', devAuth: false, authMode: 'local', bootstrapUser: '', bootstrapPassword: '',
    stateStore: 'postgres', requireSharedStateStore: true, databaseUrl: isolated.url, geoEnabled: true, geoAudience: 'all', learningEnabled: false,
    llmRoutingEnabled: false, runTitlesEnabled: false, runtimeUiProxyEnabled: true, runtimeUiPublicOrigin: UI_ORIGIN, publicUrl: 'https://science.example' });
  const clients = new Set(), peers = new Set(), forwarded = [], kernelSessions = [];
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.method === 'session/prompt') forwarded.push(body.payload.args.request);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
    });
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer));
    peer.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'open') return;
      forwarded.push(frame.payload.args.request);
      peer.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { accepted: true } }));
      peer.send(JSON.stringify({ type: 'end', streamId: frame.streamId }));
    });
  });
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const peer of peers) peer.terminate();
    app.runtimeManager.runtimes.clear();
    await app.close();
    wss.close();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true }); await isolated.drop();
  });
  await app.store.createUser('identity-owner', 'test-identity-password', 'Identity owner');
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'identity-owner', password: 'test-identity-password' }) });
  const auth = await login.json(), loginCookie = String(login.headers.get('set-cookie')).split(';')[0];
  const headers = { cookie: loginCookie, 'content-type': 'application/json', 'x-open-science-csrf': auth.data.csrfToken };
  const created = await fetch(`${base}/api/geo/projects`, { method: 'POST', headers, body: JSON.stringify({ brandName: 'Identity Brand' }) });
  const envelope = await created.json(); assert.equal(created.status, 201, JSON.stringify(envelope));
  const { id, projectId } = envelope.data;
  assert.equal(envelope.data.sessionId, null, 'creation begins no conversation');
  const user = await app.store.userById('identity-owner'), project = await app.store.requireProject(user, projectId);
  const socketPath = path.join(dataDir, 'kernel.sock');
  await new Promise(resolve => upstream.listen(socketPath, resolve));
  const runtime = { url: 'http://kernel.local', socketPath, cookie: 'kernel_auth=fixture', modelGatewayTokenJti: 'identity-fixture-generation' };
  app.runtimeManager.runtimes.set(app.runtimeManager.key(project), runtime);
  app.runtimeManager.start = async () => runtime;
  app.runtimeManager.callKernel = async (_runtime, _project, method) => {
    if (method !== 'session/create') return { items: kernelSessions };
    const sessionId = `identity-primary-${kernelSessions.length + 1}`;
    kernelSessions.push({ sessionId });
    return { sessionId };
  };
  app.runtimeManager.assertPersonalSkillPromptGeneration = async () => {};
  const opened = await fetch(`${base}/api/geo/projects/${id}/conversation/open`, { method: 'POST', headers, body: JSON.stringify({ target: { kind: 'primary' } }) });
  const descriptor = await opened.json(); assert.equal(opened.status, 200, JSON.stringify(descriptor));
  const { sessionId, scope } = descriptor.data;
  assert.deepEqual(kernelSessions, [{ sessionId }], 'the open began exactly one kernel session, the primary');
  const frameResponse = await fetch(`${base}/api/runtime-ui/frames`, { method: 'POST', headers, body: JSON.stringify({ projectId, ...(scoped ? { scope } : {}) }) });
  const frame = await frameResponse.json(); assert.equal(frameResponse.status, 201, JSON.stringify(frame));
  const prefix = new URL(frame.data.frameUrl).pathname;
  const cookie = `${loginCookie}; ${String(frameResponse.headers.get('set-cookie')).split(';')[0]}`;
  const origin = `http://127.0.0.1:${app.runtimeUi.address().port}`;
  let stream = 0;
  const send = async request => {
    if (wire === 'http') {
      const response = await fetch(`${origin}${prefix}api/session/prompt`, { method: 'POST', headers: { cookie, origin: UI_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${++stream}`, method: 'session/prompt', payload: { args: { request } } }) });
      return { status: response.status, body: await response.text() };
    }
    const ws = new WebSocket(`${origin.replace('http', 'ws')}${prefix}api/remote.mux`, { headers: { cookie, origin: UI_ORIGIN } });
    clients.add(ws); await once(ws, 'open');
    const reply = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'open', streamId: `request-${++stream}`, endpoint: 'session/prompt', payload: { args: { request } } }));
    const [raw] = await reply, value = JSON.parse(raw.toString());
    const closed = once(ws, 'close'); ws.close(); await closed; clients.delete(ws);
    return { status: value.type === 'item' ? 200 : value.error?.code === 'handbook_request_invalid' ? 400 : 503, body: JSON.stringify(value) };
  };
  const planContexts = app.geo.service.planContexts;
  const stage = requestKey => planContexts.stage(user, id, { requestKey, sessionId, mode: 'strategy' });
  const prompt = (requestId, selected = null, mode = 'queue') => ({ requestId, sessionId, mode, content: [{ type: 'text', text: '/geo-strategy Preserve this selected input.' }], ...(selected ? { geoPlanContext: { referenceId: selected.referenceId } } : {}) });
  const state = async selected => (await planContexts.documents.get(user.id, 'geo-plan-context', selected.referenceId)).payload.state;
  const reader = new NativeHandbookContext({ route: async () => ({}), select: async () => null, budget: () => 0, allowed: async () => false });
  return { app, user, project, sessionId, forwarded, planContexts, stage, prompt, send, state, reader };
}

for (const wire of ['http', 'mux']) test(`native ${wire} selected identity bounds refuse before binding and preserve legal queue/steer behavior`, options, async t => {
  const f = await fixture(t, wire);
  const invalidIds = ['', 'x'.repeat(513), 'bad\nrequest', 'bad\u007frequest', 0, null, {}];
  for (const [index, requestId] of invalidIds.entries()) {
    const selected = await f.stage(`invalid-${index}`), count = f.forwarded.length;
    const refused = await f.send(f.prompt(requestId, selected));
    assert.equal(refused.status, 400, refused.body); assert.match(refused.body, /handbook_request_invalid/);
    assert.equal(f.forwarded.length, count, 'unsupported selected identities never reach the kernel');
    assert.equal(await f.state(selected), 'staged', 'identity validation precedes durable binding');
    assert.equal((await f.send(f.prompt(requestId))).status, 200, 'ordinary unsupported identities retain existing advisory forwarding');
  }
  const boundary = await f.stage('boundary'), requestId = 'x'.repeat(512);
  assert.equal((await f.send(f.prompt(requestId, boundary))).status, 200);
  const initiating = f.forwarded.at(-1), initiatingText = nativeInputText(initiating.content);
  assert.equal((await f.reader.routeFor(f.project, f.sessionId, [requestId], initiatingText)).effectiveAgentId, 'geo-strategy');
  const steer = await f.stage('steer');
  assert.equal((await f.send(f.prompt('legal-steer', steer, 'steer'))).status, 200, 'a legal selected steer intentionally creates no replacement snapshot');
  assert.equal(await f.reader.routeFor(f.project, f.sessionId, ['legal-steer'], nativeInputText(f.forwarded.at(-1).content)), null);
  assert.equal((await f.reader.routeFor(f.project, f.sessionId, [requestId], initiatingText)).effectiveAgentId, 'geo-strategy', 'steering preserves the initiating immutable route');
});

for (const wire of ['http', 'mux']) test(`native ${wire} selected requests cannot silently lose their route snapshot or verified lookup`, options, async t => {
  const f = await fixture(t, wire);
  const originalPrepare = NativeHandbookContext.prototype.prepare;
  const missing = await f.stage('missing-snapshot'), count = f.forwarded.length;
  let snapshot = null;
  NativeHandbookContext.prototype.prepare = async function (project, request) {
    return request?.requestId === 'missing-snapshot' ? snapshot : originalPrepare.call(this, project, request);
  };
  try {
    for (const unsupported of [null, {}, { route: { geoContextRef: missing.referenceId, effectiveAgentId: 'geo-insight' } }]) {
      snapshot = unsupported;
      const refused = await f.send(f.prompt('missing-snapshot', missing));
      assert.equal(refused.status, 503, refused.body); assert.match(refused.body, /geo_plan_context_unavailable/);
      assert.equal(f.forwarded.length, count); assert.equal(await f.state(missing), 'bound', 'the failed snapshot still owns exactly this retriable input');
      assert.equal(await f.app.pluginService.hasPendingPrompts(f.project), false, 'a definitive snapshot refusal releases prompt admission');
    }
  } finally { NativeHandbookContext.prototype.prepare = originalPrepare; }
  assert.equal((await f.send(f.prompt('missing-snapshot', missing))).status, 200, 'the same exact request can retry after a definitive pre-forward failure');
  const originalLookup = f.planContexts.routingInputForRequest;
  for (const result of ['missing', 'foreign']) {
    const selected = await f.stage(`lookup-${result}`), before = f.forwarded.length;
    f.planContexts.routingInputForRequest = async function (project, request) {
      const actual = await originalLookup.call(this, project, request);
      return result === 'missing' ? null : { ...actual, referenceId: 'gpc_' + 'f'.repeat(64) };
    };
    try {
      const refused = await f.send(f.prompt(`lookup-${result}`, selected));
      assert.equal(refused.status, 503, refused.body); assert.match(refused.body, /geo_plan_context_unavailable/);
      assert.equal(f.forwarded.length, before); assert.equal(await f.state(selected), 'bound');
      assert.equal(await f.app.pluginService.hasPendingPrompts(f.project), false, 'a missing lookup is not an uncertain upstream acceptance');
      assert.equal(await f.reader.routeFor(f.project, f.sessionId, [`lookup-${result}`], '/geo-strategy Preserve this selected input.'), null);
    } finally { f.planContexts.routingInputForRequest = originalLookup; }
    assert.equal((await f.send(f.prompt(`lookup-${result}`, selected))).status, 200, 'a failed lookup did not persist an invalid sticky snapshot');
  }
});

// The page's own frame (the descriptor's scope) of a project its owner works in alone: its inputs are the owner's and pass through the
// frame's authority without the shared journal, which has no namespace to hold them (owner ruling 2026-10-25). Before, every one of
// them was refused as a conflict and none reached the kernel.
for (const wire of ['http', 'mux']) test(`native ${wire} page frame of a one-person project forwards the owner's input and freezes the same selected route`, options, async t => {
  const f = await fixture(t, wire, { scoped: true });
  const steers = [];
  const recordSteeredInput = f.app.agentRuns.recordSteeredInput.bind(f.app.agentRuns);
  f.app.agentRuns.recordSteeredInput = async (project, sessionId, requestId, text) => { steers.push([sessionId, requestId, text]); return recordSteeredInput(project, sessionId, requestId, text); };
  const ordinary = await f.send({ requestId: 'page-ordinary', sessionId: f.sessionId, mode: 'queue', content: [{ type: 'text', text: 'An ordinary question.' }] });
  assert.equal(ordinary.status, 200, ordinary.body);
  assert.equal(f.forwarded.at(-1).requestId, 'page-ordinary');
  assert.equal(await f.app.pluginService.hasPendingPrompts(f.project), false, 'an accepted prompt releases the admission');
  // A selected request: bound to this request, its envelope not forwarded, the route frozen as on the owner's own frame.
  const selected = await f.stage('page-strategy');
  const sent = await f.send(f.prompt('page-strategy', selected));
  assert.equal(sent.status, 200, sent.body);
  const forwarded = f.forwarded.at(-1);
  assert.equal(forwarded.requestId, 'page-strategy'); assert.equal('geoPlanContext' in forwarded, false);
  // Over HTTP the kernel's answer reaches the browser inside the frame authority's transaction, so the binding commits just after it.
  for (const until = Date.now() + 5000; await f.state(selected) !== 'bound' && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await f.state(selected), 'bound');
  const route = await f.reader.routeFor(f.project, f.sessionId, ['page-strategy'], nativeInputText(forwarded.content));
  assert.equal(route.effectiveAgentId, 'geo-strategy'); assert.equal(route.geoContextRef, selected.referenceId);
  // The identity bound is the same: an unsupported selected identity is refused before binding and never forwarded.
  const invalid = await f.stage('page-invalid'), count = f.forwarded.length;
  const refused = await f.send(f.prompt('bad\nrequest', invalid));
  assert.equal(refused.status, 400, refused.body); assert.match(refused.body, /handbook_request_invalid/);
  assert.equal(await f.state(invalid), 'staged'); assert.equal(f.forwarded.length, count);
  assert.equal(await f.app.pluginService.hasPendingPrompts(f.project), false, 'a refusal releases the admission');
  // The frame is the conversation's: a prompt naming another session is refused and never forwarded.
  const foreign = await f.send({ requestId: 'page-foreign', sessionId: 'identity-other', mode: 'queue', content: [{ type: 'text', text: 'Elsewhere.' }] });
  assert.notEqual(foreign.status, 200, foreign.body); assert.equal(f.forwarded.length, count);
  // A steer is the owner's own correction of the run, recorded as their own frame records it.
  const steer = await f.send({ requestId: 'page-steer', sessionId: f.sessionId, mode: 'steer', content: [{ type: 'text', text: 'Keep the denominator visible.' }] });
  assert.equal(steer.status, 200, steer.body);
  assert.deepEqual(steers, [[f.sessionId, 'page-steer', 'Keep the denominator visible.']]);
});
