import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebApiApp } from '../src/server.mjs';
import { currentExtensionSourcePolicy } from '../src/extensionDeployment.mjs';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { parsePersonalSkill } from '@evimed/harness-port/personal-skills';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

test('authenticated skill REST invocation binds the exact native input to the real PostgreSQL extension actor resolver',
  { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
    const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'skillactor');
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'personal-skill-actor-')));
    let app, manager, nativeRequest;
    try {
      await fs.mkdir(path.join(directory, '.openscience'), { mode: 0o700 });
      await fs.writeFile(path.join(directory, '.openscience', 'extensions-deployment.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), dshVersion: '0.1.7-rc.2', policy: currentExtensionSourcePolicy(), catalogue: [], admittedArtifacts: [], admittedDescriptors: [], surfaces: [] }), { mode: 0o400 });
      app = createWebApiApp({ dataDir: directory, stateStore: 'postgres', databaseUrl: isolated.url, databasePoolMax: 4,
        modelGatewaySigningSecret: 'fixture-only-model-gateway-signing-secret', port: 0, runtimeMode: 'kernel', devAuth: false, bootstrapUser: 'skill-actor-fixture', bootstrapPassword: 'local fixture password only',
        learningEnabled: false, reviewEnabled: false, frontierEnabled: false, geoEnabled: false, vcrEnabled: false,
        skillValidationController: { validatePersonalSkill: reference => parsePersonalSkill(path.join(directory, '.openscience', 'skill-library', reference.ownerHash, reference.kind, reference.contentId), { expectedName: reference.expectedName }) },
      }, { runtimeManagerFactory: (config, hooks) => { manager = new RuntimeManager(config, hooks); return manager; } });
      const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'skill-actor-fixture', password: 'local fixture password only' }) });
      assert.equal(login.status, 200); const session = await login.json();
      const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Open-Science-CSRF': session.data.csrfToken, 'content-type': 'application/json' };
      const request = async (route, method, body, expected = 200) => {
        const response = await fetch(base + route, { method, headers, body: JSON.stringify(body) }); const result = await response.json();
        assert.equal(response.status, expected, JSON.stringify(result)); return result.data;
      };
      const skill = await request('/api/skills', 'POST', { expectedRevision: 0, title: 'Actor fixture', description: 'Check synthetic rows', instructions: 'Preserve unknown values.' }, 201);
      await request('/api/projects/default/skills', 'PUT', { expectedRevision: 0, skills: [{ skillId: skill.id, revision: 1 }] });
      const user = await app.store.userById(session.data.user.id), project = await app.store.requireProject(user, 'default');
      const candidate = { reference: { generationHash: 'a'.repeat(64) }, pins: [{ skillId: skill.id, revision: 1, digest: skill.payload.digest }] };
      manager.runtimes.set(manager.key(project), { personalSkillGeneration: candidate, modelGatewayTokenJti: 'skill-actor-generation' });
      // Only native transport and generation discovery are controlled; REST,
      // authentication, library selection and actor admission/resolution are real.
      manager.personalSkillGenerations = { requireInvocation: async () => ({ nativeName: skill.payload.nativeName, digest: skill.payload.digest }) };
      manager.start = async () => manager.runtimes.get(manager.key(project));
      manager.probePersonalSkillGeneration = async () => ({ pendingSession: false });
      manager.assertInteractiveRuntimeAvailable = () => {};
      manager.assertPersonalSkillPromptGeneration = async () => {};
      manager.enforceProjectQuota = async () => {};
      manager.callKernel = async (_runtime, _project, method, body) => { if (method === 'session/prompt') nativeRequest = body.request; return {}; };
      await request(`/api/projects/default/skills/${skill.id}/invoke`, 'POST', { revision: 1, sessionId: 'skill-session', idempotencyKey: 'skill-input' });
      assert.deepEqual(nativeRequest, { requestId: 'skill-input', sessionId: 'skill-session', mode: 'queue', content: [{ type: 'text', text: `/${skill.payload.nativeName}` }] });
      const auth = { userId: user.id, projectId: project.id, runtimeGeneration: manager.runtimeGeneration(project) };
      const invocation = { sessionId: nativeRequest.sessionId }, message = { seq: 3, turnStartSeq: 1 };
      const transcript = { messages: [{ role: 'user', seq: 2, turnStartSeq: 1, source: 'user', sourceRequestId: nativeRequest.requestId }] };
      const resolved = await app.hostedExtensions.actors.resolve(auth, invocation, message, transcript);
      assert.ok(resolved, 'The REST-dispatched native request must have an authenticated actor binding');
      assert.equal(resolved.userId, user.id);
      assert.equal(await app.hostedExtensions.actors.resolve({ ...auth, userId: 'foreign' }, invocation, message, transcript), null);
      assert.equal(await app.hostedExtensions.actors.resolve(auth, invocation, message, { messages: [...transcript.messages, { role: 'user', seq: 3, turnStartSeq: 1, source: 'user', sourceRequestId: 'later-unbound' }] }), null);
      await request(`/api/projects/default/skills/${skill.id}/invoke`, 'POST', { revision: 1, sessionId: 'skill-session', idempotencyKey: 'forged-input', actorId: 'foreign' }, 400);
    } finally { manager?.runtimes.clear(); await app?.close(); await isolated.drop(); await fs.rm(directory, { recursive: true, force: true }); }
  });
