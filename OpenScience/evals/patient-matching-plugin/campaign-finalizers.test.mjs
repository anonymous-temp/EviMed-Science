import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { createCampaignFinalizers, runCampaignCurl, dispatchCampaignGateway } from './campaign-host.mjs';
import { createPatientMatchingGatewayHandler } from '../../apps/server/src/patientMatchingGateway.mjs';
import { HOST_ABI } from '../../packages/patient-matching-core/index.mjs';

test('a disconnected HTTP client cannot let database closure overtake its billing finalizer', async () => {
  const finalizers = createCampaignFinalizers(); let release, started, settled = false;
  const barrier = new Promise(resolve => { release = resolve; }), admitted = new Promise(resolve => { started = resolve; });
  const server = http.createServer(finalizers.wrap(async (_request, response) => {
    started();
    try { await barrier; }
    finally { await new Promise(resolve => setImmediate(resolve)); settled = true; response.end(); }
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = http.request({ host: '127.0.0.1', port: server.address().port }); request.on('error', () => {}); request.end();
  await admitted; request.destroy(); await new Promise(resolve => server.close(resolve));
  let drained = false; const done = finalizers.drain({ abort: true }).then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(drained, false); assert.equal(finalizers.signal.aborted, true);
  release(); await done; assert.equal(settled, true);
  let newWork = false, status = null;
  finalizers.wrap(() => { newWork = true; })({}, { writeHead(value) { status = value; }, end() {} });
  assert.equal(newWork, false); assert.equal(status, 503);
});

test('curl AbortError is not final until the owned subprocess has actually closed', async () => {
  const child = new EventEmitter(); child.pid = 42; child.exitCode = null; child.signalCode = null;
  const kills = []; child.kill = signal => kills.push(signal);
  let reject; const work = new Promise((_resolve, fail) => { reject = fail; }); work.child = child;
  const controller = new AbortController();
  const result = runCampaignCurl('owned-config', { signal: controller.signal, execute: (_command, _args, options) => { assert.equal(options.signal, controller.signal); return work; } });
  let finished = false; const caught = result.catch(error => { finished = true; assert.match(error.message, /aborted/); });
  controller.abort(); reject(new Error('aborted'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.deepEqual(kills, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM'); await caught; assert.equal(finished, true);
});
test('request bridge and trusted resolver cancellation reach the actual gateway-owned model-port signal', async () => {
  for (const mode of ['request-bridge', 'trusted-resolver']) {
  const owner = new AbortController(); let admitted, observed = false;
  const started = new Promise(resolve => { admitted = resolve; });
  const handler = createPatientMatchingGatewayHandler({ vcrEnabled: true }, { assertActiveModelGatewayToken: () => ({ userId: 'owner', projectId: 'project' }) }, {
    vcr: { service: { allows: () => true } },
    resolveInvocation: async () => ({ userId: 'owner', projectId: 'project', rootSessionId: 'root', tool: 'match_context', args: { messageSeq: 1 }, ...(mode === 'trusted-resolver' ? { signal: owner.signal } : {}) }),
    adapter: { dispatch: async ({ origin }) => {
      assert.notEqual(origin.signal, owner.signal); admitted();
      await new Promise(resolve => origin.signal.addEventListener('abort', () => { observed = true; resolve(); }, { once: true }));
      return { status: 'cancelled', summary: 'Owner stopped', data: {}, artifacts: [] };
    } },
  });
  const body = { abi: HOST_ABI, port: 'PatientDataPort', operation: 'context', input: { messageSeq: 1 } };
  const request = Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(request, { method: 'POST', url: '/internal/patient-matching/v1/port', headers: { authorization: 'Bearer synthetic-owned-token' } });
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead() {}, end() {} };
  const done = mode === 'request-bridge' ? dispatchCampaignGateway(handler, request, response, owner.signal) : handler(request, response);
  await started; owner.abort(); await done; assert.equal(observed, true);
  }
});
