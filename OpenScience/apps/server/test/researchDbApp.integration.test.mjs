import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { sourceOriginOf } from '@evimed/domain';
import { sourceDisplayOf } from '../src/sourceDisplay.mjs';
import { databaseUrl, signedIn } from './helpers/knowledgeBaseApp.mjs';
import { createWebApiApp } from '../src/server.mjs';
import { ResearchDbStaging } from '../src/researchDbStaging.mjs';
import { HttpError } from '../src/security.mjs';
import { loadAutopilotProgress } from '../src/autopilotProgress.mjs';
import { RUNTIME_KNOWLEDGE_DIR } from '../src/researchContext.mjs';

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
  // The readiness check: off, or on and whether the keyring covers every saved credential. Green either way: the feature is down, the platform is not.
  const readiness = async ctx => (await (await fetch(`${ctx.base}/api/ready`)).json()).data.checks.researchDb;
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
    assert.deepEqual(await readiness(injected), { ok: true, required: false, enabled: false }, 'off is a green fact');
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
    assert.deepEqual(await readiness(on), { ok: true, required: false, enabled: true });
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
    assert.deepEqual(await readiness(incomplete), { ok: true, required: false, enabled: true, warning: 'research_db_keyring_incomplete' }, 'a keyring that does not cover what is saved is a warning, never a red check');
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
  let secondApp = null;
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
      columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }], omittedColumnCount: 0, unsupportedColumns: [], unsupportedColumnCount: 0 });
    assert.equal(listing.truncated, false);
    assert.deepEqual(listing.limits, { rows: 20000, columns: 64, cellBytes: 32768 }, 'the dialog says the limits the deployment has');
    // The saved connection is named for the dialog by its host and database, never by its user name or password.
    const named = (await (await fetch(`${ctx.base}/api/research-databases?projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers })).json()).data.items;
    assert.deepEqual(named.map(item => [item.id, item.label]), [[id, 'db.example.org/research']]);
    assert.equal((await fetch(`${other.base}/api/research-databases/${id}/tables?projectId=${encodeURIComponent(other.project.id)}`, { headers: other.headers })).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/research-databases/${id}/tables?projectId=no-such-project`, { headers: ctx.headers })).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/research-databases/status?projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers }).then(response => response.json())).data.available, true);
    const request = { projectId: ctx.project.id, agendaId: agenda.id, schema: 'public', table: 'research_db_app_fixture', columns: ['id', 'name'], requestId: randomUUID() };
    const orphanRel = `knowledge-base/databases/.evimed-revisions/${'f'.repeat(64)}/public.orphan_table-1a2b3c4d.csv`;
    const orphanFile = path.join(ctx.project.baseDir, orphanRel);
    await mkdir(path.dirname(orphanFile), { recursive: true }); await writeFile(orphanFile, 'interrupted staging fixture');
    await ctx.app.store.database.query("INSERT INTO evimed_control.research_db_staging(user_id,project_id,id,path,created_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '3 minutes')",
      [ctx.user.id, ctx.project.id, randomUUID(), orphanRel]);
    secondApp = createWebApiApp({ dataDir: ctx.dataDir, port: 0, runtimeMode: 'mock', devAuth: false, authMode: 'local',
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
    // The admission is in this process: while one import of the person is reading, a second answers busy at once. It holds
    // no connection of the control-plane database while it waits.
    const busy = await call(`/api/research-databases/${id}/snapshot`, request);
    assert.equal(busy.status, 429); assert.equal(busy.body.code, 'research_db_busy');
    const idle = await ctx.app.store.database.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'");
    assert.equal(idle.rows[0].n, 0, 'a remote read pins no connection of the control plane\'s pool');
    crossResume(); crossHold = false;
    const result = await firstRequest; assert.equal(result.status, 201, JSON.stringify(result));
    assert.deepEqual(Object.keys(result.body.data).sort(), ['capturedAt', 'columns', 'droppedColumnCount', 'droppedColumns', 'oversizedValuesWithheld', 'partial', 'rowCount', 'sidecar',
      'sourceId', 'stoppedBy', 'title', 'totalRows', 'totalRowsExact', 'truncated', 'version', 'withheldCells']);
    assert.equal(result.body.data.columns, 2); assert.equal(result.body.data.rowCount, 1); assert.equal(result.body.data.truncated, false);
    assert.equal(result.body.data.partial, false); assert.equal(result.body.data.totalRows, 1); assert.equal(result.body.data.version, 1);
    assert.equal(result.body.data.title, 'public.research_db_app_fixture');
    const retryOther = await fetch(`http://127.0.0.1:${secondAddress.port}/api/research-databases/${id}/snapshot`, {
      method: 'POST', headers: ctx.headers, body: JSON.stringify(request),
    });
    assert.equal(retryOther.status, 200);
    assert.deepEqual((await retryOther.json()).data, result.body.data, 'cross-instance retry returns the committed result');
    await secondApp.close(); secondApp = null;
    ctx.app.sourceService.afterPublication = priorAfterPublication;
    const sourceId = result.body.data.sourceId;
    const retry = await call(`/api/research-databases/${id}/snapshot`, request);
    assert.equal(retry.status, 200); assert.deepEqual(retry.body.data, result.body.data);
    assert.equal((await call(`/api/research-databases/${id}/snapshot`, { ...request, columns: ['id'] })).status, 409);
    const source = await ctx.app.sourceService.get(ctx.user.id, sourceId);
    assert.match(source.payload.paths[0], /^knowledge-base\/databases\/\.evimed-revisions\/[a-f0-9]{64}\/public\.research_db_app_fixture-[a-f0-9]{8}\.csv$/);
    assert.equal(source.payload.title, 'public.research_db_app_fixture');
    assert.equal(source.payload.logicalPath, `knowledge-base/databases/${path.posix.basename(source.payload.paths[0])}`, 'one identity per connection, schema and table: no capture time in it');
    assert.equal(source.payload.snapshot.kind, 'research-database-snapshot'); assert.equal(source.payload.snapshot.partial, false); assert.equal(source.payload.snapshot.rowCount, 1);
    assert.equal(sourceOriginOf({ connectorType: 'upload', path: source.payload.paths[0] }), 'database');
    assert.equal(sourceDisplayOf(source).origin, 'database', 'the knowledge base lists it as a database table');
    // The sidecar sits beside the CSV, says the table was read whole, and is not a source of its own.
    const sidecarPath = source.payload.paths[0].replace(/\.csv$/, '.import.json');
    assert.equal(result.body.data.sidecar, sidecarPath); assert.equal(source.payload.snapshot.sidecar, sidecarPath);
    const note = JSON.parse(await readFile(path.join(ctx.project.baseDir, sidecarPath), 'utf8'));
    assert.equal(note.rows.complete, true); assert.equal(note.rows.exported, 1); assert.equal(note.table.name, 'research_db_app_fixture'); assert.equal(note.database.name, 'research');
    assert(!JSON.stringify(note).includes(connection.password) && !JSON.stringify(note).includes('"reader"'), 'no credential reaches the sidecar');
    assert.equal((await ctx.app.sourceService.list(ctx.user.id, { projectId: ctx.project.id, limit: 50 })).items.filter(item => item.payload.paths.some(file => file.endsWith('.json'))).length, 0);
    const captured = await readFile(path.join(ctx.project.baseDir, source.payload.paths[0]), 'utf8');
    assert.equal(captured, '\uFEFFid,name\r\n1,Alice\r\n');
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [sourceId]);
    assert(!JSON.stringify(captured).includes(connection.password));
    const files = async () => {
      const root = path.join(ctx.project.baseDir, 'knowledge-base', 'databases', '.evimed-revisions');
      const entries = await readdir(root, { recursive: true });
      return entries.filter(entry => entry.endsWith('.csv') || entry.endsWith('.import.json')).sort();
    };
    const beforeFailure = await files();
    const add = ctx.app.autopilotService.addMaterials;
    ctx.app.autopilotService.addMaterials = async () => { throw new Error('Injected association failure'); };
    await grow(2);
    const failed = await call(`/api/research-databases/${id}/snapshot`, { ...request, requestId: randomUUID() });
    ctx.app.autopilotService.addMaterials = add;
    assert.equal(failed.status, 503);
    assert.equal((await files()).length, beforeFailure.length + 2, 'unconfirmed snapshot (the CSV and its sidecar) stays staged until ledger-checked recovery');
    const recovery = new ResearchDbStaging({ database: ctx.app.store.database, store: ctx.app.store });
    await recovery.recover(0);
    assert.deepEqual(await files(), beforeFailure, 'ledger-checked recovery removes rolled-back snapshot bytes and the sidecar beside them');
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
    // Importing the table again is a new version of the same source: the first version is retired, and the question's
    // material points at the new one instead of holding both.
    assert.equal(recovered.body.data.version, 2); assert.notEqual(committedSource.id, sourceId);
    assert.equal(committedSource.payload.familyId, source.payload.familyId); assert.equal(committedSource.payload.logicalPath, source.payload.logicalPath);
    assert.equal((await ctx.app.sourceService.get(ctx.user.id, sourceId)).payload.publication.current, false);
    assert.equal(committedSource.payload.publication.current, true);
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [committedSource.id]);
    const committedFile = path.join(ctx.project.baseDir, committedSource.payload.paths[0]);
    const committedBytes = await readFile(committedFile);
    await recovery.recover(0);
    assert.deepEqual(await readFile(committedFile), committedBytes, 'recovery retains a source from a committed transaction with a lost acknowledgment');
    await ctx.app.autopilotService.removeMaterial(ctx.user.id, agenda.id, committedSource.id);
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials, []);
    await grow(4);
    hold = true;
    const pending = call(`/api/research-databases/${id}/snapshot`, { ...request, requestId: randomUUID() });
    await enter;
    const deleted = await call(`/api/research-databases/${id}`, { projectId: ctx.project.id }, 'DELETE'); assert.equal(deleted.status, 200);
    assert.equal((await call('/api/research-databases', connection)).status, 410);
    resume();
    const blocked = await pending; assert.equal(blocked.status, 404, JSON.stringify(blocked));
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials, [], 'a revoked connection published nothing');

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
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [published.body.data.sourceId]);

    // No `columns` means every supported column; an empty list is the same request, so a retry in either form is one result.
    const third = await call('/api/research-databases', { ...connection, requestId: randomUUID() }); assert.equal(third.status, 201);
    await grow(6);
    const everything = { projectId: ctx.project.id, agendaId: agenda.id, schema: 'public', table: 'research_db_app_fixture', requestId: randomUUID() };
    const whole = await call(`/api/research-databases/${third.body.data.id}/snapshot`, everything);
    assert.equal(whole.status, 201, JSON.stringify(whole)); assert.equal(whole.body.data.columns, 2); assert.equal(whole.body.data.rowCount, 6);
    assert.equal(whole.body.data.version, 4, 'the fourth version of the same table');
    assert.deepEqual((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.map(item => item.sourceId), [whole.body.data.sourceId], 'the question holds the newest version only');
    const again = await call(`/api/research-databases/${third.body.data.id}/snapshot`, { ...everything, columns: [] });
    assert.equal(again.status, 200); assert.deepEqual(again.body.data, whole.body.data);
    const wholeSource = await ctx.app.sourceService.get(ctx.user.id, whole.body.data.sourceId);
    const wholeText = await readFile(path.join(ctx.project.baseDir, wholeSource.payload.paths[0]), 'utf8');
    assert.equal(wholeText.split('\r\n')[0], '﻿id,name');
    assert(wholeText.includes('6,"第二, ""行"""\r\n'), 'a comma and quotes in a cell are quoted as RFC 4180 says');
  } finally {
    resume(); await secondApp?.close().catch(() => {}); await other.close(); await ctx.close();
    await admin.query('DROP TABLE IF EXISTS research_db_app_fixture');
    await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});

test('an import that left something out says so in the title, the source, the sidecar and the material entry; the counters, the audit and the question\'s room follow',
  { ...options, skip: options.skip || (process.env.NODE_ENV !== 'test' && 'Set NODE_ENV=test for the isolated test-only route') }, async () => {
  const admin = new pg.Client({ connectionString: external }); await admin.connect();
  const role = `research_db_part_${process.pid}`;
  await admin.query(`CREATE ROLE ${role}`);
  await admin.query('CREATE TABLE research_db_part_fixture (id integer, note text, doc jsonb, state_note varchar(10))');
  await admin.query(`INSERT INTO research_db_part_fixture VALUES (1, repeat('x', 400), '{}', 'a'), (2, NULL, '{}', 'b'), (3, 'plain', '{}', 'c'), (4, 'four', '{}', 'd'), (5, 'five', '{}', 'e')`);
  await admin.query('CREATE TABLE research_db_part_other (id integer)'); await admin.query('INSERT INTO research_db_part_other VALUES (1)');
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT ON research_db_part_fixture, research_db_part_other TO ${role}`);
  let opened = 0, failure = null, asSuperuser = false;
  const open = async () => {
    opened += 1;
    if (failure) throw failure;
    const client = new pg.Client({ connectionString: external }); await client.connect();
    if (!asSuperuser) await client.query(`SET ROLE ${role}`);
    return { client, close: () => client.end() };
  };
  // A tight deployment: three rows and a 256-byte cell, so a five-row table with one long cell is cut.
  const ctx = await signedIn({ researchDbAllow: 'db.example.org:5432=8.8.8.8', researchDbOpen: open, researchDbLimits: { rows: 3, cellBytes: 256 },
    researchDbTestOnly: true, researchDbTestKey: 'research database fixture encryption secret 1234' });
  const call = async (route, body, method = 'POST') => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers: ctx.headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const auditLines = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const text = await readFile(path.join(ctx.project.metaDir, 'audit.jsonl'), 'utf8').catch(() => '');
      const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(line => line.action.startsWith('research_db.'));
      if (lines.length >= (auditLines.expect ?? 1)) return lines;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return [];
  };
  try {
    const { resetResearchDbMetrics, researchDbMetricSnapshot } = await import('../src/researchDbMetrics.mjs');
    resetResearchDbMetrics();
    const agenda = await ctx.app.autopilotService.create(ctx.user.id, { projectId: ctx.project.id, title: 'Question', topics: ['research'],
      taskTypes: ['evidence-update'], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: 'UTC' });
    const connection = { projectId: ctx.project.id, host: 'Db.Example.org', port: 5432, database: 'research', username: 'reader', password: 'hidden-fixture-password', requestId: randomUUID() };
    const saved = await call('/api/research-databases', connection); assert.equal(saved.status, 201);
    const id = saved.body.data.id;
    const request = (table, extra = {}) => ({ projectId: ctx.project.id, agendaId: agenda.id, schema: 'public', table, requestId: randomUUID(), ...extra });

    // The listing says which columns the snapshot will not read.
    const listing = (await (await fetch(`${ctx.base}/api/research-databases/${id}/tables?projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers })).json()).data;
    const part = listing.tables.find(item => item.table === 'research_db_part_fixture');
    assert.deepEqual(part.unsupportedColumns, [{ name: 'doc', type: 'jsonb' }]); assert.equal(part.unsupportedColumnCount, 1);
    assert.deepEqual(listing.limits, { rows: 3, columns: 64, cellBytes: 256 });

    // A cut import: the title, the facts, the sidecar, the CSV and the material entry all say what was left out.
    const firstRequest = request('research_db_part_fixture');
    const first = await call(`/api/research-databases/${id}/snapshot`, firstRequest);
    assert.equal(first.status, 201, JSON.stringify(first));
    const data = first.body.data;
    const title = 'public.research_db_part_fixture（前 3 行，共 5 行；1 列类型不支持未导入；1 个超长单元格已省略）';
    assert.equal(data.title, title);
    assert.deepEqual([data.partial, data.truncated, data.rowCount, data.totalRows, data.totalRowsExact, data.stoppedBy, data.withheldCells, data.droppedColumnCount, data.oversizedValuesWithheld],
      [true, true, 3, 5, true, 'rows', 1, 1, true]);
    assert.deepEqual(data.droppedColumns, [{ name: 'doc', type: 'jsonb', reason: 'unsupported_type' }]);
    const source = await ctx.app.sourceService.get(ctx.user.id, data.sourceId);
    assert.equal(source.payload.title, title);
    assert.equal(source.payload.snapshot.partial, true); assert.equal(source.payload.snapshot.totalRows, 5); assert.equal(source.payload.snapshot.droppedColumns[0].name, 'doc');
    assert.equal(sourceDisplayOf(source).title, title, 'the knowledge base shows the title with what was left out');
    const csv = await readFile(path.join(ctx.project.baseDir, source.payload.paths[0]), 'utf8');
    assert.equal(csv, '﻿id,note,state_note\r\n1,__evimed_withheld__,a\r\n2,,b\r\n3,plain,c\r\n', 'a withheld cell is not an empty one');
    const note = JSON.parse(await readFile(path.join(ctx.project.baseDir, data.sidecar), 'utf8'));
    assert.deepEqual([note.rows.complete, note.rows.exported, note.rows.total, note.rows.stoppedBy, note.withheldCells.count, note.withheldCells.token], [false, 3, 5, 'rows', 1, '__evimed_withheld__']);
    assert.deepEqual(note.withheldCells.byColumn, { note: 1 }); assert.equal(note.droppedColumns[0].reason, 'unsupported_type');
    assert.equal(note.database.host, 'db.example.org', 'the host is kept in lower case');
    assert.match(note.howToRead.join(' '), /NOT the whole table/);
    // The study's material entry carries it, with the path a run opens.
    const state = await ctx.app.autopilotService.researchState(ctx.user.id, agenda.id);
    assert.equal(state.materials.length, 1);
    assert.deepEqual(state.materials[0].import, { fromDatabase: true, partial: true, truncated: true, rowCount: 3, totalRows: 5, totalRowsExact: true, withheldCells: 1,
      droppedColumnCount: 1, details: `${RUNTIME_KNOWLEDGE_DIR}/${data.sidecar.slice('knowledge-base/'.length)}` });
    const progress = await loadAutopilotProgress(ctx.app.autopilotService.documents, { userId: ctx.user.id, agenda: await ctx.app.autopilotService.get(ctx.user.id, agenda.id),
      date: '2026-10-29', episodeId: '', asOf: new Date().toISOString() });
    assert.equal(progress.materials[0].import.partial, true);
    assert.equal(progress.materials[0].path.endsWith('.csv'), true);

    // Counters: one partial import, and the three limits that bit.
    let metrics = researchDbMetricSnapshot();
    assert.deepEqual([metrics.imports.partial, metrics.imports.complete, metrics.refusals.truncated, metrics.refusals.cells_withheld, metrics.refusals.columns_dropped], [1, 0, 1, 1, 1]);
    // A retry of the same request is answered with the first result and counted as a replay, not as a second import.
    const retried = await call(`/api/research-databases/${id}/snapshot`, firstRequest);
    assert.equal(retried.status, 200); assert.deepEqual(retried.body.data, data);
    metrics = researchDbMetricSnapshot(); assert.deepEqual([metrics.imports.replayed, metrics.imports.partial], [1, 1]);
    // A complete small table is complete, and counted so.
    const other = await call(`/api/research-databases/${id}/snapshot`, request('research_db_part_other'));
    assert.equal(other.status, 201); assert.equal(other.body.data.partial, false); assert.equal(other.body.data.title, 'public.research_db_part_other');
    metrics = researchDbMetricSnapshot(); assert.equal(metrics.imports.complete, 1);

    // The two tables are two documents in the question's material, each one version of its own source.
    assert.equal((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.length, 2);

    // Failures are told apart, counted, and audited by their code.
    const refusals = [
      [new HttpError(403, 'research_db_network_denied', 'x'), 'research_db_network_denied', 'network_denied'],
      [new HttpError(502, 'research_db_tls_failed', 'x'), 'research_db_tls_failed', 'tls_failed'],
      [new HttpError(502, 'research_db_login_failed', 'x'), 'research_db_login_failed', 'login_failed'],
      [new HttpError(502, 'research_db_unreachable', 'x'), 'research_db_unreachable', 'unreachable'],
      [new Error('socket hang up'), 'research_db_unavailable', 'failed'],
    ];
    for (const [error, code, reason] of refusals) {
      failure = error; const before = researchDbMetricSnapshot().refusals[reason];
      const refused = await call(`/api/research-databases/${id}/snapshot`, request('research_db_part_other'));
      assert.equal(refused.body.code, code, code);
      assert.equal(researchDbMetricSnapshot().refusals[reason], before + 1, reason);
    }
    failure = null;
    // A superuser login is its own answer, whether the person lists or imports.
    asSuperuser = true;
    const privileged = await call(`/api/research-databases/${id}/snapshot`, request('research_db_part_other'));
    assert.equal(privileged.status, 400); assert.equal(privileged.body.code, 'research_db_login_too_privileged');
    assert.equal((await fetch(`${ctx.base}/api/research-databases/${id}/tables?projectId=${encodeURIComponent(ctx.project.id)}`, { headers: ctx.headers })).status, 400);
    asSuperuser = false;
    assert.equal(researchDbMetricSnapshot().refusals.too_privileged, 2);

    // The question's room: filled to its twenty, a NEW table is refused before the remote database is read; a new version of a
    // table it holds is not, and takes the old one's place.
    const material = [];
    for (let index = 0; index < 18; index += 1) {
      const registered = await ctx.app.sourceService.register(ctx.user.id, { projectId: ctx.project.id, connector: { type: 'upload', id: 'dummy' }, path: `knowledge-base/room-${index}.txt`,
        size: 1, mtime: new Date().toISOString(), mimeType: 'text/plain', sha256: createHash('sha256').update(`room ${index}`).digest('hex') });
      material.push(registered.source.id);
    }
    await ctx.app.autopilotService.addMaterials(ctx.user.id, agenda.id, { sourceIds: material.slice(0, 9) });
    await ctx.app.autopilotService.addMaterials(ctx.user.id, agenda.id, { sourceIds: material.slice(9) });
    assert.equal((await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials.length, 20);
    await admin.query('CREATE TABLE research_db_part_third (id integer)'); await admin.query(`GRANT SELECT ON research_db_part_third TO ${role}`);
    const before = opened;
    const full = await call(`/api/research-databases/${id}/snapshot`, request('research_db_part_third'));
    assert.equal(full.status, 409); assert.equal(full.body.code, 'autopilot_materials_full');
    assert.equal(opened, before, 'the remote database was not opened for an import that could not be kept');
    assert.equal(researchDbMetricSnapshot().refusals.materials_full, 1);
    await admin.query("INSERT INTO research_db_part_other VALUES (2)");
    const again = await call(`/api/research-databases/${id}/snapshot`, request('research_db_part_other'));
    assert.equal(again.status, 201, JSON.stringify(again)); assert.equal(again.body.data.version, 2);
    const materials = (await ctx.app.autopilotService.get(ctx.user.id, agenda.id)).payload.materials;
    assert.equal(materials.length, 20, 'the new version took the old one\'s place');
    assert(materials.some(item => item.sourceId === again.body.data.sourceId) && !materials.some(item => item.sourceId === other.body.data.sourceId));

    // The audit: a line for the credential and for each import, failures with their code, never a secret.
    auditLines.expect = 5;
    const lines = await auditLines();
    const actions = lines.map(line => `${line.action}:${line.status}`);
    for (const wanted of ['research_db.connection.save:completed', 'research_db.import:completed', 'research_db.import:failed']) assert(actions.includes(wanted), `${wanted} in ${actions.join(', ')}`);
    assert(lines.some(line => line.action === 'research_db.import' && line.status === 'failed' && line.error === 'research_db_tls_failed'));
    assert(lines.some(line => line.action === 'research_db.connection.save' && line.target === id));
    assert(!JSON.stringify(lines).match(/hidden-fixture-password|reader|db\.example\.org/i), 'no password, user name or host in an audit line');
    const removed = await call(`/api/research-databases/${id}`, { projectId: ctx.project.id }, 'DELETE'); assert.equal(removed.body.data.removed, true);
    auditLines.expect = lines.length + 1;
    assert((await auditLines()).some(line => line.action === 'research_db.connection.remove' && line.target === id));
  } finally {
    await ctx.close();
    await admin.query('DROP TABLE IF EXISTS research_db_part_fixture, research_db_part_other, research_db_part_third');
    await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});
