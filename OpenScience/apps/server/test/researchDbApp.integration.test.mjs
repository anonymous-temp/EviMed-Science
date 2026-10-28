import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { databaseUrl, signedIn } from './helpers/knowledgeBaseApp.mjs';
import { createWebApiApp } from '../src/server.mjs';
import { ResearchDbStaging } from '../src/researchDbStaging.mjs';

const external = process.env.OPEN_SCIENCE_TEST_RESEARCH_DB_URL ?? '';
if (external) { const url = new URL(external); assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); assert.match(url.pathname, /evimed_test/); }
const options = { skip: !(databaseUrl && external) && 'Two disposable PostgreSQL databases are required', timeout: 60000 };

/** An owner-only keyring file with one fresh key; returns its path and key id. @param {string} dir @param {string} name */
async function keyringFile(dir, name) {
  const bytes = randomBytes(32), id = createHash('sha256').update(bytes).digest('hex'), file = path.join(dir, name);
  await writeFile(file, JSON.stringify({ activeId: id, keys: { [id]: bytes.toString('base64') } }), { mode: 0o600 });
  return { file, id };
}

test('in production the connector needs an allowlist and an owner-only keyring file, and a keyring that misses a saved key stops it', options, async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const dir = await mkdtemp(path.join(tmpdir(), 'research-db-keyring-app-'));
  const allow = 'db.example.org:5432=8.8.8.8', apps = [];
  const start = async (overrides) => { const app = await signedIn({ production: false, modelGatewaySigningSecret: 'unrelated gateway signing fixture secret', ...overrides }); apps.push(app); return app; };
  const get = (ctx, route) => fetch(`${ctx.base}/api/research-databases${route}${route.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers });
  const status = async ctx => { const response = await get(ctx, '/status'); assert.equal(response.status, 200); return (await response.json()).data.available; };
  const unavailable = async (ctx, code = 'research_db_unavailable') => {
    for (const route of ['', `/${randomUUID()}/tables`]) {
      const response = await get(ctx, route); assert.equal(response.status, 503, route);
      assert.equal((await response.json()).code, code);
    }
    const response = await fetch(`${ctx.base}/api/research-databases/${randomUUID()}/snapshot`, { method: 'POST', headers: ctx.headers, body: '{}' });
    assert.equal(response.status, 503); assert.equal((await response.json()).code, code);
  };
  try {
    const good = await keyringFile(dir, 'good.json'), other = await keyringFile(dir, 'other.json'), loose = await keyringFile(dir, 'loose.json');
    await chmod(loose.file, 0o644);
    // The old test injection and the gateway signing secret do not enable it, and neither does one half of the configuration.
    const injected = await start({ researchDbAllow: allow, researchDbTestOnly: true, researchDbTestKey: 'test-only fixture encryption secret 12345' });
    assert.equal(await status(injected), false); await unavailable(injected);
    const noKeyring = await start({ researchDbAllow: allow });
    assert.equal(await status(noKeyring), false); await unavailable(noKeyring);
    const noAllow = await start({ researchDbKeyringFile: good.file });
    assert.equal(await status(noAllow), false); await unavailable(noAllow);
    const wrongMode = await start({ researchDbAllow: allow, researchDbKeyringFile: loose.file });
    assert.equal(await status(wrongMode), false); await unavailable(wrongMode);
    const missing = await start({ researchDbAllow: allow, researchDbKeyringFile: path.join(dir, 'absent.json') });
    assert.equal(await status(missing), false); await unavailable(missing);
    // Both configured: available, and the saved credential is sealed under the keyring's own key id.
    const on = await start({ researchDbAllow: allow, researchDbKeyringFile: good.file });
    assert.equal(await status(on), true);
    const listed = await get(on, ''); assert.equal(listed.status, 200); assert.deepEqual((await listed.json()).data.items, []);
    const saved = await fetch(`${on.base}/api/research-databases`, { method: 'POST', headers: on.headers, body: JSON.stringify({
      projectId: on.project.id, host: 'db.example.org', port: 5432, database: 'research', username: 'reader', password: 'hidden-production-password', requestId: randomUUID() }) });
    assert.equal(saved.status, 201);
    const sealed = await on.app.store.database.query('SELECT key_id, ciphertext FROM evimed_control.research_db_connections WHERE user_id=$1', [on.user.id]);
    assert.deepEqual(sealed.rows.map(row => row.key_id), [good.id]); assert(!sealed.rows[0].ciphertext.includes(Buffer.from('hidden-production-password')));
    // The status route checks session and project.
    assert.equal((await fetch(`${on.base}/api/research-databases/status?projectId=no-such-project`, { headers: on.headers })).status, 404);
    assert.equal((await fetch(`${on.base}/api/research-databases/status?projectId=${encodeURIComponent(on.project.id)}`)).status, 401);
    // Another keyring that lacks the key of a saved credential refuses every route until the key is restored.
    const incomplete = await start({ researchDbAllow: allow, researchDbKeyringFile: other.file });
    assert.equal(await status(incomplete), false); await unavailable(incomplete, 'research_db_keyring_incomplete');
    assert.equal(await status(on), true, 'the instance whose keyring covers the credential is not affected');
  } finally {
    for (const app of apps.reverse()) await app.close();
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a project-owned database snapshot is captured, published, attached and fenced against revocation',
  { ...options, skip: options.skip || (process.env.NODE_ENV !== 'test' && 'Set NODE_ENV=test for the isolated test-only route') }, async () => {
  const admin = new pg.Client({ connectionString: external }); await admin.connect();
  const role = `research_db_app_${process.pid}`;
  await admin.query(`CREATE ROLE ${role}`);
  await admin.query('CREATE TABLE research_db_app_fixture (id integer, name text)');
  await admin.query("INSERT INTO research_db_app_fixture VALUES (1, 'Alice')");
  // The same bytes are the same source, so each snapshot below is taken of a table which has grown.
  const grow = id => admin.query("INSERT INTO research_db_app_fixture VALUES ($1, '第二, \"行\"')", [id]);
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
    // Discovery: the saved connection lists the readable tables with their supported columns; another account sees nothing of it.
    const listed = await fetch(`${ctx.base}/api/research-databases/${id}/tables?projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers });
    assert.equal(listed.status, 200);
    const listing = (await listed.json()).data;
    const fixtureTable = listing.tables.find(item => item.table === 'research_db_app_fixture');
    assert(fixtureTable.estimatedRows === null || Number.isInteger(fixtureTable.estimatedRows));
    assert.deepEqual({ ...fixtureTable, estimatedRows: 0 }, { schema: 'public', table: 'research_db_app_fixture', estimatedRows: 0,
      columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] });
    assert.equal(listing.truncated, false);
    assert.equal((await fetch(`${other.base}/api/research-databases/${id}/tables?projectId=${encodeURIComponent(other.project.id)}`, { headers: other.headers })).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/research-databases/${id}/tables?projectId=no-such-project`, { headers: ctx.headers })).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/research-databases/status?projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers }).then(response => response.json())).data.available, true);
    const request = { projectId: ctx.project.id, agendaId: agenda.id, schema: 'public', table: 'research_db_app_fixture', columns: ['id', 'name'], requestId: randomUUID() };
    const orphanRel = `knowledge-base/.evimed-revisions/${'f'.repeat(64)}/orphan_table-20261028-010203.csv`;
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
    assert.deepEqual(Object.keys(result.body.data).sort(), ['capturedAt', 'columns', 'oversizedValuesWithheld', 'rowCount', 'sourceId', 'truncated']);
    assert.equal(result.body.data.columns, 2); assert.equal(result.body.data.rowCount, 1); assert.equal(result.body.data.truncated, false);
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
    assert.match(source.payload.paths[0], /^knowledge-base\/\.evimed-revisions\/[a-f0-9]{64}\/research_db_app_fixture-\d{8}-\d{6}\.csv$/);
    assert.equal(source.payload.title, 'public.research_db_app_fixture');
    const captured = await readFile(path.join(ctx.project.baseDir, source.payload.paths[0]), 'utf8');
    assert.equal(captured, '\uFEFFid,name\r\n1,Alice\r\n');
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [sourceId]);
    assert(!JSON.stringify(captured).includes(connection.password));
    const files = async () => {
      const root = path.join(ctx.project.baseDir, 'knowledge-base', '.evimed-revisions');
      const entries = await readdir(root, { recursive: true });
      return entries.filter(entry => entry.endsWith('.csv')).sort();
    };
    const beforeFailure = await files();
    const add = ctx.app.autopilotService.addMaterials;
    ctx.app.autopilotService.addMaterials = async () => { throw new Error('Injected association failure'); };
    await grow(2);
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
    await grow(3);
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
    await grow(4);
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
    await grow(5);
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

    // No `columns` means every supported column; an empty list is the same request, so a retry in either form is one result.
    const third = await call('/api/research-databases', { ...connection, requestId: randomUUID() }); assert.equal(third.status, 201);
    await grow(6);
    const everything = { projectId: ctx.project.id, agendaId: agenda.id, schema: 'public', table: 'research_db_app_fixture', requestId: randomUUID() };
    const whole = await call(`/api/research-databases/${third.body.data.id}/snapshot`, everything);
    assert.equal(whole.status, 201, JSON.stringify(whole)); assert.equal(whole.body.data.columns, 2); assert.equal(whole.body.data.rowCount, 6);
    const again = await call(`/api/research-databases/${third.body.data.id}/snapshot`, { ...everything, columns: [] });
    assert.equal(again.status, 200); assert.deepEqual(again.body.data, whole.body.data);
    const wholeSource = await ctx.app.sourceService.get(ctx.user.id, whole.body.data.sourceId);
    const wholeText = await readFile(path.join(ctx.project.baseDir, wholeSource.payload.paths[0]), 'utf8');
    assert.equal(wholeText.split('\r\n')[0], '﻿id,name');
    assert(wholeText.includes('6,"第二, ""行"""\r\n'), 'a comma and quotes in a cell are quoted as RFC 4180 says');
  } finally {
    resume(); await other.close(); await ctx.close();
    await admin.query('DROP TABLE IF EXISTS research_db_app_fixture');
    await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});
