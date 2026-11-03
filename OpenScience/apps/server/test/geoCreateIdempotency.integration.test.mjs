import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { FrontierGlossaryStore } from '../src/frontierGlossary.mjs';
import { GEO_TABLES } from '../src/geoPersistence.mjs';
import { createWebApiApp } from '../src/server.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('GEO creation request replay is atomic and account scoped', { skip: !databaseUrl && 'Disposable test PostgreSQL required', timeout: 60_000 }, async (t) => {
  const isolated = await createGeoTestDatabase(databaseUrl, 'geocreate');
  const testDatabaseUrl = isolated.url;
  const dir = await mkdtemp(path.join(tmpdir(), 'geo-idempotency-'));
  const suffix = randomUUID().slice(0, 8);
  const a = `ida${suffix}`, b = `idb${suffix}`;
  const password = 'test-only-pass-123';
  const config = {
    dataDir: dir, port: 0, runtimeMode: 'mock', devAuth: false, authMode: 'local',
    bootstrapUser: '', bootstrapPassword: '', stateStore: 'postgres', requireSharedStateStore: true,
    databaseUrl: testDatabaseUrl, modelGatewaySigningSecret: 'test-only-secret-0123456789abcdef01234567',
    operatorMetricsToken: 'test-only-metrics-token', operatorUsers: [a, b], geoEnabled: true, geoAudience: 'operators',
  };
  let app = createWebApiApp(config);
  try {
    await app.store.createUser(a, password, a);
    await app.store.createUser(b, password, b);
    let port = (await app.listen(0, '127.0.0.1')).port;
    const login = async (id) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: id, password }),
      });
      assert.equal(response.status, 200);
      const value = await response.json();
      return { 'content-type': 'application/json', cookie: String(response.headers.get('set-cookie')).split(';')[0], 'x-open-science-csrf': value.data.csrfToken };
    };
    let ha = await login(a), hb = await login(b);
    const call = async (headers, method, url, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers, signal: AbortSignal.timeout(8000), ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const key = randomUUID(), input = { requestKey: key, brandName: 'Idempotency test' };
    const lost = Promise.withResolvers();
    const dropResponse = (req, res) => {
      if (req.headers['x-test-drop-response'] !== 'true') return;
      res.end = () => {
        lost.resolve(res.statusCode);
        res.destroy();
        return res;
      };
    };
    app.server.prependListener('request', dropResponse);
    try {
      await assert.rejects(call({ ...ha, 'x-test-drop-response': 'true' }, 'POST', '/api/geo/projects', input), /fetch failed/);
    } finally { app.server.off('request', dropResponse); }
    assert.equal(await lost.promise, 201);
    const committed = await app.store.database.query('SELECT geo_id FROM evimed_geo.project_create_receipts WHERE user_id=$1 AND request_key=$2', [a, key]);
    assert.equal(committed.rowCount, 1);
    const results=await Promise.all(Array.from({length:4},()=>call(ha,'POST','/api/geo/projects',input)));
    assert.deepEqual(results.map(x=>x.status),[201,201,201,201]);
    assert.equal(new Set(results.map(x=>x.body.data.id)).size,1);
    const first=results[0].body.data;
    assert.equal(first.id, committed.rows[0].geo_id);
    const securityLog = path.join(dir, '.openscience', 'security.jsonl');
    const events = (await readFile(securityLog, 'utf8')).trim().split('\n').map(JSON.parse);
    const statuses = events.filter(event => event.action === 'geo.project.create' && event.code === first.id).map(event => event.status);
    assert.deepEqual(statuses.sort(), ['completed', 'replayed', 'replayed', 'replayed', 'replayed']);
    assert.equal((await call(ha,'POST','/api/geo/projects',{...input,brandName:'Different'})).status,409);
    const freshInput = { ...input, requestKey: randomUUID() };
    const simultaneous = await Promise.all(Array.from({length:4}, () => call(ha,'POST','/api/geo/projects',freshInput)));
    assert.deepEqual(simultaneous.map(result => result.status), [201,201,201,201]);
    assert.equal(new Set(simultaneous.map(result => result.body.data.id)).size, 1);
    assert.notEqual(simultaneous[0].body.data.id, first.id, 'A different key is a distinct operation');
    const createdRows = await app.store.database.query("SELECT id FROM evimed_geo.projects WHERE user_id=$1 AND product->>'brandName'=$2", [a,input.brandName]);
    assert.deepEqual(new Set(createdRows.rows.map(row => row.id)), new Set([first.id, simultaneous[0].body.data.id]));
    const other=await call(hb,'POST','/api/geo/projects',input); assert.equal(other.status,201); assert.notEqual(other.body.data.id,first.id);
    const old=await call(ha,'POST','/api/geo/projects',{}); assert.equal(old.status,201);
    const raceKey = randomUUID(), raceInput = { requestKey: raceKey, brandName: 'Delete concurrency probe' };
    const raceProject = (await call(ha,'POST','/api/geo/projects',raceInput)).body.data;
    const deleteLocked = Promise.withResolvers();
    const resumeDelete = Promise.withResolvers();
    const originalDeleteProject = app.store.deleteProject.bind(app.store);
    const deleteProject = t.mock.method(app.store, 'deleteProject', (user, projectId, { beforeDelete }) =>
      originalDeleteProject(user, projectId, { beforeDelete: async (client) => {
        await beforeDelete(client);
        await client.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2 FOR UPDATE', [user.id, projectId]);
        deleteLocked.resolve();
        await resumeDelete.promise;
      }}));
    const deleting = call(ha,'DELETE',`/api/projects/${raceProject.projectId}`,{confirm:raceProject.projectId});
    try {
      await deleteLocked.promise;
      const during = await call(ha,'POST','/api/geo/projects',raceInput);
      assert.equal(during.status, 201);
      assert.deepEqual(during.body.data, raceProject);
    } finally { resumeDelete.resolve(); }
    assert.equal((await deleting).status, 200);
    deleteProject.mock.restore();
    assert.equal((await call(ha,'POST','/api/geo/projects',raceInput)).status,410);

    const oldGeneration = (await call(hb,'GET','/api/me')).body.data.user.accountGeneration;
    assert.match(oldGeneration, /^[a-f0-9]{64}$/);
    const csrfOriginal = app.store.assertCsrf.bind(app.store);
    const authenticated = Promise.withResolvers();
    const resumeOld = Promise.withResolvers();
    let paused = 0;
    const assertCsrf = t.mock.method(app.store, 'assertCsrf', async (req, pathname) => {
      await csrfOriginal(req, pathname);
      if (req.headers['x-test-pause'] !== 'authenticated-create' || pathname !== '/api/geo/projects') return;
      if (++paused === 2) authenticated.resolve();
      await resumeOld.promise;
    });
    const oldHeaders = {...hb, 'x-test-pause': 'authenticated-create'};
    const delayed = Promise.all([
      call(oldHeaders,'POST','/api/geo/projects',input),
      call(oldHeaders,'POST','/api/geo/projects',{}),
    ]);
    try {
      await authenticated.promise;
      assert.equal((await call(hb,'DELETE','/api/account',{confirm:b,password})).status,200);
      const goneReceipt = await app.store.database.query('SELECT 1 FROM evimed_geo.project_create_receipts WHERE user_id=$1',[b]);
      assert.equal(goneReceipt.rowCount,0);
      await app.store.createUser(b,password,b);
      hb=await login(b);
      assert.notEqual((await call(hb,'GET','/api/me')).body.data.user.accountGeneration, oldGeneration);
      assert.equal((await call(hb,'POST','/api/geo/projects',{...input,accountGeneration:oldGeneration})).status,409);
    } finally { resumeOld.resolve(); }
    assert.deepEqual((await delayed).map(result => result.status),[401,401]);
    assertCsrf.mock.restore();
    const recreated = await call(hb,'POST','/api/geo/projects',input);
    assert.equal(recreated.status,201);
    assert.notEqual(recreated.body.data.id,other.body.data.id);

    const tables = await app.store.database.query("SELECT tablename FROM pg_tables WHERE schemaname='evimed_geo'");
    assert.deepEqual(tables.rows.map(row => row.tablename).sort(), [...GEO_TABLES].sort());
    const glossary = new FrontierGlossaryStore({ database: app.store.database });
    const vocabulary = app.geo.store.entityVocabulary;
    try {
      app.geo.store.entityVocabulary = { tag: async () => {
        // The missing Frontier schema raises a real PostgreSQL error, which the glossary deliberately absorbs.
        await glossary.current();
        return null;
      }};
      const result = await call(ha,'POST','/api/geo/projects',{requestKey:randomUUID(),brandName:'Glossary boundary probe'});
      assert.equal(glossary.lastError, '42P01');
      assert.equal(result.status, 201);
    } finally { app.geo.store.entityVocabulary = vocabulary; }

    const singleConnection = new ControlPlaneDatabase({ databaseUrl: testDatabaseUrl, databasePoolMax: 1, databaseConnectionTimeoutMs: 2000 });
    try {
      const solo = new GeoStore({ database: singleConnection, entityVocabulary: { tag: async () => {
        const result = await singleConnection.query("SELECT 'test:brand' AS key");
        return [result.rows[0].key];
      }} });
      const standalone = await solo.createProject({ userId: a, projectId: 'standalone-lookup', engines: ['kimi'], coverageDays: 90 });
      assert.equal((await singleConnection.query('SELECT entity_keys FROM evimed_geo.projects WHERE id=$1', [standalone.id])).rows[0].entity_keys[0], 'test:brand');
    } finally { await singleConnection.close(); }

    const user = await app.store.userById(a);
    const projectDirectory = path.join(user.rootDir, 'projects');
    const directoriesBefore = new Set(await readdir(projectDirectory));
    const failingKey = randomUUID();
    const before = await app.store.database.query("SELECT count(*)::int AS n FROM evimed_control.projects WHERE user_id=$1",[a]);
    await app.store.database.query(`CREATE OR REPLACE FUNCTION evimed_geo.test_create_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product->>'brandName' IN ('Fail boundary probe', 'Legacy name retry') THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await app.store.database.query("CREATE TRIGGER test_create_failure BEFORE INSERT ON evimed_geo.projects FOR EACH ROW EXECUTE FUNCTION evimed_geo.test_create_failure()");
    let residual;
    try {
      const failed = await call(ha,'POST','/api/geo/projects',{ requestKey:failingKey, brandName:'Fail boundary probe' });
      assert.equal(failed.status,500);
      const after = await app.store.database.query("SELECT count(*)::int AS n FROM evimed_control.projects WHERE user_id=$1",[a]);
      assert.equal(after.rows[0].n,before.rows[0].n);
      const receipt = await app.store.database.query("SELECT 1 FROM evimed_geo.project_create_receipts WHERE user_id=$1 AND request_key=$2",[a,failingKey]);
      assert.equal(receipt.rowCount,0);
      residual = (await readdir(projectDirectory)).filter(entry => !directoriesBefore.has(entry));
      assert.equal(residual.length, 1);
      const audit = await readFile(path.join(dir, '.openscience', 'security.jsonl'), 'utf8');
      assert.ok(audit.trim().split('\n').map(JSON.parse).some(event => event.status === 'filesystem_reservation_retained' && event.detail === residual[0]));
      const legacyFailure = await call(ha, 'POST', '/api/geo/projects', { brandName: 'Legacy name retry' });
      assert.equal(legacyFailure.status, 500);
      assert.ok((await readdir(projectDirectory)).includes('legacy-name-retry'));
      t.diagnostic(`Rollback left ${residual.length} test project directory; no automatic cleanup was attempted`);
    } finally {
      await app.store.database.query("DROP TRIGGER test_create_failure ON evimed_geo.projects");
      await app.store.database.query("DROP FUNCTION evimed_geo.test_create_failure()");
    }
    const recovered = await call(ha,'POST','/api/geo/projects',{ requestKey:failingKey, brandName:'Fail boundary probe' });
    assert.equal(recovered.status,201);
    assert.notEqual(recovered.body.data.projectId, residual[0]);
    assert.ok((await readdir(projectDirectory)).includes(residual[0]));
    const legacyRecovery = await call(ha, 'POST', '/api/geo/projects', { brandName: 'Legacy name retry' });
    assert.equal(legacyRecovery.status, 201);
    assert.equal(legacyRecovery.body.data.projectId, 'legacy-name-retry-2');
    assert.ok((await readdir(projectDirectory)).includes('legacy-name-retry'));
    const receiptFailureKey = randomUUID();
    const controlBeforeReceipt = await app.store.database.query('SELECT count(*)::int AS n FROM evimed_control.projects WHERE user_id=$1',[a]);
    const geoBeforeReceipt = await app.store.database.query('SELECT count(*)::int AS n FROM evimed_geo.projects WHERE user_id=$1',[a]);
    await app.store.database.query(`CREATE OR REPLACE FUNCTION evimed_geo.test_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_key = '${receiptFailureKey}' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$`);
    await app.store.database.query('CREATE TRIGGER test_receipt_failure BEFORE INSERT ON evimed_geo.project_create_receipts FOR EACH ROW EXECUTE FUNCTION evimed_geo.test_receipt_failure()');
    try {
      assert.equal((await call(ha,'POST','/api/geo/projects',{requestKey:receiptFailureKey,brandName:'Receipt boundary probe'})).status,500);
      assert.equal((await app.store.database.query('SELECT count(*)::int AS n FROM evimed_control.projects WHERE user_id=$1',[a])).rows[0].n,controlBeforeReceipt.rows[0].n);
      assert.equal((await app.store.database.query('SELECT count(*)::int AS n FROM evimed_geo.projects WHERE user_id=$1',[a])).rows[0].n,geoBeforeReceipt.rows[0].n);
    } finally {
      await app.store.database.query('DROP TRIGGER test_receipt_failure ON evimed_geo.project_create_receipts');
      await app.store.database.query('DROP FUNCTION evimed_geo.test_receipt_failure()');
    }
    assert.equal((await call(ha,'POST','/api/geo/projects',{requestKey:receiptFailureKey,brandName:'Receipt boundary probe'})).status,201);

    await app.close(); app=createWebApiApp(config); port=(await app.listen(0,'127.0.0.1')).port; ha=await login(a);
    const replay=await call(ha,'POST','/api/geo/projects',input); assert.equal(replay.status,201); assert.equal(replay.body.data.id,first.id);
    assert.equal((await call(ha,'DELETE',`/api/geo/projects/${first.id}`)).status,200);
    assert.equal((await call(ha,'POST','/api/geo/projects',input)).status,410);
  } finally { await app.close(); await rm(dir,{recursive:true,force:true}); await isolated.drop(); }
});
