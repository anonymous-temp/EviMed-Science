import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { canonicalJson } from "@evimed/domain";
import { extensionRequestObject, extensionIdentifier } from "./extensionAccess.mjs";
import { HttpError, openScopedDirectoryNoFollow, openScopedFileNoFollow, readStableFileHandle, writeFileExclusiveNoFollow } from "./security.mjs";

const purpose = "evimed-extension-operation-v1\0";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const scopeKeys = ["userId", "ownerId", "ownerAccountCreatedAt", "membershipEpoch", "projectId", "accountCreatedAt", "projectCreatedAt", "runtimeGeneration", "extensionGenerationHash", "descriptorId", "artifactDigest", "installationId", "installationRevision"];
const refused = () => new HttpError(403, "extension_access_denied", "The extension operation is unavailable.");

/** Private one-operation authority, issued only after the hosted boundary
 * resolves the actual actor, active generation and permitted resource.
 * Neither a plugin nor a runtime can author this signed state.
 */
export class ExtensionOperationGrants {
  /** withAdmission owns the existing account-epoch row and storage/maintenance
   * fence for the whole first write. Execution claims, capacity and settlement
   * remain in ProductJobs; this class never creates a second job ledger.
   * @param {{dataDir:string,secret:string,authorize:any,withAdmission:any,now?:()=>number,ttlMs?:number}} options */
  constructor({ dataDir, secret, authorize, withAdmission, now = Date.now, ttlMs = 60000 }) {
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 || typeof authorize !== "function"
      || typeof withAdmission !== "function"
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000) throw new Error("Invalid trusted extension operation configuration.");
    this.dataDir = path.resolve(dataDir);
    this.root = path.join(this.dataDir, ".openscience", "extension-operations");
    this.secret = secret; this.authorize = authorize; this.withAdmission = withAdmission; this.now = now; this.ttlMs = ttlMs;
  }
  /** @param {any} scope */
  scope(scope) {
    extensionRequestObject(scope, scopeKeys);
    for (const key of ["userId", "projectId", "descriptorId", "installationId"]) extensionIdentifier(scope[key]);
    if (!["accountCreatedAt", "ownerAccountCreatedAt", "projectCreatedAt", "runtimeGeneration"].every(key => typeof scope[key] === "string" && scope[key].length > 0 && scope[key].length <= 256)
      || !/^[a-f0-9]{64}$/.test(scope.extensionGenerationHash) || !/^sha256:[a-f0-9]{64}$/.test(scope.artifactDigest)
      || !Number.isSafeInteger(scope.installationRevision) || scope.installationRevision < 1) throw refused();
    extensionIdentifier(scope.ownerId);
    if (scope.membershipEpoch !== null && (typeof scope.membershipEpoch !== "string" || !scope.membershipEpoch || scope.membershipEpoch.length > 4096)) throw refused();
    return structuredClone(scope);
  }
  /** @param {any} value */
  requestDigest(value) {
    const bytes = canonicalJson(value);
    if (Buffer.byteLength(bytes) > 65536) throw refused();
    return digest(bytes);
  }
  /** @param {string} id */
  reference(id) {
    const match = /^op_([a-f0-9]{64})_([a-f0-9]{32})$/.exec(id);
    if (!match) throw refused();
    return { ownerHash: match[1], directory: path.join(this.root, match[1], match[2]) };
  }
  /** @param {any} body */
  signature(body) { return createHmac("sha256", this.secret).update(purpose).update(canonicalJson(body)).digest("hex"); }
  /** Resource bytes are an already authorized public/aggregate snapshot,
   * supplied by a trusted resolver rather than a customer pathname.
   * @param {any} inputScope @param {any} request @param {any} [resource] */
  async issue(inputScope, request, resource = null) {
    const scope = this.scope(inputScope);
    return this.withAdmission(scope, () => this.issueAdmitted(scope, request, resource));
  }
  /** @param {any} scope @param {any} request @param {any} resource */
  async issueAdmitted(scope, request, resource) {
    // Capture the bounded request once. The trusted authorization callback
    // must evaluate the same content that the controller later receives.
    const requestBytes = canonicalJson(request);
    if (Buffer.byteLength(requestBytes) > 65536) throw refused();
    const capturedRequest = JSON.parse(requestBytes);
    const ownerHash = digest(scope.userId), id = `op_${ownerHash}_${randomUUID().replaceAll("-", "")}`;
    const reference = this.reference(id);
    let snapshot = null;
    let inputBytes = null;
    if (resource != null) {
      extensionRequestObject(resource, ["resourceId", "format", "dataClass", "bytes"]);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(resource.resourceId) || !["docx", "pdf", "xlsx", "ipynb"].includes(resource.format)
        || !["public", "aggregate"].includes(resource.dataClass) || !Buffer.isBuffer(resource.bytes)
        || !resource.bytes.length || resource.bytes.length > 8 * 1024 * 1024) throw refused();
      inputBytes = Buffer.from(resource.bytes);
      snapshot = { resourceId: resource.resourceId, format: resource.format, dataClass: resource.dataClass,
        bytes: inputBytes.length, sha256: digest(inputBytes) };
    }
    if (!await this.authorize(scope, capturedRequest)) throw refused();
    const directory = await openScopedDirectoryNoFollow(this.dataDir, reference.directory, { create: true });
    await directory.handle.close();
    try {
      if (snapshot) await writeFileExclusiveNoFollow(this.root, path.join(reference.directory, "input"), inputBytes, { mode: 0o400 });
      const body = { schemaVersion: 1, id, scope, requestDigest: digest(requestBytes), expiresAt: this.now() + this.ttlMs, snapshot };
      await writeFileExclusiveNoFollow(this.root, path.join(reference.directory, "grant.json"), `${canonicalJson({ body, signature: this.signature(body) })}\n`, { mode: 0o400 });
      if (!await this.authorize(scope, capturedRequest)) throw refused();
      return { operationId: id };
    } catch (error) { await this.remove(id); throw error; }
  }
  /** Revalidate current grants on dispatch and result hydration. Trusted
   * controller construction supplies a descriptor binding separately.
   * @param {string} id @param {any} request @param {any} [expected] */
  async verify(id, request, expected = null) {
    const reference = this.reference(id);
    const file = await openScopedFileNoFollow(this.root, path.join(reference.directory, "grant.json"));
    let bytes;
    try { if (file.stat.size > 16384) throw refused(); bytes = await readStableFileHandle(file.handle, file.stat); }
    finally { await file.handle.close(); }
    let grant;
    try { grant = JSON.parse(bytes.toString("utf8")); } catch { throw refused(); }
    extensionRequestObject(grant, ["body", "signature"]);
    extensionRequestObject(grant.body, ["schemaVersion", "id", "scope", "requestDigest", "expiresAt", "snapshot"]);
    if (!/^[a-f0-9]{64}$/.test(grant.signature ?? "")) throw refused();
    const actual = Buffer.from(grant.signature, "hex"), signed = Buffer.from(this.signature(grant.body), "hex");
    if (!timingSafeEqual(actual, signed) || grant.body.schemaVersion !== 1 || grant.body.id !== id
      || !Number.isSafeInteger(grant.body.expiresAt) || grant.body.expiresAt <= this.now()
      || grant.body.requestDigest !== this.requestDigest(request)) throw refused();
    const scope = this.scope(grant.body.scope);
    if (digest(scope.userId) !== reference.ownerHash || expected && Object.entries(expected).some(([key, value]) => scope[key] !== value)
      || !await this.authorize(scope, request)) throw refused();
    return grant.body;
  }
  /** @param {string} id @param {any} request @param {string} resourceId @param {any} [expected] */
  async inputSnapshot(id, request, resourceId, expected = null) {
    const grant = await this.verify(id, request, expected);
    if (!grant.snapshot || grant.snapshot.resourceId !== resourceId) throw refused();
    const filePath = path.join(this.reference(id).directory, "input");
    return { ...grant.snapshot, filePath };
  }
  /** Joined controller work is removed by its issuer; this accepts only a
   * signed-state namespace identity, never an arbitrary path.
   * @param {string} id */
  async remove(id) {
    const reference = this.reference(id);
    let directory;
    try { directory = await openScopedDirectoryNoFollow(this.root, reference.directory); }
    catch (error) { if (["ENOENT", "file_not_found"].includes(error.code)) return; throw error; }
    try {
      for (const name of await fs.readdir(directory.path)) {
        if (!["grant.json", "input"].includes(name)) throw refused();
        await fs.unlink(path.join(directory.path, name));
      }
      await directory.handle.sync();
    } finally { await directory.handle.close(); }
    await fs.rmdir(reference.directory);
  }
}
