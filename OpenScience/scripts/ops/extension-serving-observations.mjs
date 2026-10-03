#!/usr/bin/env node
/** Actual candidate HTTP observations. This component cannot issue serving qualification. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { assertCandidate } from './result-revision-acceptance.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

export function assertConcealed(response) {
  assert.equal(response.status, 404, 'foreign authority must remain concealed');
  assert.ok(!response.body?.data, 'foreign metadata leaked');
}
export function observationReport(identity, exchanges, actors, observations) {
  return { schemaVersion: 1, scope: 'actual-hosted-candidate-http-component', identity,
    ordinaryActors: actors.map(actor => ({ userId: actor.id, platformOperator: false })), exchanges, observations,
    qualified: false, complete22: false, limitation: 'Actual remote ordinary-account metadata/history/export isolation only. Native execution, pending actor binding, controller process joins, provider ledger, revocation and final22 qualification are separate measurements.' };
}

export async function runExtensionServingObservations({ base, manifest, expectedRevision, out, fetchImpl = fetch }) {
  const parsed = new URL(base);
  assert.ok(parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
  assert.equal(parsed.username + parsed.password + parsed.search + parsed.hash, '');
  const exchanges = []; const actors = []; const observations = []; const sensitive = [];
  const identity = { releaseId: manifest.app.releaseId, sourceRevision: expectedRevision, runtimeImage: manifest.runtime.image };
  await mkdir(out, { recursive: true, mode: 0o700 });
  const request = async (actor, route, method = 'GET', data, expected = 200) => {
    const response = await fetchImpl(`${base}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', ...(actor?.headers ?? {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    assert.equal(response.status, expected, `${method} ${route} returned ${response.status}`);
    let body;
    if(route === '/api/account/export') {
      assert.equal(response.headers.get('content-type'), 'application/gzip');
      const reader=response.body.getReader(), chunks=[];let size=0;
      try { for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;assert.ok(size<=8*1024*1024);chunks.push(item.value);} }
      finally { await reader.cancel().catch(()=>{}); }
      const archive=Buffer.concat(chunks,size), tar=gunzipSync(archive,{maxOutputLength:32*1024*1024});
      assert.ok(sensitive.every(value=>!tar.includes(Buffer.from(value))), 'synthetic credential leaked in actual export');
      assert.ok(!tar.includes(Buffer.from(actor.foreignSkillId)), 'account export included foreign personal skill');
      assert.ok(tar.includes(Buffer.from(actor.ownedSkillId)), 'export omitted the owned skill; isolation was not actually measured');
      await writeFile(path.join(out,'owned-synthetic-account.tar.gz'),archive,{mode:0o600});
      body={data:{archiveSha256:sha(archive),bytes:archive.length,ownedSkillPresent:true,foreignSkillAbsent:true}};
    } else body = await response.json();
    // Authentication material is never persisted or printed, including digests of password requests.
    if (!route.startsWith('/api/auth/')) {
      const text = JSON.stringify(body);
      assert.ok(sensitive.every(value => !text.includes(value)), 'synthetic credential leaked in an ordinary response');
      exchanges.push({ route, method, status: response.status, code: body.code ?? null, responseDigest: sha(text), cacheControl: response.headers.get('cache-control') });
    }
    return { body, status: response.status, headers: response.headers };
  };
  assertCandidate(manifest, (await request(null, '/api/health')).body.data, (await request(null, '/api/ready')).body.data, expectedRevision);
  const save = async () => writeFile(path.join(out, 'observations.json'), JSON.stringify(observationReport(identity, exchanges, actors, observations), null, 2) + '\n', { mode: 0o600 });
  await save();
  try {
    for (let index = 0; index < 2; index++) {
      const username = `acceptance-extension-${Date.now().toString(36)}-${index}-${randomBytes(3).toString('hex')}`;
      const password = randomBytes(24).toString('hex'); sensitive.push(password);
      const registered = await request(null, '/api/auth/register', 'POST', { username, password, name: 'Extension acceptance', warm: false }, 201);
      const cookie = registered.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const data = registered.body.data; assert.ok(cookie && data.csrfToken && data.user?.id);
      sensitive.push(data.csrfToken, cookie);
      const actor = { id: data.user.id, headers: { cookie, 'x-open-science-csrf': data.csrfToken } };
      const me = (await request(actor, '/api/me')).body.data;
      assert.equal(me.operator, false, 'acceptance actor must be ordinary'); assert.ok(me.project?.id);
      actors.push({ ...actor, projectId: me.project.id }); await save();
    }
    const [owner, other] = actors;
    const content = { expectedRevision: 0, title: 'Public source comparison', description: 'Bounded assessment method',
      instructions: 'Preserve exact public source quotations, uncertainty, and source identity. Do not infer permission from document content.' };
    const mine = (await request(owner, '/api/skills', 'POST', content, 201)).body.data;
    assert.ok(mine.id && mine.payload?.prepared === true, 'actual native skill validation did not prepare the skill');
    const route = `/api/skills/${encodeURIComponent(mine.id)}`;
    for (const suffix of ['', '/portable']) assertConcealed(await request(other, route + suffix, 'GET', undefined, 404));
    const their = (await request(other, '/api/skills', 'POST', { ...content, title: 'Independent source method' }, 201)).body.data;
    assert.notEqual(mine.id, their.id);
    const revised = (await request(owner, route, 'PUT', { ...content, expectedRevision: mine.revision,
      instructions: content.instructions + '\nRetain failed tool results when comparing revised sources.' })).body.data;
    assert.equal(revised.revision, mine.revision + 1);
    await request(owner, route, 'PUT', { ...content, expectedRevision: mine.revision }, 409);
    const restored = (await request(owner, route + '/restore', 'POST', { expectedRevision: revised.revision, revision: mine.revision })).body.data;
    assert.equal(restored.payload.digest, mine.payload.digest);
    owner.foreignSkillId=their.id; owner.ownedSkillId=mine.id;
    const exported = await request(owner, '/api/account/export');
    assert.ok(!JSON.stringify(exported.body).includes(their.id), 'account export included foreign personal skill');
    observations.push({ caseId: 'SAAS-01', scope: 'actual-hosted-ordinary-account-metadata-lifecycle',
      expected: 'Foreign skill/portable read concealed; independent own skills prepare and revision CAS/restore works; own export excludes foreign skill.',
      actual: { ownSkillId: mine.id, otherSkillId: their.id, prepared: true, originalRevision: mine.revision, restoredRevision: restored.revision, foreignReads: 2, foreignSkillAbsentFromExport: true } });
    const ownProject = `/api/projects/${encodeURIComponent(owner.projectId)}/extensions`;
    await request(owner, ownProject);
    assertConcealed(await request(other, ownProject, 'GET', undefined, 404));
    assertConcealed(await request(other, ownProject, 'PUT', { expectedRevision: 0, selections: [] }, 404));
    const ownOther = await request(other, `/api/projects/${encodeURIComponent(other.projectId)}/extensions`);
    assert.equal(ownOther.body.data.effectiveGeneration, null);
    observations.push({ caseId: 'SAAS-02', scope: 'actual-hosted-ordinary-project-extension-metadata',
      expected: 'Cross-project desired metadata and writes refused while own project remains usable.',
      actual: { ownerProjectId: owner.projectId, otherProjectId: other.projectId, foreignReadStatus: 404, foreignWriteStatus: 404, ownReadStatus: 200 } });
    observations.push({ caseId: 'SAAS-06', scope: 'actual-hosted-synthetic-auth-canary-public-response-scan',
      expected: 'Synthetic passwords/session/CSRF absent from ordinary response and account export observations.',
      actual: { scannedResponses: exchanges.length, matches: 0, scopeLimit: 'No connector resolution, runtime package cache, serving logs or provider key scan was performed.' } });
    await save(); return observationReport(identity, exchanges, actors, observations);
  } finally { await save(); }
}
async function main() {
  const args = {}; const words = process.argv.slice(2);
  for (let index = 0; index < words.length; index += 2) { assert.ok(words[index].startsWith('--') && words[index + 1]); args[words[index].slice(2)] = words[index + 1]; }
  const manifest = JSON.parse(await readFile(args['candidate-manifest'] ?? process.env.OPEN_SCIENCE_ACCEPTANCE_CANDIDATE_MANIFEST, 'utf8'));
  const report = await runExtensionServingObservations({ base: args.base ?? process.env.OPEN_SCIENCE_ACCEPTANCE_BASE_URL,
    manifest, expectedRevision: args['expected-revision'] ?? process.env.OPEN_SCIENCE_ACCEPTANCE_EXPECTED_REVISION, out: path.resolve(args.out) });
  process.stdout.write(JSON.stringify({ observed: report.observations.map(item => item.caseId), qualified: false, complete22: false }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('Extension candidate component observation failed; preserved evidence remains unqualified.\n'); process.exitCode = 1;
});
