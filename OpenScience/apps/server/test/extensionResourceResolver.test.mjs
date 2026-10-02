import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExtensionResourceResolver } from '../src/extensionResourceResolver.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const scope = {
  userId: 'alice',
  projectId: 'project'
};
test('trusted provenance, exact bytes and ownership, never upload flags, authorize input snapshots', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-resource-')));
  const bytes = Buffer.from('public fixture');
  await fs.writeFile(path.join(root, 'original.pdf'), bytes);
  let record = {
    ownerId: 'alice',
    projectId: 'project',
    relativePath: 'original.pdf',
    format: 'pdf',
    sha256: sha(bytes),
    revision: 1
  };
  let trusted = false;
  const resolver = new ExtensionResourceResolver({
    lookupResource: async () => record,
    verifyProvenance: async () => trusted ? {
      dataClass: 'public',
      revision: 1
    } : null,
    rootFor: async () => root,
    lookupTarget: async () => null
  });
  try {
    await assert.rejects(resolver.snapshot(scope, 'resource_one'), {
      code: 'extension_access_denied'
    });
    trusted = true;
    assert.deepEqual((await resolver.snapshot(scope, 'resource_one')).bytes, bytes);
    record = {
      ...record,
      ownerId: 'bob'
    };
    await assert.rejects(resolver.snapshot(scope, 'resource_one'), {
      code: 'extension_access_denied'
    });
    record = {
      ...record,
      ownerId: 'alice'
    };
    await fs.writeFile(path.join(root, 'original.pdf'), 'changed');
    await assert.rejects(resolver.snapshot(scope, 'resource_one'), {
      code: 'extension_access_denied'
    });
  } finally {
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
});
test('trusted targets are scoped and exclusive; contained outputs never choose paths', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-output-'))),
    bytes = Buffer.from(JSON.stringify({
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    }));
  const resolver = new ExtensionResourceResolver({
    lookupResource: async () => null,
    verifyProvenance: async () => null,
    rootFor: async () => root,
    lookupTarget: async () => ({
      ownerId: 'alice',
      projectId: 'project',
      relativePath: 'exports/new.ipynb',
      revision: 1
    }),
    maxProjectBytes: 1024
  });
  try {
    const request = {
      operation: 'doc_write',
      targetId: 'target_one',
      format: 'ipynb',
      spec: {}
    };
    const output = {
      ok: true,
      data: {
        targetId: 'target_one',
        format: 'ipynb',
        bytes: bytes.length,
        sha256: sha(bytes),
        contentBase64: bytes.toString('base64'),
        codeExecuted: false
      }
    };
    const published = await resolver.publish(scope, request, output);
    assert.equal(published.targetId, 'target_one');
    assert.deepEqual(await fs.readFile(path.join(root, 'exports/new.ipynb')), bytes);
    await assert.rejects(resolver.publish(scope, request, {
      ...output,
      data: {
        ...output.data,
        sha256: 'a'.repeat(64)
      }
    }), {
      code: 'extension_contract_invalid'
    });
  } finally {
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
});

test('active-workspace outputs share project-wide quota and target binding changes with the workspace', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-workspace-output-')));
  const bytes = Buffer.from(JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  let workspace = path.join(root, 'study-one');
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(root, 'study-two'));
  await fs.writeFile(path.join(root, 'other-project-file'), Buffer.alloc(1024));
  const resolver = new ExtensionResourceResolver({
    lookupResource: async () => null, verifyProvenance: async () => null,
    rootFor: async () => workspace, capacityRootFor: async () => root,
    lookupTarget: async () => ({ ownerId: 'alice', projectId: 'project', relativePath: 'new.ipynb', revision: 1 }),
    maxProjectBytes: 1024,
  });
  try {
    const first = await resolver.targetBinding(scope, 'result_one');
    workspace = path.join(root, 'study-two');
    assert.notEqual((await resolver.targetBinding(scope, 'result_one')).rootIdentity, first.rootIdentity);
    const output = { ok: true, data: { targetId: 'result_one', format: 'ipynb', bytes: bytes.length,
      sha256: sha(bytes), contentBase64: bytes.toString('base64'), codeExecuted: false } };
    await assert.rejects(resolver.publish(scope, { targetId: 'result_one', format: 'ipynb' }, output), { status: 413 });
    await assert.rejects(fs.stat(path.join(workspace, 'new.ipynb')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
