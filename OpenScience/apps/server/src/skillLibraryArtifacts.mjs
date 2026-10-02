import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson, canonicalPersonalSkillResourcePath } from "@evimed/domain";
import { HttpError, assertProjectCapacity, directorySize, openScopedDirectoryNoFollow, openScopedFileNoFollow, readStableFileHandle, writeFileExclusiveNoFollow } from "./security.mjs";

/** @param {string|Buffer} value */
const hash = value => createHash("sha256").update(value).digest("hex");
const MAX_FILES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const writes = new Map();
/** Skill imports are data. Archive extraction supplies regular-file entries only; it never runs a script. @param {string} value */
function resourcePath(value) {
  try { return canonicalPersonalSkillResourcePath(value).path }
  catch { throw new HttpError(400, "extension_contract_invalid", "Invalid skill resource path."); }
}
/** @param {string} value */
function digestHex(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new HttpError(400, "extension_contract_invalid", "Invalid skill resource identity.");
  return value.slice(7);
}

/** Private content-addressed artifacts. No public handler accepts a path, owner or filesystem root. */
export class SkillLibraryArtifacts {
  /** Admission callback takes a deployment-wide PostgreSQL advisory lock across processes. Limits are server-only. @param {{root:string,parseSkill:any,resolveImport?:any,decodeArchive?:any,withStorageAdmission?:any,sharedStorageRoot?:string,sharedStorageRoots?:string[],maxOwnerBytes?:number,maxGlobalBytes?:number,minFreeBytes?:number}} options */
  constructor({ root, parseSkill, resolveImport = null, decodeArchive = null, withStorageAdmission = null,
    sharedStorageRoot = null, sharedStorageRoots = [], maxOwnerBytes = 128 * 1024 * 1024, maxGlobalBytes = 1024 * 1024 * 1024, minFreeBytes = 512 * 1024 * 1024 }) {
    this.root = path.resolve(root);
    if (!Array.isArray(sharedStorageRoots) || sharedStorageRoots.length > 2) throw new Error("Shared skill storage roots must be bounded.");
    this.sharedStorageRoots = [...(sharedStorageRoot == null ? [] : [sharedStorageRoot]), ...sharedStorageRoots].map(value => path.resolve(value));
    if (this.sharedStorageRoots.length > 2) throw new Error("Shared skill storage roots must be bounded.");
    const allRoots = [this.root, ...this.sharedStorageRoots];
    if (allRoots.some((value, index) => allRoots.slice(index + 1).some(other => other === value || other.startsWith(value + path.sep)
      || value.startsWith(other + path.sep)))) throw new Error("Shared skill storage roots must be disjoint.");
    this.parseSkill = parseSkill;
    this.resolveImport = resolveImport;
    this.decodeArchive = decodeArchive;
    for (const limit of [maxOwnerBytes, maxGlobalBytes, minFreeBytes]) if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid trusted skill storage limit.");
    if (!maxOwnerBytes || !maxGlobalBytes) throw new Error("Skill storage admission requires finite limits.");
    this.maxOwnerBytes = maxOwnerBytes; this.maxGlobalBytes = maxGlobalBytes; this.minFreeBytes = minFreeBytes;
    this.withStorageAdmission = withStorageAdmission;
    this.writeContext = new AsyncLocalStorage();
  }
  /** @param {any} user */
  ownerRoot(user) {
    if (typeof user?.id !== "string" || !user.id) throw new HttpError(401, "unauthorized", "Authentication is required.");
    return path.join(this.root, hash(user.id));
  }
  /** @param {any} user @param {string} relative @param {Buffer|string} bytes */
  async publish(user, relative, bytes) {
    const target = path.join(this.ownerRoot(user), relative);
    return this.admit(async () => {
      try {
        const old = await this.boundedRead(target);
        if (!old.equals(Buffer.from(bytes))) throw new HttpError(409, "extension_contract_invalid", "Immutable skill content changed.");
        return target;
      } catch (error) { if (!["ENOENT", "file_not_found"].includes(error?.code)) throw error; }
      const directory = await openScopedDirectoryNoFollow(this.root, this.ownerRoot(user), { create: true });
      await directory.handle.close();
      const size = Buffer.byteLength(bytes);
      await assertProjectCapacity({ baseDir: this.ownerRoot(user), maxBytes: this.maxOwnerBytes }, target, size, { maxProjectUsageScanEntries: 20000 });
      let companionBytes = 0;
      for (const companion of this.sharedStorageRoots) companionBytes += await directorySize(companion, { maxEntries: 50000 }).catch(error => {
        if (["ENOENT", "file_not_found"].includes(error.code)) return 0;
        throw error;
      });
      const used = await directorySize(this.root, { maxEntries: 50000 }) + companionBytes;
      const disk = await fs.statfs(this.root);
      if (used + size > this.maxGlobalBytes || disk.bavail * disk.bsize < size + this.minFreeBytes) {
        throw new HttpError(503, "extension_storage_capacity", "Skill preparation is waiting for storage space.");
      }
      try { await writeFileExclusiveNoFollow(this.root, target, bytes, { mode: 0o400 }); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const old = await this.boundedRead(target);
        if (!old.equals(Buffer.from(bytes))) throw new HttpError(409, "extension_contract_invalid", "Immutable skill content changed.");
      }
      return target;
    });
  }
  /** Fallback serializes local fixtures; hosted composition supplies the cross-process database lock. @param {()=>Promise<any>} work */
  async admit(work) {
    if (this.withStorageAdmission) return this.withStorageAdmission(work, this.writeContext.getStore() ?? null);
    const previous = writes.get(this.root) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work), settled = pending.catch(() => {});
    writes.set(this.root, settled);
    try { return await pending; } finally { if (writes.get(this.root) === settled) writes.delete(this.root); }
  }
  /** Reuse the caller's trusted PostgreSQL transaction, avoiding a second pool checkout while it holds an account lock. @param {any} client @param {()=>Promise<any>} work */
  async withTransaction(client, work) { return this.writeContext.run(client, work); }
  /** Descriptor-based bounded stable reads reject symlinks, hard links, special files and concurrent edits. @param {string} file */
  async boundedRead(file) {
    const opened = await openScopedFileNoFollow(this.root, file);
    try {
      if (opened.stat.size > MAX_FILE_BYTES) throw new HttpError(413, "product_batch_too_large", "The skill resource is too large.");
      return await readStableFileHandle(opened.handle, opened.stat);
    } finally { await opened.handle.close(); }
  }
  /** @param {any} user @param {any} resource */
  async resourceBytes(user, resource) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)
      || Object.keys(resource).sort().join(",") !== "digest,id,path,size") throw new HttpError(400, "extension_contract_invalid", "Invalid skill resource.");
    if (resourcePath(resource.path) !== resource.path) throw new HttpError(400, 'extension_contract_invalid', 'Noncanonical skill resource path.');
    const hex = digestHex(resource.digest);
    if (resource.id !== `resource:${hex}` || !Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > MAX_FILE_BYTES) {
      throw new HttpError(400, "extension_contract_invalid", "Invalid skill resource.");
    }
    const bytes = await this.boundedRead(path.join(this.ownerRoot(user), "blobs", hex));
    if (bytes.length !== resource.size || hash(bytes) !== hex) throw new HttpError(409, "extension_contract_invalid", "The skill resource changed.");
    return bytes;
  }
  /** Write only a trusted native name and immutable resource bytes; parse through the pinned native provider. @param {any} user @param {any} input */
  async prepare(user, { nativeName, file, digest, resources }) {
    const hex = digestHex(digest);
    if (!/^personal-[a-f0-9]{16}-[a-f0-9]{32}$/.test(nativeName) || typeof file !== "string" || Buffer.byteLength(file) > 262144 + 4096
      || !Array.isArray(resources) || resources.length > MAX_FILES) throw new HttpError(400, "extension_contract_invalid", "Invalid skill preparation.");
    if (`sha256:${hash(canonicalJson({ file, resources }))}` !== digest) throw new HttpError(409, "extension_contract_invalid", "Skill content does not match its identity.");
    const prefix = path.join("packages", hex, nativeName);
    const root = path.join(this.ownerRoot(user), "packages", hex);
    let size = Buffer.byteLength(file);
    const paths = new Set(["skill.md"]), prefixes = new Map();
    for (const resource of resources) {
      const key = canonicalPersonalSkillResourcePath(resource.path, prefixes).key;
      if (paths.has(key) || key.split('/').at(-1) === 'skill.md') throw new HttpError(400, "extension_contract_invalid", "Duplicate skill resource.");
      paths.add(key);
      const bytes = await this.resourceBytes(user, resource);
      size += bytes.length;
      if (size > MAX_PACKAGE_BYTES) throw new HttpError(413, "product_batch_too_large", "The skill package is too large.");
      await this.publish(user, path.join(prefix, resource.path), bytes);
    }
    await this.publish(user, path.join(prefix, "SKILL.md"), file);
    if (typeof this.parseSkill !== "function") throw new HttpError(503, "product_state_unavailable", "Native skill validation is unavailable.");
    const parsed = await this.parse(root, { expectedName: nativeName });
    if (parsed?.name !== nativeName) throw new HttpError(400, "extension_contract_invalid", "Native skill validation failed.");
    await this.publish(user, path.join("packages", hex, "manifest.json"), `${canonicalJson({ schemaVersion: 1, nativeName, digest, resources })}\n`);
    return { nativeName, digest };
  }
  /** The trusted resolver authorizes opaque upload IDs and produces bounded extracted entries; client paths never reach it. @param {any} user @param {any} input */
  async import(user, { resourceId, skillId, nativeName, preview = false }) {
    const entries = this.resolveImport ? await this.resolveImport(user, resourceId) : await this.uploadEntries(user, resourceId);
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_FILES + 1) throw new HttpError(400, "extension_contract_invalid", "Invalid skill package.");
    const normalized = [];
    const seen = new Set(), prefixes = new Map();
    let total = 0;
    for (const entry of entries) {
      if (!entry || entry.type !== "file" || !Buffer.isBuffer(entry.bytes)) throw new HttpError(400, "extension_contract_invalid", "Skill packages contain regular files only.");
      const relative = resourcePath(entry.path);
      const key = canonicalPersonalSkillResourcePath(relative, prefixes).key;
      if (seen.has(key) || (relative !== 'SKILL.md' && key.split('/').at(-1) === 'skill.md')
        || [...seen].some(other => key.startsWith(other + '/') || other.startsWith(key + '/')) || entry.bytes.length > MAX_FILE_BYTES) throw new HttpError(400, "extension_contract_invalid", "Invalid skill package entry.");
      seen.add(key); total += entry.bytes.length;
      if (total > MAX_PACKAGE_BYTES) throw new HttpError(413, "product_batch_too_large", "The skill package is too large.");
      normalized.push({ path: relative, bytes: entry.bytes });
    }
    const skill = normalized.find(entry => entry.path === "SKILL.md");
    if (!skill || skill.bytes.length > 262144 + 4096) throw new HttpError(400, "extension_contract_invalid", "The package needs one SKILL.md.");
    // This is a per-import private directory, not the public package cache or an ordinary project root.
    const prefix = path.join("imports", hash(skillId));
    try {
      for (const entry of normalized) await this.publish(user, path.join(prefix, "bundle", entry.path), entry.bytes);
      const importRoot = path.join(this.ownerRoot(user), prefix);
      const parsed = await this.parse(importRoot, {});
      const resources = [];
      for (const entry of normalized.filter(item => item.path !== "SKILL.md")) {
        const hex = hash(entry.bytes);
        if (!preview) await this.publish(user, path.join("blobs", hex), entry.bytes);
        resources.push({ id: `resource:${hex}`, path: entry.path, digest: `sha256:${hex}`, size: entry.bytes.length });
      }
      // Namespace replacement happens when the service renders the authored revision, never by editing a native provider's result.
      return { nativeName, description: parsed.description ?? "", instructions: parsed.instructions, resources,
        invocation: parsed.invocation, metadata: parsed.metadata ?? {}, whenToUse: parsed.whenToUse ?? null };
    } finally { await this.removeScratch(user, "imports", hash(skillId)); }
  }
  /** No paths are exposed in resource responses. @param {any} user @param {any} input */
  async read(user, { resource }) { return this.resourceBytes(user, resource); }
  /** Explicit upload namespace; filenames and host paths cannot become authority. @param {any} user @param {string} kind @param {Buffer} bytes */
  async upload(user, kind, bytes) {
    if (!["skill", "zip", "tar-gzip"].includes(kind) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES) {
      throw new HttpError(400, "extension_contract_invalid", "Invalid skill upload.");
    }
    const identity = hash(Buffer.concat([Buffer.from(`${kind}\0`), bytes]));
    const uploads = await this.cleanupUploads(user);
    if (uploads >= 256) {
      try { await this.verifyUpload(user, `upload:${identity}`); }
      catch { throw new HttpError(413, "project_scan_too_large", "Too many raw skill uploads."); }
    }
    await this.publish(user, path.join("uploads", identity, "input"), bytes);
    await this.publish(user, path.join("uploads", identity, "metadata.json"), `${canonicalJson({ kind, size: bytes.length, digest: `sha256:${hash(bytes)}` })}\n`);
    return { resourceId: `upload:${identity}` };
  }
  /** Only the service's disposable input namespaces may be erased, never prepared packages or resource blobs. @param {any} user @param {'imports'|'uploads'} kind @param {string} identity */
  async removeScratch(user, kind, identity) {
    if (!["imports", "uploads"].includes(kind) || !/^[a-f0-9]{64}$/.test(identity)) throw new HttpError(400, "extension_contract_invalid", "Invalid skill scratch identity.");
    const namespace = path.join(this.ownerRoot(user), kind);
    let parent;
    try { parent = await openScopedDirectoryNoFollow(this.root, namespace); }
    catch (error) { if (["ENOENT", "file_not_found"].includes(error?.code)) return; throw error; }
    let visited = 0;
    const remove = async (directory, name, depth) => {
      if (++visited > 4096 || depth > 18) throw new HttpError(400, "extension_contract_invalid", "Invalid skill scratch tree.");
      const file = path.join(directory, name);
      const info = await fs.lstat(file).catch(error => { if (error?.code === "ENOENT") return null; throw error; });
      if (!info) return;
      if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new HttpError(403, "path_forbidden", "Invalid skill scratch file.");
      if (info.isDirectory()) {
        // The parent is already held open. Follow only its ordinary child via that descriptor;
        // passing a /proc/self/fd path back to a pathname scope check would reject valid Linux cleanup.
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const child = { handle, path: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : file };
        try { for (const entry of await fs.readdir(child.path)) await remove(child.path, entry, depth + 1); }
        finally { await child.handle.close(); }
        await fs.rmdir(file);
      } else await fs.unlink(file);
    };
    try { await remove(parent.path, identity, 0); } finally { await parent.handle.close(); }
  }
  /** Raw inputs expire after seven days; prepared revisions and active-generation resources are outside this inventory. @param {any} user */
  async cleanupUploads(user) {
    return this.admit(async () => {
      const namespace = path.join(this.ownerRoot(user), "uploads");
      let directory;
      try { directory = await openScopedDirectoryNoFollow(this.root, namespace); }
      catch (error) { if (["ENOENT", "file_not_found"].includes(error?.code)) return 0; throw error; }
      try {
        const entries = await fs.readdir(directory.path);
        if (entries.length > 1024) throw new HttpError(413, "project_scan_too_large", "Too many raw skill uploads.");
        let remaining = entries.length;
        for (const name of entries) {
          if (!/^[a-f0-9]{64}$/.test(name)) throw new HttpError(400, "extension_contract_invalid", "Invalid skill upload storage.");
          const info = await fs.lstat(path.join(directory.path, name));
          if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(403, "path_forbidden", "Invalid skill upload storage.");
          if (Date.now() - info.mtimeMs > 7 * 24 * 60 * 60 * 1000) { await this.removeScratch(user, "uploads", name); remaining--; }
        }
        return remaining;
      } finally { await directory.handle.close(); }
    });
  }
  /** @param {any} user @param {string} resourceId */
  async removeUpload(user, resourceId) {
    await this.verifyUpload(user, resourceId);
    await this.admit(() => this.removeScratch(user, "uploads", resourceId.slice(7)));
    return { removed: true };
  }
  /** Reauthorize the immutable input immediately before committing an import. @param {any} user @param {string} resourceId */
  async verifyUpload(user, resourceId) {
    if (this.resolveImport) { await this.resolveImport(user, resourceId); return; }
    if (typeof resourceId !== "string" || !/^upload:[a-f0-9]{64}$/.test(resourceId)) throw new HttpError(404, "product_document_not_found", "The skill upload is unavailable.");
    const directory = path.join(this.ownerRoot(user), "uploads", resourceId.slice(7));
    try {
      const opened = await openScopedDirectoryNoFollow(this.root, directory);
      try {
        if (Date.now() - opened.stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) throw new HttpError(404, "product_document_not_found", "The skill upload expired.");
      } finally { await opened.handle.close(); }
      const metadata = JSON.parse((await this.boundedRead(path.join(directory, "metadata.json"))).toString("utf8"));
      const bytes = await this.boundedRead(path.join(directory, "input"));
      if (metadata.size !== bytes.length || metadata.digest !== `sha256:${hash(bytes)}` || `upload:${hash(Buffer.concat([Buffer.from(`${metadata.kind}\0`), bytes]))}` !== resourceId) {
        throw new HttpError(409, "extension_contract_invalid", "The skill upload changed.");
      }
    } catch (error) {
      if (["ENOENT", "file_not_found"].includes(error?.code)) throw new HttpError(404, "product_document_not_found", "The skill upload is unavailable.");
      throw error;
    }
  }
  /** The opaque id resolves only inside this account's private upload root. @param {any} user @param {string} resourceId */
  async uploadEntries(user, resourceId) {
    await this.verifyUpload(user, resourceId);
    if (typeof resourceId !== "string" || !/^upload:[a-f0-9]{64}$/.test(resourceId)) throw new HttpError(404, "product_document_not_found", "The skill upload is unavailable.");
    const directory = path.join(this.ownerRoot(user), "uploads", resourceId.slice(7));
    let metadata, bytes;
    try {
      metadata = JSON.parse((await this.boundedRead(path.join(directory, "metadata.json"))).toString("utf8"));
      bytes = await this.boundedRead(path.join(directory, "input"));
    } catch (error) {
      if (["ENOENT", "file_not_found"].includes(error?.code)) throw new HttpError(404, "product_document_not_found", "The skill upload is unavailable.");
      throw error;
    }
    if (metadata.size !== bytes.length || metadata.digest !== `sha256:${hash(bytes)}` || `upload:${hash(Buffer.concat([Buffer.from(`${metadata.kind}\0`), bytes]))}` !== resourceId) {
      throw new HttpError(409, "extension_contract_invalid", "The skill upload changed.");
    }
    if (metadata.kind === "skill") return [{ type: "file", path: "SKILL.md", bytes }];
    if (!["zip", "tar-gzip"].includes(metadata.kind) || !this.decodeArchive) throw new HttpError(503, "product_state_unavailable", "Archive skill preparation is unavailable.");
    return this.decodeArchive(bytes, metadata.kind);
  }
  /** Native diagnostics can contain imported text and local paths; retain a fixed public refusal. @param {string} root @param {any} options */
  async parse(root, options) {
    if (typeof this.parseSkill !== "function") throw new HttpError(503, "product_state_unavailable", "Native skill validation is unavailable.");
    try { return await this.parseSkill(root, options); }
    catch (error) {
      if (error instanceof HttpError && error.status >= 500) throw new HttpError(503, "product_state_unavailable", "Native skill validation is unavailable.");
      throw new HttpError(400, "extension_contract_invalid", "The native skill format is invalid.");
    }
  }
  /** Trusted controller materialization revalidates the manifest before mounting a read-only root. @param {any} user @param {any} input */
  async preparedRoot(user, { nativeName, digest, resources }) {
    if (!/^personal-[a-f0-9]{16}-[a-f0-9]{32}$/.test(nativeName) || !Array.isArray(resources) || resources.length > MAX_FILES) {
      throw new HttpError(400, "extension_contract_invalid", "Invalid skill preparation.");
    }
    const root = path.join(this.ownerRoot(user), "packages", digestHex(digest));
    const opened = await openScopedDirectoryNoFollow(this.root, root);
    await opened.handle.close();
    const manifest = await this.boundedRead(path.join(root, "manifest.json"));
    if (manifest.toString("utf8") !== `${canonicalJson({ schemaVersion: 1, nativeName, digest, resources })}\n`) {
      throw new HttpError(409, "extension_contract_invalid", "The skill manifest changed.");
    }
    const file = await this.boundedRead(path.join(root, nativeName, "SKILL.md"));
    if (`sha256:${hash(canonicalJson({ file: file.toString("utf8"), resources }))}` !== digest) {
      throw new HttpError(409, "extension_contract_invalid", "The skill content changed.");
    }
    for (const resource of resources) {
      const original = await this.resourceBytes(user, resource);
      const mounted = await this.boundedRead(path.join(root, nativeName, resource.path));
      if (!mounted.equals(original)) throw new HttpError(409, "extension_contract_invalid", "The mounted skill resource changed.");
    }
    return root;
  }
}
