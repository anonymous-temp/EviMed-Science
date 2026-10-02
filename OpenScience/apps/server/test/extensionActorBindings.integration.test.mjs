import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { ExtensionAccess } from '../src/extensionAccess.mjs';
import { ExtensionActorBindings } from '../src/extensionActorBindings.mjs';

test('actual actor records bind accepted input/current epochs and cannot borrow an earlier or foreign caller',
  { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, timeout: 30000 }, async () => {
    const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'eab');
    let database;
    try {
      database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
      await database.migrate();
      await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Actor fixture','development'),('bob','Other fixture','development')");
      await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','p','Actor project',1048576)");
      const epoch = (await database.query("SELECT created_at::text AS epoch FROM evimed_control.users WHERE id='alice'")).rows[0].epoch;
      const user = { id: 'alice', accountCreatedAt: epoch }, project = { id: 'p', userId: 'alice' };
      const access = new ExtensionAccess({ projectAccess: async (actor, id) => actor.id === 'alice' && id === 'p' ? { project, role: 'owner' } : null });
      let generation = 'actual-fixture-generation';
      const bindings = new ExtensionActorBindings({ database, access, runtimeManager: { runtimeGeneration: () => generation }, secret: 'fixture-only-accepted-actor-signing-secret' });
      const accepted = { sessionId: 'root-session', requestId: 'input-one' };
      const first = await bindings.accept(user, project, accepted);
      assert.deepEqual(await bindings.accept(user, project, accepted), first);
      const auth = { userId: 'alice', projectId: 'p', runtimeGeneration: generation }, invocation = { sessionId: accepted.sessionId };
      const message = { seq: 4, turnStartSeq: 1 }, transcript = { messages: [{ role: 'user', seq: 2, turnStartSeq: 1, sourceRequestId: 'input-one' }] };
      assert.deepEqual(await bindings.resolve(auth, invocation, message, transcript), first);
      assert.equal(await bindings.resolve({ ...auth, userId: 'bob' }, invocation, message, transcript), null);
      transcript.messages.push({ role: 'user', seq: 3, turnStartSeq: 1, sourceRequestId: 'unbound-later-input' });
      assert.equal(await bindings.resolve(auth, invocation, message, transcript), null);
      transcript.messages.pop();
      await assert.rejects(bindings.accept({ id: 'bob', accountCreatedAt: epoch }, project, accepted), { code: 'extension_access_denied' });
      generation = 'replacement-runtime';
      assert.equal(await bindings.resolve({ ...auth, runtimeGeneration: generation }, invocation, message, transcript), null);
      generation = auth.runtimeGeneration;
      await database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{signature}',to_jsonb(repeat('0',64))) WHERE kind='extension-resource'");
      assert.equal(await bindings.resolve(auth, invocation, message, transcript), null);
      await database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id='alice'");
      await assert.rejects(bindings.accept(user, project, { ...accepted, requestId: 'old-account-input' }), { code: 'unauthorized' });
    } finally { await database?.close(); await isolated.drop(); }
  });
