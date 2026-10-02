import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { ExtensionAccess } from '../src/extensionAccess.mjs';
import { ExtensionDocumentResources } from '../src/extensionDocumentResources.mjs';

test('actual product ledger binds public documents to current account/project, refuses forged provenance and publishes ordinary artifacts',
  { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, timeout: 30000 }, async () => {
    const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'edr');
    let database;
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-public-documents-')));
    const project = { id: 'paper', userId: 'alice', baseDir: directory, maxBytes: 1024 * 1024 };
    const config = { dataDir: directory, maxProjectBytes: 1024 * 1024, modelGatewaySigningSecret: 'fixture-only-purpose-bound-document-signing-secret' };
    const store = { userById: async id => ['alice', 'bob'].includes(id) ? { id } : null,
      requireProject: async (user, id) => { if (user.id !== 'alice' || id !== 'paper') throw new Error('unowned'); return project; } };
    try {
      database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
      await database.migrate();
      await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Public document fixture','development'),('bob','Other fixture','development')");
      await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','paper','Public document',1048576)");
      const epochs = (await database.query(`SELECT u.created_at::text AS "accountCreatedAt",p.created_at::text AS "projectCreatedAt"
        FROM evimed_control.users u JOIN evimed_control.projects p ON p.user_id=u.id WHERE u.id='alice' AND p.id='paper'`)).rows[0];
      const resources = new ExtensionDocumentResources({ config, database, store, access: new ExtensionAccess({ store }),
        resolveGeneration: async principal => ({ ...epochs, userId: principal.userId, projectId: principal.projectId, runtimeGeneration: principal.jti }) });
      const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
      const principal = { userId: 'alice', projectId: 'paper', jti: 'fixture-generation' };
      const captured = await resources.prepareCapture(principal), validateCurrent = async () => principal;
      const result = await resources.capturePdf(principal, bytes, { doi: '10.1234/public', origin: 'https://public.example' }, captured, validateCurrent);
      assert.match(result.resourceId, /^pub_[a-f0-9]{64}$/);
      const record = await resources.lookup(principal, result.resourceId);
      const scope = { ...principal, accountCreatedAt: record.accountCreatedAt, projectCreatedAt: record.projectCreatedAt };
      assert.deepEqual((await resources.resolver.snapshot(scope, result.resourceId)).bytes, bytes);
      assert.deepEqual(await resources.capturePdf(principal, bytes, { doi: '10.1234/public', origin: 'https://public.example' }, captured, validateCurrent), result);
      await assert.rejects(resources.capturePdf(principal, bytes, { doi: '10.1234/public', origin: 'https://public.example' },
        { ...captured, projectCreatedAt: '2000-01-01' }, validateCurrent), { code: 'extension_access_denied' });
      await assert.rejects(resources.capturePdf(principal, bytes, { doi: '10.1234/public', origin: 'https://public.example' },
        captured, async () => ({ ...principal, jti: 'replacement' })), { code: 'extension_access_denied' });
      await assert.rejects(resources.resolver.snapshot({ ...scope, userId: 'bob' }, result.resourceId));
      await assert.rejects(resources.resolver.snapshot({ ...scope, projectId: 'other' }, result.resourceId));
      await assert.rejects(resources.provenance({ ...scope, accountCreatedAt: 'new-account' }, record), { code: 'extension_access_denied' });
      await assert.rejects(resources.provenance(scope, { ...record, dataClass: 'aggregate' }), { code: 'extension_access_denied' });
      const notebook = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }));
      const written = await resources.resolver.publish(scope, { targetId: 'public_result_ipynb', format: 'ipynb' }, { ok: true, data: {
        targetId: 'public_result_ipynb', format: 'ipynb', codeExecuted: false, bytes: notebook.length,
        contentBase64: notebook.toString('base64'), sha256: createHash('sha256').update(notebook).digest('hex') } });
      assert.equal(written.artifactPath, 'outputs/extensions/public_result_ipynb.ipynb');
      assert.deepEqual(await fs.readFile(path.join(directory, written.artifactPath)), notebook);
      await assert.rejects(resources.target(scope, '../foreign'), { code: 'extension_access_denied' });
      await database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{signature}',to_jsonb(repeat('0',64))) WHERE kind='extension-resource'");
      await assert.rejects(resources.resolver.snapshot(scope, result.resourceId), { code: 'extension_access_denied' });
    } finally { await database?.close(); await isolated.drop(); await fs.rm(directory, { recursive: true, force: true }); }
  });
