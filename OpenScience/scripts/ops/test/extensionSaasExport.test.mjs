import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareAcceptanceExport } from '../export-extension-acceptance-inputs.mjs';
import { createAssessmentDescriptor } from '../extension-saas-acceptance-manifest.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-extension-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publication = path.join(root, 'publication-fixture'); await fs.mkdir(publication, { mode: 0o700 });
  const closure = JSON.stringify({ contentDigest: 'sha256:' + 'b'.repeat(64), files: ['public admitted bytes'] });
  const descriptor = await createAssessmentDescriptor({ imageId: 'sha256:' + 'a'.repeat(64), integrity: 'sha256:' + 'b'.repeat(64), closureExpectedSHA: sha(closure) });
  const source = JSON.stringify({ commit: descriptor.coordinate.commit }); const lock = 'public admitted locked dependency fixture';
  const catalogue = JSON.stringify({ list: {}, body: {}, snapshot: {} });
  const pins = JSON.parse(await fs.readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8'));
  const value = { schemaVersion: 1, platform: 'linux/amd64', sourceCommit: descriptor.coordinate.commit, dshVersion: pins.dsh.version,
    images: { coworkImageId: descriptor.imageId, nativeSdkImageId: 'sha256:' + 'd'.repeat(64), nativeKernelImageId: 'sha256:' + 'd'.repeat(64) },
    artifact: Object.fromEntries(['closureExpectedSHA','integrity','runnerSHA','policySHA','inventorySHA','adapterDigest','artifactDigest'].map(key => [key, descriptor[key]])),
    fixtures: { catalogueSnapshotPath: 'fixtures/catalogue-snapshot.json', catalogueSnapshotSHA: sha(catalogue) }, qualification: 'unverified' };
  const write = async (relative, bytes) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { mode: 0o400 }); };
  await write('publication-fixture/acceptance-inputs.json', JSON.stringify(value));
  await write('publication-fixture/preparation-record.json', JSON.stringify({ lockSHA: sha(lock), sourceManifestSHA: sha(source) }));
  await write('publication-fixture/fixtures/catalogue-snapshot.json', catalogue);
  await write('cowork/context/dependency-closure.json', closure); await write('cowork/context/pnpm-lock.yaml', lock);
  const overlayLock = 'actual admitted overlay lock'; const overlayPins = '{}';
  await write('public-adapter/overlay/pnpm-lock.yaml', overlayLock); await write('public-adapter/overlay/pins.json', overlayPins);
  await write('cowork/context/overlay-attestation.json', JSON.stringify({ dependencyClosureSha256: sha(closure), dependencyClosureDigest: descriptor.integrity, sourceCommit: descriptor.coordinate.commit, admittedLockSha256: sha(overlayLock), overlayPinsSha256: sha(overlayPins) })); await write('public-adapter/source-manifest.json', source);
  await write('ignored-provider-secret', 'must never be copied');
  const calls = [];
  const options = { inputsFile: path.join(publication, 'acceptance-inputs.json'), output: path.join(root, 'export'), sourceRevision: 'f'.repeat(40), workflowRun: '123', workflowAttempt: '1',
    docker: args => { calls.push(args); return args[1] === 'inspect' ? [{ Id: args[2], Os: 'linux', Architecture: 'amd64', Size: 10, RootFS: { Layers: ['sha256:' + 'e'.repeat(64)] } }] : null; } };
  return { root, value, options, calls };
}
test('export deduplicates exact SDK/kernel IDs and preserves only the fixed protected observation closure', async t => {
  const f = await fixture(t); const result = await prepareAcceptanceExport(f.options);
  assert.equal(result.images.length, 2); assert.equal(f.calls.filter(args => args[1] === 'tag').length, 2);
  assert.deepEqual(result.roles.nativeSdkImageId, result.roles.nativeKernelImageId);
  assert.equal(result.qualified, false); assert.equal(result.qualification, 'unverified');
  assert.equal(result.files.length, 9);
  assert.equal((await fs.stat(path.join(f.options.output, 'prepared/acceptance-inputs.json'))).mode & 0o777, 0o400);
  await assert.rejects(fs.stat(path.join(f.options.output, 'ignored-provider-secret')));
});
test('changed closure is refused before exporting any image', async t => {
  const f = await fixture(t); await fs.chmod(path.join(f.root, 'cowork/context/dependency-closure.json'), 0o600); await fs.writeFile(path.join(f.root, 'cowork/context/dependency-closure.json'), '{}');
  await assert.rejects(prepareAcceptanceExport(f.options), /export_closure_changed/); assert.equal(f.calls.length, 0);
});
test('actual image drift is refused rather than tagging a guessed fixture', async t => {
  const f = await fixture(t); f.options.docker = () => [{ Id: 'sha256:' + '0'.repeat(64), Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [] } }];
  await assert.rejects(prepareAcceptanceExport(f.options), /export_image_changed/);
});
test('full release assessment export follows successful real boundaries and retains a separate unqualified artifact', async () => {
  const workflow = await fs.readFile(new URL('../../../../.github/workflows/web.yml', import.meta.url), 'utf8');
  const web = workflow.slice(workflow.indexOf('  web:'), workflow.indexOf('  vcr-seam:'));
  assert(web.indexOf('Export exact prepared extension assessment images') > web.indexOf('Test actual contained and native extension boundaries'));
  assert.match(web, /Export exact prepared extension assessment images\n\s+if:.*\[full-release\]/);
  assert.match(web, /docker save "\$\{images\[@\]\}" \| gzip -1/);
  assert.match(web, /python3 scripts\/ops\/extension-acceptance-archive.py/);
  assert.match(web, /name: evimed-extension-assessment-\$\{\{ github.sha \}\}/);
});
