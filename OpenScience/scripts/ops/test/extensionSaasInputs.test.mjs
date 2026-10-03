import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAcceptanceInputs } from '../extension-saas-acceptance-inputs.mjs';
import { createAssessmentDescriptor } from '../extension-saas-acceptance-manifest.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-saas-inputs-'))), file = path.join(root, 'acceptance-inputs.json');
  const descriptor = await createAssessmentDescriptor({ imageId: 'sha256:' + 'a'.repeat(64), integrity: 'sha256:' + 'b'.repeat(64), closureExpectedSHA: 'c'.repeat(64) });
  const pin = JSON.parse(await fs.readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8')).dsh.version;
  const value = { schemaVersion: 1, platform: 'linux/arm64', sourceCommit: descriptor.coordinate.commit, dshVersion: pin,
    images: { coworkImageId: descriptor.imageId, nativeSdkImageId: 'sha256:' + 'd'.repeat(64), nativeKernelImageId: 'sha256:' + 'e'.repeat(64) },
    artifact: Object.fromEntries(['closureExpectedSHA','integrity','runnerSHA','policySHA','inventorySHA','adapterDigest','artifactDigest'].map(key => [key, descriptor[key]])),
    fixtures: { catalogueSnapshotPath: 'fixtures/catalogue-snapshot.json', catalogueSnapshotSHA: 'f'.repeat(64) }, qualification: 'unverified' };
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o400 }); return { root, file, value };
}
test('protected inputs reuse exact image/adapter tuple without any qualified claim or ignored date path', async () => { const f = await fixture(); try { const result = await readAcceptanceInputs(f.file); assert.equal(result.images.coworkImageId, f.value.images.coworkImageId); assert.equal(result.qualification, 'unverified'); assert(Object.isFrozen(result.artifact)); assert.equal(result.recordSHA256, sha(await fs.readFile(f.file))); } finally { await fs.rm(f.root,{recursive:true,force:true}); } });
test('credentials, qualification flags, arbitrary commands/paths and adapter drift are refused', async () => { const f = await fixture(); try {
  for (const change of [v=>{v.qualified=true;},v=>{v.qualification='qualified';},v=>{v.artifact.runnerSHA='0'.repeat(64);},v=>{v.fixtures.catalogueSnapshotPath='../outside';},v=>{v.images.command='untrusted';}]) { const value=structuredClone(f.value);change(value);await fs.chmod(f.file,0o600);await fs.writeFile(f.file,JSON.stringify(value));await fs.chmod(f.file,0o400);await assert.rejects(readAcceptanceInputs(f.file)); }
} finally { await fs.rm(f.root,{recursive:true,force:true}); } });
test('links, hard links and writable records never become preparation authority', async () => { const f = await fixture(); try {
 await fs.chmod(f.file,0o666);await assert.rejects(readAcceptanceInputs(f.file));await fs.chmod(f.file,0o400);await fs.link(f.file,path.join(f.root,'hard'));await assert.rejects(readAcceptanceInputs(f.file));await fs.unlink(path.join(f.root,'hard'));await fs.rename(f.file,path.join(f.root,'original'));await fs.symlink('original',f.file);await assert.rejects(readAcceptanceInputs(f.file));
} finally {await fs.rm(f.root,{recursive:true,force:true});} });
