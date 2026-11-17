import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { apply, createCapsuleClient, SYSTEM_PROMPT } from '../index.mjs';

async function fixture(t) {
  const directory = await mkdtemp(fileURLToPath(new URL('./.fixture-', import.meta.url)));
  const apiKeyFile = `${directory}/credential.txt`;
  await writeFile(apiKeyFile, 'evk_fixture_first\n');
  const calls = [];
  const state = { status: 200, code: '', malformed: false, redirect: false, body: null, wait: false };
  const methods = [{ id: 'method-one', title: 'Check tables', digest: 'sha256:one', whenToUse: 'When editing a table', content: 'Read the totals.' }];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (state.wait) return;
    if (state.redirect) { res.writeHead(302, { location: '/redirected' }); res.end(); return; }
    res.writeHead(state.status, { 'content-type': 'application/json' });
    if (state.malformed) { res.end('not json'); return; }
    const data = state.body ?? (req.url.endsWith('/recall')
      ? { items: [{ source: 'memory', content: 'Use English' }, { source: 'capsule', content: 'Project fact' }], methods }
      : req.url.endsWith('/note') ? { entry: { status: 'candidate' }, reviewRequired: true }
        : { scopes: ['memory.read', 'memory.write'], projectId: null, speaksFor: 'account' });
    res.end(JSON.stringify(state.status >= 400 ? { code: state.code, error: 'evk_fixture_first stack trace private details' } : { data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKeyFile };
  const client = createCapsuleClient(config);
  t.after(async () => { client.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { config, client, apiKeyFile, calls, state, methods };
}

test('all four tools use the public API; recall lists cards and method bodies are requested on demand', async t => {
  const f = await fixture(t);
  const recall = await f.client.call('capsule_recall', { query: 'tables', projectId: 'project-one', limit: 3 });
  assert.equal(recall.ok, true);
  assert.equal(recall.data.items.length, 2);
  assert.equal(recall.data.methods[0].whenToUse, 'When editing a table');
  assert.equal('content' in recall.data.methods[0], false);
  assert.deepEqual(f.calls[0].body, { query: 'tables', projectId: 'project-one', limit: 3, methods: 'all' });
  const method = await f.client.call('capsule_method', { digest: 'sha256:one' });
  assert.equal(method.data.method.content, 'Read the totals.');
  assert.equal((await f.client.call('capsule_method', { name: 'Check tables' })).ok, true);
  assert.equal((await f.client.call('capsule_method', { name: 'method-one' })).ok, true);
  const proposal = await f.client.call('capsule_propose', { factKind: 'preference', content: 'Use English', origin: 'explicit', review: false });
  assert.equal(proposal.data.reviewRequired, true);
  assert.deepEqual(f.calls.at(-1).body, { factKind: 'preference', content: 'Use English' });
  const status = await f.client.call('capsule_status');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.reachable, true);
  assert.equal(status.data.speaksFor, 'account');
  assert.deepEqual(status.data.scopes, ['memory.read', 'memory.write']);
  assert.ok(f.calls.every(call => call.path.startsWith('/api/agent-memory/v1')));
});

test('reads the credential file on every request, including method reads, and never returns a credential', async t => {
  const f = await fixture(t);
  await f.client.call('capsule_status');
  await writeFile(f.apiKeyFile, 'evk_fixture_second\n');
  await f.client.call('capsule_method', { name: 'method-one' });
  assert.deepEqual(f.calls.map(call => call.auth), ['Bearer evk_fixture_first', 'Bearer evk_fixture_second']);
  f.state.body = { items: [{ content: 'echo evk_fixture_second' }], methods: [] };
  assert.ok(!JSON.stringify(await f.client.call('capsule_recall', { query: 'x' })).includes('evk_fixture_second'));
});

test('unconfigured tools explain the key page without making a request or accepting an inline key', async () => {
  for (const name of ['capsule_recall', 'capsule_propose', 'capsule_method', 'capsule_status']) {
    const client = createCapsuleClient({});
    const result = await client.call(name, { query: 'x' });
    assert.equal(result.code, 'not_configured');
    assert.match(result.message, /baseUrl.*apiKeyFile/);
    assert.match(result.message, /\/app\/account/);
  }
  assert.throws(() => createCapsuleClient({ apiKey: 'never-inline' }), /apiKeyFile/);
});

for (const [status, code, expected] of [[401, 'agent_key_invalid', 'unauthorized'], [403, 'agent_key_scope_denied', 'forbidden'], [429, 'agent_memory_rate_limited', 'rate_limited'], [503, 'agent_memory_disabled', 'agent_memory_disabled'], [503, 'memory_engine_unavailable', 'unavailable'], [500, 'private', 'unavailable'], [400, 'invalid', 'invalid_request']]) {
  test(`all tools return a plain safe sentence for HTTP ${status} ${code}`, async t => {
    const f = await fixture(t);
    f.state.status = status; f.state.code = code;
    for (const name of ['capsule_recall', 'capsule_propose', 'capsule_method', 'capsule_status']) {
      const result = await f.client.call(name, { query: 'x', name: 'method-one', factKind: 'preference', content: 'English' });
      assert.equal(result.code, expected);
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes('evk_fixture_first'));
      assert.ok(!JSON.stringify(result).includes('stack trace'));
      assert.ok(!result.message.includes('\n'));
    }
  });
}

test('missing/empty key files, redirects, bad JSON and unreachable endpoints have safe states', async t => {
  const f = await fixture(t);
  await writeFile(f.apiKeyFile, '');
  assert.equal((await f.client.call('capsule_status')).code, 'key_file_unavailable');
  await rm(f.apiKeyFile);
  assert.equal((await f.client.call('capsule_status')).code, 'key_file_unavailable');
  await writeFile(f.apiKeyFile, 'evk_fixture_first');
  f.state.redirect = true;
  assert.equal((await f.client.call('capsule_status')).code, 'unavailable');
  assert.equal(f.calls.length, 1, 'never follows redirects carrying credentials');
  f.state.redirect = false; f.state.malformed = true;
  assert.equal((await f.client.call('capsule_status')).code, 'unavailable');
  const unreachable = createCapsuleClient({ ...f.config, baseUrl: 'http://127.0.0.1:1' });
  assert.equal((await unreachable.call('capsule_status')).code, 'unreachable');
  unreachable.dispose();
});

test('all tools handle unreadable credentials and unreachable services without echoing inputs', async t => {
  const f = await fixture(t);
  await rm(f.apiKeyFile);
  const unavailable = createCapsuleClient({ ...f.config, baseUrl: 'http://127.0.0.1:1' });
  for (const tool of ['capsule_recall', 'capsule_propose', 'capsule_method', 'capsule_status']) {
    const args = { query: 'x', name: 'method-one', factKind: 'preference', content: 'English' };
    assert.equal((await unavailable.call(tool, args)).code, 'key_file_unavailable');
  }
  await writeFile(f.apiKeyFile, 'evk_fixture_first');
  for (const tool of ['capsule_recall', 'capsule_propose', 'capsule_method', 'capsule_status']) {
    const result = await unavailable.call(tool, { query: 'x', name: 'method-one', factKind: 'preference', content: 'English' });
    assert.equal(result.code, 'unreachable');
    assert.ok(!JSON.stringify(result).includes('evk_fixture_first'));
  }
  unavailable.dispose();
});

test('method reads do not reuse old bodies and refuse absent/ambiguous matches', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.call('capsule_method', {})).code, 'invalid_request');
  assert.equal((await f.client.call('capsule_method', { digest: 'sha256:missing' })).code, 'method_not_found');
  f.methods.push({ ...f.methods[0], id: 'method-two', digest: 'sha256:two' });
  assert.equal((await f.client.call('capsule_method', { name: 'Check tables' })).code, 'method_ambiguous');
  f.methods[0].content = 'Changed';
  assert.equal((await f.client.call('capsule_method', { digest: 'sha256:one' })).data.method.content, 'Changed');
});

test('a digest can read identical method bodies supplied by more than one capsule', async t => {
  const f = await fixture(t);
  f.methods.push({ ...f.methods[0], id: 'method-copy' });
  const result = await f.client.call('capsule_method', { digest: 'sha256:one' });
  assert.equal(result.ok, true);
  assert.equal(result.data.method.content, 'Read the totals.');
  assert.equal((await f.client.call('capsule_method', { name: 'Check tables' })).code, 'method_ambiguous');
});

test('dispose aborts pending HTTP and unregisters Cordis tools and prompt section', async t => {
  const f = await fixture(t);
  const definitions = new Map(); const disposers = []; let section;
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } },
    systemPrompt: { section(value) { section = value; return () => { section = null; }; } },
    effect(effect) { disposers.push(effect()); },
  };
  apply(ctx, f.config);
  assert.equal(definitions.size, 8);
  assert.equal(section.interpolate, false);
  assert.equal(section.text, SYSTEM_PROMPT);
  for (const definition of definitions.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.deepEqual(definition.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }]);
  }
  assert.equal((await definitions.get('capsule_status').execute({})).ok, true);
  f.state.wait = true;
  const pending = definitions.get('capsule_status').execute({});
  await new Promise(resolve => setTimeout(resolve, 15));
  for (const dispose of disposers.reverse()) dispose();
  assert.equal((await pending).ok, false);
  assert.equal(definitions.size, 0);
  assert.equal(section, null);
});

test('status preserves per-key server capabilities and recall opts into history only when requested', async t => {
  const f = await fixture(t);
  f.state.body = { capabilities: { rawConversationRecall: { available: true, requiredScopes: ['memory.read', 'memory.history.read'] }, openingContext: { available: false } } };
  const status = await f.client.call('capsule_status');
  assert.deepEqual(status.data.capabilities, f.state.body.capabilities);
  await f.client.call('capsule_recall', { query: 'sensors', include: ['history'] });
  assert.deepEqual(f.calls.at(-1).body.include, ['history']);
});


test('new tools consult capabilities before acting and preserve native forget outcomes', async t => {
  const f = await fixture(t);
  f.state.body = { capabilities: { openingContext: { available: false, reason: 'complete_opening_composition_unavailable' }, explicitRemember: { available: false }, statementForget: { available: true } }, removed: false, historyRejected: true };
  for (const tool of ['capsule_context', 'capsule_remember']) {
    assert.equal((await f.client.call(tool, { statement: 'Use metric units.' })).code, 'capability_unavailable');
    assert.equal(f.calls.at(-1).path, '/api/agent-memory/v1');
  }
  const result = await f.client.call('capsule_forget', { statement: 'Use metric units.', uri: 'must-not-forward' });
  assert.equal(result.data.removed, false); assert.equal(result.data.historyRejected, true);
  assert.equal(f.calls.at(-1).path, '/api/agent-memory/v1/forget');
  assert.deepEqual(f.calls.at(-1).body, { statement: 'Use metric units.' });
  assert.match(SYSTEM_PROMPT, /session start/);
});

test('offered opening and remember forward only the public source contract', async t => {
  const f = await fixture(t);
  f.state.body = { capabilities: { openingContext: { available: true }, explicitRemember: { available: true, requiredScopes: ['memory.remember'] } } };
  await f.client.call('capsule_context', { projectId: 'p1', attended: false });
  assert.equal(f.calls.at(-1).path, '/api/agent-memory/v1/context?projectId=p1');
  const input = { statement: 'Use metric units.', source: { client: 'Editor', sessionId: 'one', messageId: 'msg', saidAt: '2026-11-17T01:00:00Z' } };
  await f.client.call('capsule_remember', { ...input, used: true });
  assert.deepEqual(f.calls.at(-1).body, input);
});
