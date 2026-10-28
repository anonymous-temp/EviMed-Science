import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { databaseUrl, signedIn } from './helpers/knowledgeBaseApp.mjs';
import { createWebApiApp } from '../src/server.mjs';
import { ResearchDbStaging } from '../src/researchDbStaging.mjs';

const external = process.env.OPEN_SCIENCE_TEST_RESEARCH_DB_URL ?? '';
if (external) { const url = new URL(external); assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); assert.match(url.pathname, /evimed_test/); }
const options = { skip: !(databaseUrl && external) && 'Two disposable PostgreSQL databases are required', timeout: 60000 };

test('the production route stays unavailable even when the old gateway key and allowlist are configured', options, async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  let ctx;
  try {
    ctx = await signedIn({ production: false, researchDbAllow: 'db.example.org:5432=8.8.8.8',
      modelGatewaySigningSecret: 'unrelated gateway signing fixture secret', researchDbTestOnly: true, researchDbTestKey: 'test-only fixture encryption secret 12345' });
    const response = await fetch(`${ctx.base}/api/research-databases?projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'research_db_unavailable');
  } finally { await ctx?.close(); if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('a project-owned database snapshot is captured, published, attached and fenced against revocation',
  { ...options, skip: options.skip || (process.env.NODE_ENV !== 'test' && 'Set NODE_ENV=test for the isolated test-only route') }, async () => {
  const admin = new pg.Client({ connectionString: external }); await admin.connect();
  const role = `research_db_app_${process.pid}`;
  await admin.query(`CREATE ROLE ${role}`);
  await admin.query('CREATE TABLE research_db_app_fixture (id integer, name text)');
  await admin.query("INSERT INTO research_db_app_fixture VALUES (1, 'Alice')");
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT ON research_db_app_fixture TO ${role}`);
  let hold = false, entered, resume, crossHold = false, crossEntered, crossResume, crossCount = 0;
  const enter = new Promise(resolve => { entered = resolve; });
  const release = new Promise(resolve => { resume = resolve; });
  const crossReady = new Promise(resolve => { crossEntered = resolve; });
  const crossRelease = new Promise(resolve => { crossResume = resolve; });
  const open = async () => {
    const client = new pg.Client({ connectionString: external }); await client.connect(); await client.query(`SET ROLE ${role}`);
    if (crossHold) { crossCount += 1; if (crossCount === 1) crossEntered(); await crossRelease; }
    if (hold) { entered(); await release; }
    return { client, close: () => client.end() };
  };
  const ctx = await signedIn({ researchDbAllow: 'db.example.org:5432=8.8.8.8', researchDbOpen: open,
    researchDbTestOnly: true, researchDbTestKey: 'research database fixture encryption secret 1234' });
  const other = await signedIn({ researchDbAllow: 'db.example.org:5432=8.8.8.8', researchDbOpen: open,
    researchDbTestOnly: true, researchDbTestKey: 'research database fixture encryption secret 1234' });
  const call = async (route, body, method = 'POST') => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers: ctx.headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const agenda = await ctx.app.autopilotService.create(ctx.user.id, { projectId: ctx.project.id, title: 'Question', topics: ['research'],
      taskTypes: ['evidence-update'], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: 'UTC' });
    const connection = { projectId: ctx.project.id, host: 'db.example.org', port: 5432, database: 'research', username: 'reader', password: 'hidden-fixture-password', requestId: randomUUID() };
    const saved = await call('/api/research-databases', connection); assert.equal(saved.status, 201);
    assert.equal((await call('/api/research-databases', connection)).body.data.id, saved.body.data.id);
    assert.equal((await call('/api/research-databases', { ...connection, password: 'different' })).status, 409);
    assert(!JSON.stringify(saved).includes(connection.password));
    const id = saved.body.data.id;
    const encrypted = await ctx.app.store.database.query('SELECT ciphertext,nonce,tag FROM evimed_control.research_db_connections WHERE user_id=$1 AND id=$2', [ctx.user.id, id]);
    assert(!JSON.stringify(encrypted.rows).includes(connection.password));
    const otherList = await fetch(`${other.base}/api/research-databases?projectId=${encodeURIComponent(other.project.id)}`, { headers: other.headers });
    assert.deepEqual((await otherList.json()).data.items, []);
    const otherDelete = await fetch(`${other.base}/api/research-databases/${id}`, { method: 'DELETE', headers: other.headers,
      body: JSON.stringify({ projectId: other.project.id }) });
    assert.equal((await otherDelete.json()).data.removed, false);
    const request = { projectId: ctx.project.id, agendaId: agenda.id, schema: 'public', table: 'research_db_app_fixture', columns: ['id', 'name'], requestId: randomUUID() };
    const orphanRel = `knowledge-base/.evimed-revisions/${'f'.repeat(64)}/research-database-${randomUUID()}.json`;
    const orphanFile = path.join(ctx.project.baseDir, orphanRel);
    await mkdir(path.dirname(orphanFile), { recursive: true }); await writeFile(orphanFile, 'interrupted staging fixture');
    await ctx.app.store.database.query("INSERT INTO evimed_control.research_db_staging(user_id,project_id,id,path,created_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '3 minutes')",
      [ctx.user.id, ctx.project.id, randomUUID(), orphanRel]);
    const secondApp = createWebApiApp({ dataDir: ctx.dataDir, port: 0, runtimeMode: 'mock', devAuth: false, authMode: 'local',
      bootstrapUser: '', bootstrapPassword: '', stateStore: 'postgres', requireSharedStateStore: true, databaseUrl,
      sourceIngestionEnabled: false, researchDbAllow: 'db.example.org:5432=8.8.8.8', researchDbOpen: open,
      researchDbTestOnly: true, researchDbTestKey: 'research database fixture encryption secret 1234' });
    const secondAddress = await secondApp.listen(0, '127.0.0.1');
    await assert.rejects(readFile(orphanFile), { code: 'ENOENT' }, 'startup reclaims interrupted staging');
    const priorAfterPublication = ctx.app.sourceService.afterPublication;
    ctx.app.sourceService.afterPublication = async () => { throw new Error('Injected alias failure'); };
    secondApp.sourceService.afterPublication = async () => { throw new Error('Injected alias failure'); };
    crossHold = true;
    const firstRequest = call(`/api/research-databases/${id}/snapshot`, request);
    await crossReady;
    const otherRequest = fetch(`http://127.0.0.1:${secondAddress.port}/api/research-databases/${id}/snapshot`, {
      method: 'POST', headers: ctx.headers, body: JSON.stringify(request),
    }).then(async response => ({ status: response.status, body: await response.json() }));
    const rejected = await otherRequest; assert.equal(rejected.status, 429);
    crossResume(); crossHold = false;
    const result = await firstRequest; assert.equal(result.status, 201, JSON.stringify(result));
    const retryOther = await fetch(`http://127.0.0.1:${secondAddress.port}/api/research-databases/${id}/snapshot`, {
      method: 'POST', headers: ctx.headers, body: JSON.stringify(request),
    });
    assert.equal(retryOther.status, 200);
    assert.deepEqual((await retryOther.json()).data, result.body.data, 'cross-instance retry returns the committed result');
    await secondApp.close();
    ctx.app.sourceService.afterPublication = priorAfterPublication;
    const sourceId = result.body.data.sourceId;
    const retry = await call(`/api/research-databases/${id}/snapshot`, request);
    assert.equal(retry.status, 200); assert.deepEqual(retry.body.data, result.body.data);
    assert.equal((await call(`/api/research-databases/${id}/snapshot`, { ...request, columns: ['id'] })).status, 409);
    const source = await ctx.app.sourceService.get(ctx.user.id, sourceId);
    const captured = JSON.parse(await readFile(path.join(ctx.project.baseDir, source.payload.paths[0]), 'utf8'));
    assert.deepEqual(captured.rows, [{ id: { state: 'value', value: '1' }, name: { state: 'value', value: 'Alice' } }]);
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [sourceId]);
    assert(!JSON.stringify(captured).includes(connection.password));
    const files = async () => {
      const root = path.join(ctx.project.baseDir, 'knowledge-base', '.evimed-revisions');
      const entries = await readdir(root, { recursive: true });
      return entries.filter(entry => entry.endsWith('.json')).sort();
    };
    const beforeFailure = await files();
    const add = ctx.app.autopilotService.addMaterials;
    ctx.app.autopilotService.addMaterials = async () => { throw new Error('Injected association failure'); };
    const failed = await call(`/api/research-databases/${id}/snapshot`, { ...request, requestId: randomUUID() });
    ctx.app.autopilotService.addMaterials = add;
    assert.equal(failed.status, 503);
    assert.equal((await files()).length, beforeFailure.length + 1, 'unconfirmed snapshot stays staged until ledger-checked recovery');
    const recovery = new ResearchDbStaging({ database: ctx.app.store.database, store: ctx.app.store });
    await recovery.recover(0);
    assert.deepEqual(await files(), beforeFailure, 'ledger-checked recovery removes rolled-back snapshot bytes');
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [sourceId]);

    const db = ctx.app.store.database, withClient = db.withClient, addMaterials = ctx.app.autopilotService.addMaterials;
    let commitClient = null, acknowledgmentLost = false;
    db.withClient = async operation => withClient.call(db, async client => {
      const query = client.query;
      client.query = async (...args) => {
        const result = await query.apply(client, args);
        if (client === commitClient && args[0] === 'COMMIT' && !acknowledgmentLost) {
          acknowledgmentLost = true;
          throw new Error('Injected lost COMMIT acknowledgment after PostgreSQL committed');
        }
        return result;
      };
      try { return await operation(client); } finally { client.query = query; }
    });
    ctx.app.autopilotService.addMaterials = async (...args) => {
      const value = await addMaterials.apply(ctx.app.autopilotService, args);
      commitClient = db.transactionScope().client;
      return value;
    };
    const uncertainRequest = { ...request, requestId: randomUUID() };
    let uncertain;
    try { uncertain = await call(`/api/research-databases/${id}/snapshot`, uncertainRequest); }
    finally { db.withClient = withClient; ctx.app.autopilotService.addMaterials = addMaterials; }
    assert.equal(acknowledgmentLost, true, 'the database applied COMMIT before the injected failure');
    assert.equal(uncertain.status, 503);
    const recovered = await call(`/api/research-databases/${id}/snapshot`, uncertainRequest);
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    const committedSource = await ctx.app.sourceService.get(ctx.user.id, recovered.body.data.sourceId);
    const committedFile = path.join(ctx.project.baseDir, committedSource.payload.paths[0]);
    const committedBytes = await readFile(committedFile);
    await recovery.recover(0);
    assert.deepEqual(await readFile(committedFile), committedBytes, 'recovery retains a source from a committed transaction with a lost acknowledgment');
    await ctx.app.autopilotService.removeMaterial(ctx.user.id, agenda.id, committedSource.id);
    hold = true;
    const pending = call(`/api/research-databases/${id}/snapshot`, { ...request, requestId: randomUUID() });
    await enter;
    const deleted = await call(`/api/research-databases/${id}`, { projectId: ctx.project.id }, 'DELETE'); assert.equal(deleted.status, 200);
    assert.equal((await call('/api/research-databases', connection)).status, 410);
    resume();
    const blocked = await pending; assert.equal(blocked.status, 404, JSON.stringify(blocked));
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [sourceId]);

    const second = await call('/api/research-databases', { ...connection, requestId: randomUUID() }); assert.equal(second.status, 201);
    const secondId = second.body.data.id;
    hold = false;
    let publishing, continuePublication;
    const inPublication = new Promise(resolve => { publishing = resolve; });
    const publicationRelease = new Promise(resolve => { continuePublication = resolve; });
    const originalAdd = ctx.app.autopilotService.addMaterials.bind(ctx.app.autopilotService);
    ctx.app.autopilotService.addMaterials = async (...args) => { publishing(); await publicationRelease; return originalAdd(...args); };
    const publishingSnapshot = call(`/api/research-databases/${secondId}/snapshot`, { ...request, requestId: randomUUID() });
    await inPublication;
    let removed = false;
    const removal = call(`/api/research-databases/${secondId}`, { projectId: ctx.project.id }, 'DELETE').then(value => { removed = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(removed, false, 'revocation waits for the publication transaction'); }
    finally { continuePublication(); }
    const published = await publishingSnapshot; assert.equal(published.status, 201, JSON.stringify(published));
    assert.equal((await removal).body.data.removed, true);
    assert.equal((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.length, 2);
  } finally {
    resume(); await other.close(); await ctx.close();
    await admin.query('DROP TABLE IF EXISTS research_db_app_fixture');
    await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});
