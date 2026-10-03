/** Actual platform guard/file observations; setup records are explicit fixture authority, never customer provenance. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExtensionResourceResolver } from '../../apps/server/src/extensionResourceResolver.mjs';
import { createFixtures, zip } from '../runtime/extensions/cowork/fixtures.mjs';
import { guardDocument, inspectZip, validateRequest, LIMITS } from '../runtime/extensions/cowork/policy.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** No arbitrary host root is opened: callers provision one new private test directory. */
export async function runDocumentBoundaryControls(root) {
  const stat = await fs.lstat(root);
  if (!path.isAbsolute(root) || root === '/' || !/^evimed-saas-(?:boundaries|root)-[A-Za-z0-9]+$/.test(path.basename(root))
    || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || await fs.realpath(root) !== root) throw new Error('unowned_boundary_root');
  const publicRoot = path.join(root, 'public'), siblingRoot = path.join(root, 'other-project');
  await fs.mkdir(siblingRoot); const canary = Buffer.from('Unrelated synthetic project must stay unchanged.');
  await fs.writeFile(path.join(siblingRoot, 'sentinel.txt'), canary);
  const files = await createFixtures(publicRoot), resources = new Map(), targets = new Map();
  let provenanceRevision = null;
  for (const [id, resource] of Object.entries(files)) resources.set(id, { ownerId: 'actor-a', projectId: 'project-a', revision: 1,
    relativePath: resource.file, format: resource.format, sha256: resource.sha256, provenanceClass: 'public' });
  resources.set('foreign_project', { ...resources.get('res_docx'), projectId: 'project-b' });
  resources.set('patient_document', { ...resources.get('res_docx'), provenanceClass: 'patient' });
  resources.set('outside_path', { ...resources.get('res_docx'), relativePath: '../other-project/sentinel.txt' });
  await fs.symlink(path.join(siblingRoot, 'sentinel.txt'), path.join(publicRoot, 'linked.pdf'));
  resources.set('linked_document', { ...resources.get('res_pdf'), relativePath: 'linked.pdf', sha256: sha(canary) });
  const resolver = new ExtensionResourceResolver({ lookupResource: async (_scope, id) => resources.get(id) ?? null,
    verifyProvenance: async (_scope, record) => ({ revision: provenanceRevision ?? record.revision, dataClass: record.provenanceClass }),
    rootFor: async () => publicRoot, lookupTarget: async (_scope, id) => targets.get(id) ?? null });
  const scope = { userId: 'actor-a', projectId: 'project-a' }, observations = [];
  const observation = (caseId, expected, actual) => observations.push({ caseId, scope: 'actual-platform-guard-and-descriptor-file-control',
    setup: 'Synthetic authoritative resource records and actors; real files/guards; no serving generation or qualification bypass', expected, actual });
  const publicSnapshot = await resolver.snapshot(scope, 'res_docx'); assert.equal(publicSnapshot.dataClass, 'public');
  assert.equal(sha(publicSnapshot.bytes), files.res_docx.sha256);
  let foreignProjectCode;
  await assert.rejects(resolver.snapshot(scope, 'foreign_project'), error => { foreignProjectCode = error.code; return error.code === 'extension_access_denied'; });
  await assert.rejects(resolver.snapshot({ ...scope, userId: 'actor-b' }, 'res_docx'), { code: 'extension_access_denied' });
  observation('SAAS-02', 'Foreign project/owner denied; allowed public bytes unchanged', { assertions: 4, foreignProjectCode, allowedDigest: 'sha256:' + sha(publicSnapshot.bytes) });
  let patientCode;
  await assert.rejects(resolver.snapshot(scope, 'patient_document'), error => { patientCode = error.code; return error.code === 'extension_access_denied'; });
  resources.get('res_docx').provenanceClass = 'patient';
  await assert.rejects(resolver.snapshot({ ...scope, dataClass: 'public' }, 'res_docx'), { code: 'extension_access_denied' });
  resources.get('res_docx').provenanceClass = 'public';
  provenanceRevision = 2;
  await assert.rejects(resolver.snapshot(scope, 'res_docx'), { code: 'extension_access_denied' });
  provenanceRevision = null;
  const originalFile = path.join(publicRoot, files.res_docx.file);
  await fs.writeFile(originalFile, Buffer.concat([publicSnapshot.bytes, Buffer.from('changed-after-preservation')]));
  await assert.rejects(resolver.snapshot(scope, 'res_docx'), { code: 'extension_access_denied' });
  await fs.writeFile(originalFile, publicSnapshot.bytes);
  assert.equal(sha((await resolver.snapshot(scope, 'res_docx')).bytes), files.res_docx.sha256);
  observation('SAAS-07', 'Patient-class records refused; caller classification cannot turn them public; provenance and preserved bytes remain bound',
    { assertions: 5, patientCode, staleProvenanceRefused: true, changedPreservedBytesRefused: true, restoredBytesReadable: true });
  await assert.rejects(resolver.snapshot(scope, 'outside_path'), { code: 'extension_access_denied' });
  await assert.rejects(resolver.snapshot(scope, 'linked_document'));
  const goodZip = zip({ 'word/document.xml': '<document>benign fixture</document>' }); inspectZip(goodZip);
  const mismatch = Buffer.from(goodZip); mismatch[30] = 120; assert.throws(() => inspectZip(mismatch));
  assert.throws(() => guardDocument(publicSnapshot.bytes, 'ipynb'));
  assert.throws(() => inspectZip(zip({ '../outside': 'benign fixture' })));
  assert.throws(() => guardDocument(Buffer.alloc(LIMITS.inputBytes + 1), 'pdf'));
  observation('SAAS-08', 'Descriptor scope, raw archive name agreement, signature and finite byte limits enforced before codecs',
    { assertions: 7, centralLocalMismatchRefused: true, linkRefused: true, renamedFormatRefused: true, oversizedInputRefused: true });
  const external = await fs.readFile(path.join(publicRoot, files.res_external.file));
  assert.throws(() => guardDocument(external, 'docx'));
  assert.throws(() => validateRequest({ operation: 'doc_read', resourceId: 'res_docx', url: 'https://example.invalid/' }));
  validateRequest({ operation: 'doc_read', resourceId: 'res_docx' });
  observation('SAAS-12', 'Raw destinations and remote document relationships rejected; fixed opaque public-resource request remains admissible',
    { assertions: 3, rawDestinationRefused: true, externalRelationshipRefused: true, networkRequests: 0 });
  const outputBytes = Buffer.from(JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  const target = { ownerId: scope.userId, projectId: scope.projectId, revision: 1, relativePath: 'exports/result.ipynb', format: 'ipynb' };
  targets.set('target_owned', target);
  const request = { targetId: 'target_owned', format: 'ipynb' };
  const output = { ok: true, data: { targetId: request.targetId, format: request.format, bytes: outputBytes.length,
    sha256: sha(outputBytes), contentBase64: outputBytes.toString('base64'), codeExecuted: false } };
  const published = await resolver.publish(scope, request, output);
  assert.equal(published.sha256, sha(outputBytes));
  assert.deepEqual(await fs.readFile(path.join(publicRoot, target.relativePath)), outputBytes);
  assert.deepEqual(await resolver.publish(scope, request, output), published);
  await assert.rejects(resolver.publish({ ...scope, userId: 'actor-b' }, request, output), { code: 'extension_access_denied' });
  targets.set('target_foreign', { ...target, projectId: 'project-b', relativePath: 'exports/foreign.ipynb' });
  await assert.rejects(resolver.publish(scope, { ...request, targetId: 'target_foreign' }, { ...output, data: { ...output.data, targetId: 'target_foreign' } }), { code: 'extension_access_denied' });
  await assert.rejects(resolver.publish(scope, request, { ...output, data: { ...output.data, codeExecuted: true } }), { code: 'extension_contract_invalid' });
  const changedBytes = Buffer.from(JSON.stringify({ cells: [], metadata: { changed: true }, nbformat: 4, nbformat_minor: 5 }));
  await assert.rejects(resolver.publish(scope, request, { ...output, data: { ...output.data, bytes: changedBytes.length,
    sha256: sha(changedBytes), contentBase64: changedBytes.toString('base64') } }), { code: 'extension_contract_invalid' });
  targets.set('target_link', { ...target, relativePath: 'linked-output/result.ipynb' });
  await fs.symlink(siblingRoot, path.join(publicRoot, 'linked-output'));
  await assert.rejects(resolver.publish(scope, { ...request, targetId: 'target_link' }, { ...output, data: { ...output.data, targetId: 'target_link' } }));
  await assert.rejects(fs.stat(path.join(siblingRoot, 'result.ipynb')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(publicRoot, 'exports/foreign.ipynb')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(publicRoot, target.relativePath)), outputBytes);
  observation('SAAS-17', 'Owned output publishes once; retries preserve bytes; foreign authority, executed code, changed result and linked output directory cannot publish',
    { assertions: 11, publishedDigest: 'sha256:' + published.sha256, targetRevision: published.targetRevision,
      identicalRetryRetained: true, foreignOwnerRefused: true, foreignProjectRefused: true, executedCodeRefused: true,
      changedResultRefused: true, linkedOutputRefused: true, unrelatedOutputAbsent: true,
      uncovered: 'Actual controller cancellation/resource exhaustion, gateway actor binding and serving workspace publication' });
  assert.deepEqual(await fs.readFile(path.join(siblingRoot, 'sentinel.txt')), canary);
  return { qualified: false, observations, unrelatedWorkspaceUnchanged: true,
    limitation: 'Controls exercise real guard/files with declared fixture provenance; do not prove actual gateway/role/receipt qualification or private-DNS egress behavior.' };
}
