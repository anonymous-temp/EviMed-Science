import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, extensionProofAdapterRevision } from '@evimed/domain';
import { extensionToolArtifactDigest } from '../src/extensionToolController.mjs';
import { loadExtensionDeployment, currentExtensionSourcePolicy, deploymentGenerationIdentities, deploymentProofIdentity } from '../src/extensionDeployment.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
function fixtureManifest() {
  const policy = {
      ...currentExtensionSourcePolicy()
    },
    coordinate = {
      kind: 'github',
      repository: 'Jesse-njx/dsh-cowork',
      commit: '2ae5cf755c4294a1e988eebf3b12dd062425d84c'
    },
    integrity = 'sha256:' + 'a'.repeat(64),
    id = 'cowork-portable';
  const descriptor = {
    id,
    coordinate,
    integrity,
    imageId: 'sha256:' + 'b'.repeat(64),
    closureExpectedSHA: 'c'.repeat(64),
    runnerSHA: 'd'.repeat(64),
    policySHA: 'e'.repeat(64),
    inventorySHA: 'f'.repeat(64)
  };
  descriptor.adapterDigest = 'sha256:' + sha(canonicalJson({
    runnerSHA: descriptor.runnerSHA,
    policySHA: descriptor.policySHA,
    inventorySHA: descriptor.inventorySHA
  }));
  descriptor.artifactDigest = extensionToolArtifactDigest(descriptor);
  return {
    schemaVersion: 1,
    dshVersion: '0.1.7-rc.2',
    generatedAt: '2026-10-02T00:00:00.000Z',
    policy,
    catalogue: [{
      id,
      title: 'Fixture documents',
      coordinate,
      executionClass: 'isolated-tool',
      integrity,
      settingsSchema: {}
    }],
    admittedDescriptors: [descriptor],
    admittedArtifacts: [{
      id,
      coordinate,
      integrity,
      artifactDigest: descriptor.artifactDigest,
      adapterRevision: descriptor.adapterDigest,
      suiteRevision: 'sha256:' + '1'.repeat(64)
    }],
    surfaces: [{
      id,
      client: false,
      browser: false,
      externalActions: false,
      descriptorDigest: 'sha256:' + '2'.repeat(64)
    }]
  };
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-deployment-'))),
    parent = path.join(root, '.openscience'),
    file = path.join(parent, 'extensions-deployment.json');
  await fs.mkdir(parent, {
    mode: 0o700
  });
  return {
    root,
    file,
    close: () => fs.rm(root, {
      recursive: true,
      force: true
    }),
    write: async data => {
      await fs.unlink(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fs.writeFile(file, JSON.stringify(data), {
        mode: 0o400
      });
    }
  };
}
test('missing or corrupt protected deployment is unavailable without a default artifact or image', async () => {
  const f = await fixture();
  try {
    const empty = loadExtensionDeployment({
      dataDir: f.root
    });
    assert.equal(empty.status, 'unconfigured');
    assert.deepEqual(empty.admittedDescriptors, []);
    await fs.writeFile(f.file, 'not json', {
      mode: 0o400
    });
    const invalid = loadExtensionDeployment({
      dataDir: f.root
    });
    assert.equal(invalid.status, 'unavailable');
    assert.equal(invalid.catalogue.length, 0);
    assert(!JSON.stringify(invalid).includes('not json'));
  } finally {
    await f.close();
  }
});
test('valid fixed deployment binds immutable catalogue and artifact identities to actual source policy', async () => {
  const f = await fixture();
  try {
    const manifest = fixtureManifest();
    await f.write(manifest);
    const loaded = loadExtensionDeployment({
      dataDir: f.root
    });
    assert.equal(loaded.status, 'configured');
    assert.equal(loaded.policyState, 'current');
    assert.deepEqual(loaded.recordedPolicy, manifest.policy);
    assert.equal(loaded.sourceDigest, sha(await fs.readFile(f.file)));
    assert.equal(loaded.qualificationRoot, path.join(f.root, '.openscience', 'extension-qualification'));
    assert.equal(loaded.surfaces.get('cowork-portable').browser, false);
    assert.throws(() => loaded.admittedDescriptors.push({}));
    assert.throws(() => loaded.surfaces.set('forged', {}));
    const image = 'sha256:' + '9'.repeat(64),
      identity = deploymentGenerationIdentities(loaded, image);
    assert.equal(identity.baseRuntimeImageDigest, image);
    assert.notEqual(identity.legacyCitationArtifactDigest, deploymentGenerationIdentities(loaded, 'sha256:' + '8'.repeat(64)).legacyCitationArtifactDigest);
    const proof = deploymentProofIdentity(loaded, loaded.catalogue[0], image);
    assert.equal(proof.packageIntegrity, manifest.catalogue[0].integrity);
    assert.equal(proof.runtimeImageDigest, image);
    assert.equal(proof.dshVersion, '0.1.7-rc.2');
    assert.equal(proof.adapterRevision,extensionProofAdapterRevision(manifest.admittedArtifacts[0].adapterRevision,identity.adapterRevision,sha));
    assert.notEqual(proof.adapterRevision,extensionProofAdapterRevision(manifest.admittedArtifacts[0].adapterRevision,'sha256:'+'0'.repeat(64),sha));
    assert.notEqual(proof.adapterRevision,manifest.admittedArtifacts[0].adapterRevision);
    assert.equal(Object.hasOwn(loaded, 'qualified'), false);
  } finally {
    await f.close();
  }
});
test('descriptor drift, malformed policy, duplicate entries, authority fields and broad file modes refuse the whole extension manifest', async () => {
  const f = await fixture();
  try {
    for (const change of [m => m.admittedArtifacts[0].artifactDigest = 'sha256:' + '0'.repeat(64), m => m.policy.permissionProfileRevision = 'not-a-digest', m => delete m.policy.adapterRevision, m => m.catalogue.push({
      ...m.catalogue[0]
    }), m => m.catalogue.push({...m.catalogue[0],id:'alias-pin'}), m => m.catalogue[0].qualified = true, m => m.admittedDescriptors[0].env = {
      secret: 'must-not-load'
    }, m => m.surfaces[0].client = 'unknown', m => m.dshVersion = '0.2.0']) {
      const m = fixtureManifest();
      change(m);
      await f.write(m);
      assert.equal(loadExtensionDeployment({
        dataDir: f.root
      }).status, 'unavailable');
    }
    await f.write(fixtureManifest());
    await fs.chmod(f.file, 0o666);
    assert.equal(loadExtensionDeployment({
      dataDir: f.root
    }).status, 'unavailable');
  } finally {
    await f.close();
  }
});
test('symlinks, extra fixed-file bytes and mutable parent directories cannot supply deployment authority', async () => {
  const f = await fixture();
  try {
    await f.write(fixtureManifest());
    const other = path.join(f.root, 'other.json');
    await fs.rename(f.file, other);
    await fs.symlink(other, f.file);
    assert.equal(loadExtensionDeployment({
      dataDir: f.root
    }).status, 'unavailable');
    await fs.unlink(f.file);
    await fs.writeFile(f.file, Buffer.alloc(512 * 1024 + 1), {
      mode: 0o400
    });
    assert.equal(loadExtensionDeployment({
      dataDir: f.root
    }).status, 'unavailable');
    await f.write(fixtureManifest());
    await fs.chmod(path.dirname(f.file), 0o777);
    assert.equal(loadExtensionDeployment({
      dataDir: f.root
    }).status, 'unavailable');
  } finally {
    await f.close();
  }
});


test('native HTML asset routing changes invalidate the permission profile identity',t=>{
  const before=currentExtensionSourcePolicy(),read=syncFs.readFileSync;
  t.mock.method(syncFs,'readFileSync',(file,...args)=>{
    const bytes=read(file,...args);
    return String(file).endsWith('/apps/server/src/runtimeUiDocument.mjs')?Buffer.concat([bytes,Buffer.from('\n// controlled routing revision\n')]):bytes;
  });
  const after=currentExtensionSourcePolicy();
  assert.notEqual(after.permissionProfileRevision,before.permissionProfileRevision);
});

test('a deployment written under other source is usable and labelled stale, never unavailable', async () => {
  // Owner ruling 2026-10-04. The policy digest covers ~90 source files (server.mjs and config.mjs among them), so a
  // file written for one release was refused by the next: the catalogue went empty, selections stopped reconciling and
  // the tool gateway answered 503. The digests, bonds and allow-list still refuse a bad file; the policy only labels.
  const f = await fixture();
  try {
    const manifest = fixtureManifest();
    manifest.policy = { adapterRevision: 'sha256:' + '3'.repeat(64), permissionProfileRevision: 'sha256:' + '4'.repeat(64) };
    await f.write(manifest);
    const loaded = loadExtensionDeployment({ dataDir: f.root });
    assert.equal(loaded.status, 'configured');
    assert.equal(loaded.errorCode, null);
    assert.equal(loaded.policyState, 'stale');
    assert.deepEqual(loaded.recordedPolicy, manifest.policy, 'the file keeps saying which source it was written under');
    assert.deepEqual(loaded.policy, currentExtensionSourcePolicy(), 'and the deployed source is reported beside it');
    assert.equal(loaded.catalogue.length, 1, 'the catalogue is the file\'s, whole');
    assert.equal(loaded.admittedDescriptors.length, 1);
    assert.equal(loaded.admittedArtifacts.length, 1);
    // A generation can still be built, from the code that is deployed now.
    const image = 'sha256:' + '9'.repeat(64), identity = deploymentGenerationIdentities(loaded, image);
    assert.equal(identity.baseRuntimeImageDigest, image);
    assert.deepEqual({ adapterRevision: identity.adapterRevision, permissionProfileRevision: identity.permissionProfileRevision }, currentExtensionSourcePolicy());
    assert.equal(deploymentProofIdentity(loaded, loaded.catalogue[0], image).runtimeImageDigest, image);
    // What still refuses: a file that is not a deployment, whatever its policy says.
    for (const change of [m => m.admittedArtifacts[0].artifactDigest = 'sha256:' + '0'.repeat(64), m => m.dshVersion = '0.2.0']) {
      const broken = fixtureManifest();
      broken.policy = manifest.policy;
      change(broken);
      await f.write(broken);
      assert.equal(loadExtensionDeployment({ dataDir: f.root }).status, 'unavailable');
    }
    // And no file at all is still nothing configured: there is no allow-list to admit anything from.
    await fs.unlink(f.file);
    const missing = loadExtensionDeployment({ dataDir: f.root });
    assert.equal(missing.status, 'unconfigured');
    assert.equal(missing.policyState, null);
    assert.deepEqual(missing.catalogue, []);
    assert.throws(() => deploymentGenerationIdentities(missing, image), { code: 'product_state_unavailable' });
  } finally {
    await f.close();
  }
});

test('changes to the owner-only project and real study role boundaries re-label the deployment, they do not take it away', async t => {
  const f = await fixture();
  try {
    await f.write(fixtureManifest());
    const loaded = loadExtensionDeployment({ dataDir: f.root });
    assert.equal(loaded.status, 'configured');
    assert.equal(loaded.policyState, 'current');
    const before = currentExtensionSourcePolicy();
    const read = syncFs.readFileSync;
    let changed = '';
    t.mock.method(syncFs, 'readFileSync', (file, ...args) => {
      const bytes = read(file, ...args);
      return changed && String(file).endsWith(`/${changed}`)
        ? Buffer.concat([bytes, Buffer.from('\n// controlled authorization revision\n')]) : bytes;
    });
    for (const source of ['apps/server/src/store.mjs', 'apps/server/src/sourceRoutes.mjs',
      'apps/server/src/extensionConnections.mjs', 'apps/server/src/connectorCredentials.mjs',
      'apps/server/src/vcrRoutes.mjs', 'apps/server/src/vcrStoreBase.mjs', 'apps/server/src/vcrStore.mjs',
      'apps/server/src/vcrMembers.mjs', 'apps/server/src/vcrAccess.mjs', 'packages/domain/src/vcrVocabulary.mjs']) {
      changed = source;
      // The digest still sees the change, which is what makes the label true.
      assert.notEqual(currentExtensionSourcePolicy().permissionProfileRevision, before.permissionProfileRevision, source);
      const reloaded = loadExtensionDeployment({ dataDir: f.root });
      assert.equal(reloaded.status, 'configured', source);
      assert.equal(reloaded.policyState, 'stale', source);
      assert.deepEqual(reloaded.recordedPolicy, before, source);
      assert.equal(reloaded.catalogue.length, 1, source);
      const identity = deploymentGenerationIdentities(loaded, 'sha256:' + '9'.repeat(64));
      assert.equal(identity.permissionProfileRevision, currentExtensionSourcePolicy().permissionProfileRevision, source);
      assert.notEqual(identity.permissionProfileRevision, before.permissionProfileRevision, source);
    }
    changed = '';
    assert.equal(currentExtensionSourcePolicy().permissionProfileRevision, before.permissionProfileRevision);
    assert.equal(loadExtensionDeployment({ dataDir: f.root }).policyState, 'current');
  } finally { await f.close(); }
});
