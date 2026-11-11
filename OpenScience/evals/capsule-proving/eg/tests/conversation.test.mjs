import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runConversation, ensureProject } from '../../lx/conversation.mjs';

test('the product catch-all never becomes a newly created named project', async () => {
  assert.equal(await ensureProject({ call: async () => { throw new Error('The product provisions its catch-all'); } }, 'default'), 'default');
});

async function timeoutConversation(continueAfterTimeout) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eg-conversation-'));
  const runs = [], dispatched = [], canceled = [];
  const project = `${dir}/users/eg-test/projects/ordinary`;
  await fs.mkdir(`${project}/.openscience/transcripts`, { recursive: true });
  const api = { async call(method, route, body) {
    if (route === '/api/projects') return { status: 201 };
    if (method === 'PUT') return { status: 200 };
    if (route === '/api/agent-runs/dispatch') {
      dispatched.push(body);
      const run = { id: `run-${runs.length}`, status: runs.length ? 'succeeded' : 'running' };
      runs.push(run);
      await fs.writeFile(`${project}/.openscience/transcripts/${run.id}.jsonl`, JSON.stringify({ type: 'meta' }) + '\n');
      return { status: 202, json: { data: { ...run } } };
    }
    if (route.endsWith('/cancel')) {
      const run = runs.find(r => route.includes(r.id));
      run.status = 'canceled'; canceled.push(run.id);
      return { status: 200 };
    }
    if (route === '/api/agent-runs') return { status: 200, json: { data: runs.map(r => ({ ...r })) } };
    throw new Error(`Unexpected route ${method} ${route}`);
  } };
  try {
    const record = await runConversation({ api, userId: 'eg-test', projectId: 'ordinary', sessionId: 'same-session', first: 'first human turn',
      next: (_turn, i) => i === 0 ? 'next human turn' : null, dataDir: dir, outDir: `${dir}/out`, timeoutMs: 0,
      maxTurns: 2, waitMemoryTools: false, keepRuntime: true, continueAfterTimeout, log: () => {} });
    return { record, dispatched, canceled };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('G1 retains a timed-out turn and continues with the next human text in the same session', async () => {
  const { record, dispatched, canceled } = await timeoutConversation(true);
  assert.equal(record.turns.length, 2);
  assert.equal(record.turns[0].timedOut, true);
  assert.equal(record.turns[0].run.status, 'canceled');
  assert.equal(record.turns[1].run.status, 'succeeded');
  assert.deepEqual(dispatched.map(d => [d.sessionId, d.text]), [['same-session', 'first human turn'], ['same-session', 'next human turn']]);
  assert.notEqual(dispatched[0].dispatchId, dispatched[1].dispatchId);
  assert.deepEqual(canceled, ['run-0']);
});

test('the existing LX default still stops after a timeout', async () => {
  const { record, dispatched } = await timeoutConversation(undefined);
  assert.equal(record.turns.length, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(record.turns[0].run.status, 'canceled');
});
