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

async function fixture(t, wire) {
  const isolated = await createGeoTestDatabase(databaseUrl, 'nativerouteidentity');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'evimed-native-identity-'));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: 'mock', devAuth: false, authMode: 'local', bootstrapUser: '', bootstrapPassword: '',
    stateStore: 'postgres', requireSharedStateStore: true, databaseUrl: isolated.url, geoEnabled: true, geoAudience: 'all', learningEnabled: false,
    llmRoutingEnabled: false, runTitlesEnabled: false, runtimeUiProxyEnabled: true, runtimeUiPublicOrigin: UI_ORIGIN, publicUrl: 'https://science.example' });
  const clients = new Set(), peers = new Set(), forwarded = [];
  const upstream = createServer();
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
  const { id, projectId, sessionId } = envelope.data;
  const user = await app.store.userById('identity-owner'), project = await app.store.requireProject(user, projectId);
  const socketPath = path.join(dataDir, 'kernel.sock');
  await new Promise(resolve => upstream.listen(socketPath, resolve));
  const runtime = { url: 'http://kernel.local', socketPath, cookie: 'kernel_auth=fixture', modelGatewayTokenJti: 'identity-fixture-generation' };
  app.runtimeManager.runtimes.set(app.runtimeManager.key(project), runtime);
  app.runtimeManager.start = async () => runtime;
  app.runtimeManager.callKernel = async () => [{ sessionId }];
  app.runtimeManager.assertPersonalSkillPromptGeneration = async () => {};
  app.runtimeManager.proxy = async (req, res) => { forwarded.push(JSON.parse(req.__openScienceProxyBody.toString()).payload.args.request); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
  const frameResponse = await fetch(`${base}/api/runtime-ui/frames`, { method: 'POST', headers, body: JSON.stringify({ projectId }) });
  const frame = await frameResponse.json(); assert.equal(frameResponse.status, 201, JSON.stringify(frame));
  const prefix = new URL(frame.data.frameUrl).pathname;
  const cookie = `${loginCookie}; ${String(frameResponse.headers.get('set-cookie')).split(';')[0]}`;
  const origin = `http://127.0.0.1:${app.runtimeUi.address().port}`;
  let stream = 0;
  const send = async request => {
    if (wire === 'http') {
      const response = await fetch(`${origin}${prefix}api/session/prompt`, { method: 'POST', headers: { cookie, origin: UI_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', method: 'session/prompt', payload: { args: { request } } }) });
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
  return { app, project, sessionId, forwarded, planContexts, stage, prompt, send, state, reader };
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
