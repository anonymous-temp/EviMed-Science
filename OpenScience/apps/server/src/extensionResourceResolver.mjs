import { createHash } from 'node:crypto';
import path from 'node:path';
import { extensionIdentifier } from './extensionAccess.mjs';
import { HttpError, openScopedFileNoFollow, readStableFileHandle, openScopedDirectoryNoFollow, writeFileExclusiveNoFollow, assertProjectCapacity } from './security.mjs';
import { guardDocument } from '../../../scripts/runtime/extensions/cowork/policy.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const denied = () => new HttpError(403, 'extension_access_denied', 'The document resource is unavailable.');
const invalid = () => new HttpError(400, 'extension_contract_invalid', 'The document result is invalid.');
/** Authoritative record/provenance callbacks are deployment-owned, never package or request data. */
export class ExtensionResourceResolver {
  /** @param {{lookupResource:any,verifyProvenance:any,rootFor:any,capacityRootFor?:any,lookupTarget:any,maxProjectBytes?:number}} options */
  constructor({
    lookupResource,
    verifyProvenance,
    rootFor,
    capacityRootFor = rootFor,
    lookupTarget,
    maxProjectBytes = 128 * 1024 * 1024
  }) {
    if ([lookupResource, verifyProvenance, rootFor, capacityRootFor, lookupTarget].some(fn => typeof fn !== 'function') || !Number.isSafeInteger(maxProjectBytes) || maxProjectBytes < 1) throw invalid();
    this.lookupResource = lookupResource;
    this.verifyProvenance = verifyProvenance;
    this.rootFor = rootFor;
    this.capacityRootFor = capacityRootFor;
    this.lookupTarget = lookupTarget;
    this.maxProjectBytes = maxProjectBytes;
  }
  /** @param {any} scope @param {any} record */
  owned(scope, record) {
    if (!record || record.ownerId !== scope.userId || record.projectId !== scope.projectId || !Number.isSafeInteger(record.revision) || record.revision < 1) throw denied();
  }
  /** @param {string} root @param {any} record */
  target(root, record) {
    if (typeof record.relativePath !== 'string' || record.relativePath.includes('\\') || record.relativePath.split('/').some(part => !part || part.startsWith('.'))) throw denied();
    const full = path.resolve(root, record.relativePath);
    if (!full.startsWith(root + path.sep)) throw denied();
    return full;
  }
  /** @param {any} scope @param {string} resourceId */
  async snapshot(scope, resourceId) {
    extensionIdentifier(resourceId);
    const record = await this.lookupResource(scope, resourceId);
    this.owned(scope, record);
    const proof = await this.verifyProvenance(scope, record);
    if (!proof || !['public', 'aggregate'].includes(proof.dataClass) || proof.revision !== record.revision || !['docx', 'pdf', 'xlsx', 'ipynb'].includes(record.format) || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) throw denied();
    const root = path.resolve(await this.rootFor(scope, record));
    const opened = await openScopedFileNoFollow(root, this.target(root, record));
    try {
      if (opened.stat.size < 1 || opened.stat.size > 8 * 1024 * 1024) throw denied();
      const bytes = await readStableFileHandle(opened.handle, opened.stat);
      if (sha(bytes) !== record.sha256) throw denied();
      return {
        resourceId,
        format: record.format,
        dataClass: proof.dataClass,
        bytes
      };
    } finally {
      await opened.handle.close();
    }
  }
  /** @param {any} scope @param {string} targetId */
  async targetBinding(scope, targetId) {
    extensionIdentifier(targetId);
    const record = await this.lookupTarget(scope, targetId);
    this.owned(scope, record);
    const root = path.resolve(await this.rootFor(scope, record));
    this.target(root, record);
    return {
      targetId,
      revision: record.revision,
      relativePath: record.relativePath,
      rootIdentity: sha(root)
    };
  }
  /** @param {any} scope @param {any} request @param {any} result */
  async publish(scope, request, result) {
    const data = result?.data;
    if (result?.ok !== true || !data || data.targetId !== request.targetId || data.format !== request.format || !['xlsx', 'ipynb'].includes(data.format) || data.codeExecuted !== false || !Number.isSafeInteger(data.bytes) || data.bytes < 1 || data.bytes > 8 * 1024 * 1024 || typeof data.contentBase64 !== 'string' || data.contentBase64.length > 12 * 1024 * 1024) throw invalid();
    const bytes = Buffer.from(data.contentBase64, 'base64');
    if (bytes.length !== data.bytes || bytes.toString('base64') !== data.contentBase64 || sha(bytes) !== data.sha256) throw invalid();
    try {
      guardDocument(bytes, data.format);
    } catch {
      throw invalid();
    }
    const record = await this.lookupTarget(scope, request.targetId);
    this.owned(scope, record);
    if (record.format && record.format !== request.format) throw invalid();
    const root = path.resolve(await this.rootFor(scope, record)),
      target = this.target(root, record);
    const capacityRoot = path.resolve(await this.capacityRootFor(scope, record));
    if (root !== capacityRoot && !root.startsWith(capacityRoot + path.sep)) throw denied();
    await assertProjectCapacity({
      baseDir: capacityRoot,
      maxBytes: this.maxProjectBytes
    }, target, bytes.length, {
      maxProjectUsageScanEntries: 20000
    });
    const parent = await openScopedDirectoryNoFollow(root, path.dirname(target), {
      create: true
    });
    await parent.handle.close();
    try {
      await writeFileExclusiveNoFollow(root, target, bytes, {
        mode: 0o600
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const opened = await openScopedFileNoFollow(root, target);
      try {
        if (!bytes.equals(await readStableFileHandle(opened.handle, opened.stat))) throw invalid();
      } finally {
        await opened.handle.close();
      }
    }
    return {
      targetId: request.targetId,
      format: data.format,
      bytes: bytes.length,
      sha256: data.sha256,
      targetRevision: record.revision,
      artifactPath: record.relativePath
    };
  }
}
