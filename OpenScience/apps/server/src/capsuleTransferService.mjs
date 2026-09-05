import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { packCapsule, openCapsule } from "./capsuleContainer.mjs";
import { protectedCapsuleDirectory, readProtectedCapsuleFile, writeProtectedCapsuleFile } from "./capsuleIdentityStore.mjs";
import { HttpError } from "./security.mjs";
import { productId, productInteger } from "./productPersistence.mjs";

export const CAPSULE_TRANSFER_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 100;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WORKSTYLE = ["method_preference", "writing_style", "preference", "tooling"];
const PROFILE = ["profile", "behavior", "expertise"];
const KNOWLEDGE = ["project_fact", "analysis", "decision", "stance", "tension", "correction", "follow_up"];
const digest = value => createHash("sha256").update(value).digest("hex");
const invalid = () => new HttpError(400, "capsule_transfer_invalid", "The capsule transfer is invalid or unsupported.");
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
function checkedText(value, max = 20_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw invalid();
  return value;
}
/** @param {unknown} value */
function scopesOf(value = ["workstyle"]) {
  if (!Array.isArray(value) || !value.includes("workstyle") || value.length > 3 || new Set(value).size !== value.length
    || value.some(scope => !["workstyle", "+profile", "+knowledge"].includes(scope))) throw invalid();
  return value;
}
function kindsFor(scopes) { return [...WORKSTYLE, ...(scopes.includes("+profile") ? PROFILE : []), ...(scopes.includes("+knowledge") ? KNOWLEDGE : [])]; }
function location(kind) {
  return kind === "method_preference" ? { layer: "methods", path: null }
    : WORKSTYLE.includes(kind) ? { layer: "profile", path: "standards.jsonl" }
      : PROFILE.includes(kind) ? { layer: "profile", path: "profile.md" } : { layer: "knowledge", path: "knowledge/chunks.jsonl" };
}
function renderedFiles(snapshotId, entries) {
  const result = Object.create(null);
  for (const entry of entries) {
    if (entry.factKind === "method_preference") {
      result[entry.path] = `---\nname: transferred-method-${entry.id}\ndescription: A transferred research method, preserved as context only.\nsource_snapshot: ${snapshotId}\nsource_version: ${entry.version}\nsource_digest: ${entry.sha256}\n---\n\n${entry.content}\n`;
    }
  }
  for (const file of ["standards.jsonl", "profile.md", "knowledge/chunks.jsonl"]) {
    const group = entries.filter(entry => entry.path === file);
    if (group.length) result[file] = file === "profile.md"
      ? `# Shared profile\n\n${group.map(entry => `## ${entry.factKind} (version ${entry.version})\n\n${entry.content}`).join("\n\n")}\n`
      : group.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  }
  result["provenance.json"] = JSON.stringify({ format: "evimed-capsule-transfer", version: 1, snapshotId, entries });
  return result;
}
function decodeBase64(value, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maxBytes || decoded.toString("base64") !== value) throw invalid();
  return decoded;
}
function parseArchive(archive) {
  if (typeof archive !== "string" || Buffer.byteLength(archive) > CAPSULE_TRANSFER_MAX_BYTES) throw invalid();
  let envelope;
  try { envelope = JSON.parse(archive); } catch { throw invalid(); }
  fields(envelope, ["format", "version", "manifest", "issuerPublicKey", "passwordWrap", "payload"]);
  if (envelope.format !== "evimedcap" || envelope.version !== 1 || !envelope.manifest?.encryption) throw invalid();
  decodeBase64(envelope.issuerPublicKey, 128);
  fields(envelope.payload, Object.keys(envelope.payload ?? {}));
  if (Object.keys(envelope.payload).length > 102) throw invalid();
  const payload = Object.fromEntries(Object.entries(envelope.payload).map(([name, content]) => [name, decodeBase64(content, CAPSULE_TRANSFER_MAX_BYTES)]));
  return { envelope, container: { manifest: envelope.manifest, payload }, passwordWrap: decodeBase64(envelope.passwordWrap, 1086) };
}
function snapshotView(record) {
  // Preserve version/digest evidence while omitting private local record identifiers.
  const { sourceEntries, capsuleId: _capsuleId, issuerId: _issuerId, ...metadata } = record.payload;
  return { id: record.id, revision: record.revision, createdAt: record.createdAt, ...metadata,
    entryVersions: sourceEntries.map(entry => ({ version: entry.revision, sha256: entry.sha256 })) };
}

/** Portable snapshots are immutable ciphertext; online state can be revoked, offline copies cannot. */
export class CapsuleTransferService {
  /** @param {{documents: import('./productStore.mjs').ProductDocuments, capsules: import('./capsuleService.mjs').CapsuleService, identities: import('./capsuleIdentityStore.mjs').CapsuleIdentityStore, dataDir: string}} options */
  constructor({ documents, capsules, identities, dataDir }) {
    this.documents = documents; this.capsules = capsules; this.identities = identities; this.dataDir = dataDir;
  }

  async export(userId, capsuleId, input) {
    fields(input, ["password", "scopes", "supersedes"]); checkedText(input.password, 1024);
    if (input.supersedes != null) await this.snapshot(userId, capsuleId, input.supersedes);
    const scopes = scopesOf(input.scopes); const kinds = kindsFor(scopes);
    await this.capsules.get(userId, capsuleId);
    const source = await this.documents.database.transaction(async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const capsule = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' AND id=$2 AND deleted_at IS NULL", [productId(userId), productId(capsuleId)]);
      if (!capsule.rows[0]) throw new HttpError(404, "capsule_not_found", "The capsule is unavailable.");
      const facts = await client.query("SELECT id,revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND deleted_at IS NULL AND payload @> $2::jsonb AND payload->>'factKind'=ANY($3::text[]) AND payload->>'layer'<>'sources' ORDER BY id LIMIT 101", [userId, JSON.stringify({ capsuleId, status: "approved" }), kinds]);
      return { revision: capsule.rows[0].revision, facts: facts.rows };
    });
    if (!source.facts.length) throw new HttpError(400, "capsule_export_empty", "No approved entries are eligible for these share scopes.");
    if (source.facts.length > MAX_ENTRIES) throw new HttpError(413, "capsule_transfer_too_large", "A snapshot supports at most 100 approved entries.");
    const snapshotId = randomUUID();
    const entries = source.facts.map(fact => {
      const id = randomUUID(); const place = location(fact.payload.factKind); const content = checkedText(fact.payload.content);
      return { id, version: fact.revision, factKind: fact.payload.factKind, layer: place.layer, content, sha256: digest(content), path: place.path ?? `methods/${id}/SKILL.md` };
    });
    const files = renderedFiles(snapshotId, entries);
    const identity = await this.identities.forUser(userId);
    const container = await packCapsule({ capsuleId: snapshotId, version: source.revision, createdAt: new Date().toISOString(),
      issuer: { userId: identity.issuerId, signingKeyId: identity.signing.keyId, signingPrivateKey: identity.signing.privateKey },
      scope: scopes, layers: [...new Set([...entries.map(entry => entry.layer), "methods"])], password: input.password,
      entries: Object.entries(files).map(([file, content]) => ({ path: file, content,
        mime: file.endsWith(".json") ? "application/json" : file.endsWith(".jsonl") ? "application/x-ndjson" : "text/markdown",
        layer: file === "provenance.json" ? "methods" : entries.find(entry => entry.path === file).layer })),
    });
    const archive = JSON.stringify({ format: "evimedcap", version: 1, manifest: container.manifest, issuerPublicKey: identity.signing.publicKey,
      passwordWrap: container.passwordWrap.toString("base64"), payload: Object.fromEntries(Object.entries(container.payload).map(([file, bytes]) => [file, bytes.toString("base64")])) });
    if (Buffer.byteLength(archive) > CAPSULE_TRANSFER_MAX_BYTES) throw new HttpError(413, "capsule_transfer_too_large", "This encrypted snapshot exceeds 2 MiB.");
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
    await writeProtectedCapsuleFile(directory, `${snapshotId}.evimedcap`, archive);
    let record;
    try { record = await this.documents.put(userId, "preferences", snapshotId, {
      recordType: "capsule-snapshot", capsuleId, issuerId: identity.issuerId, status: "active", scopes, supersedes: input.supersedes ?? null,
      archiveSha256: digest(archive), manifestSha256: digest(JSON.stringify(container.manifest)), capsuleRevision: source.revision,
      entryCount: entries.length, sourceEntries: source.facts.map((fact, index) => ({ id: fact.id, revision: fact.revision, sha256: entries[index].sha256 })),
    }, { expectedRevision: 0 }); } catch (error) {
      await fs.unlink(path.join(directory, `${snapshotId}.evimedcap`));
      throw error;
    }
    return { filename: `capsule-${snapshotId}.evimedcap`, archive, snapshot: snapshotView(record) };
  }

  async history(userId, capsuleId, options = {}) {
    await this.capsules.get(userId, capsuleId);
    const page = await this.documents.list(userId, "preferences", { limit: 20, cursor: options.cursor, filter: { recordType: "capsule-snapshot", capsuleId } });
    return { items: page.items.map(snapshotView), nextCursor: page.nextCursor };
  }

  async snapshot(userId, capsuleId, snapshotId) {
    await this.capsules.get(userId, capsuleId);
    const record = await this.documents.get(userId, "preferences", snapshotId);
    if (!record || record.payload.recordType !== "capsule-snapshot" || record.payload.capsuleId !== capsuleId) throw new HttpError(404, "capsule_snapshot_not_found", "The snapshot is unavailable.");
    return record;
  }

  async download(userId, capsuleId, snapshotId) {
    const record = await this.snapshot(userId, capsuleId, snapshotId);
    if (record.payload.status === "revoked") throw new HttpError(409, "capsule_snapshot_revoked", "This hosted snapshot has been revoked.");
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
    const archive = await readProtectedCapsuleFile(directory, `${record.id}.evimedcap`, CAPSULE_TRANSFER_MAX_BYTES);
    if (!archive || digest(archive) !== record.payload.archiveSha256) throw new HttpError(503, "capsule_snapshot_unavailable", "The snapshot file is unavailable.");
    return { archive, filename: `capsule-${record.id}.evimedcap` };
  }

  async revoke(userId, capsuleId, snapshotId, expectedRevision) {
    const record = await this.snapshot(userId, capsuleId, snapshotId);
    return snapshotView(await this.documents.put(userId, "preferences", record.id, { ...record.payload, status: "revoked", revokedAt: new Date().toISOString() }, { expectedRevision }));
  }

  async preview(userId, input) {
    productId(userId); fields(input, ["archive", "password"]); checkedText(input.password, 1024);
    const { envelope, container, passwordWrap } = parseArchive(input.archive);
    const manifest = envelope.manifest;
    const known = await this.identities.resolve(manifest.issuer?.userId, manifest.issuer?.signingKeyId);
    const opened = await openCapsule(container, { issuer: { signingPublicKey: known?.publicKey ?? envelope.issuerPublicKey }, password: input.password, passwordWrap });
    if ("issues" in opened) throw new HttpError(opened.issues[0]?.code === "capsule_password_busy" ? 429 : 400, "capsule_transfer_open_failed", "The capsule could not be verified or decrypted.");
    const scopes = scopesOf(opened.manifest.scope);
    let metadata;
    try { metadata = JSON.parse(opened.entries["provenance.json"]); } catch { throw invalid(); }
    fields(metadata, ["format", "version", "snapshotId", "entries"]);
    if (metadata.format !== "evimed-capsule-transfer" || metadata.version !== 1 || !UUID.test(metadata.snapshotId) || metadata.snapshotId !== manifest.capsuleId
      || !Array.isArray(metadata.entries) || !metadata.entries.length || metadata.entries.length > MAX_ENTRIES) throw invalid();
    const ids = new Set();
    for (const entry of metadata.entries) {
      fields(entry, ["id", "version", "factKind", "layer", "content", "sha256", "path"]);
      if (!UUID.test(entry.id) || ids.has(entry.id) || !kindsFor(scopes).includes(entry.factKind)) throw invalid();
      ids.add(entry.id); productInteger(entry.version, 1, 2_147_483_647); checkedText(entry.content);
      const place = location(entry.factKind);
      if (entry.layer !== place.layer || entry.path !== (place.path ?? `methods/${entry.id}/SKILL.md`) || entry.sha256 !== digest(entry.content)) throw invalid();
    }
    const canonicalFiles = renderedFiles(metadata.snapshotId, metadata.entries);
    if (Object.keys(opened.entries).length !== Object.keys(canonicalFiles).length || Object.entries(canonicalFiles).some(([file, content]) => opened.entries[file] !== content)) throw invalid();
    const archiveSha256 = digest(input.archive);
    const hosted = known ? await this.documents.get(known.ownerId, "preferences", metadata.snapshotId) : null;
    if (hosted && (hosted.payload.recordType !== "capsule-snapshot" || hosted.payload.archiveSha256 !== archiveSha256)) throw invalid();
    const replacements = hosted ? await this.documents.list(known.ownerId, "preferences", { limit: 1, filter: { recordType: "capsule-snapshot", supersedes: metadata.snapshotId } }) : { items: [] };
    return { archiveSha256, snapshotId: metadata.snapshotId, scopes, entries: metadata.entries, newerSnapshotId: replacements.items[0]?.id ?? null,
      issuerTrust: known ? "verified" : "unverified", issuerId: manifest.issuer.userId,
      hostedStatus: hosted?.payload.status ?? "unknown", canImport: hosted?.payload.status !== "revoked", offlineRevocable: false };
  }

  async import(userId, input) {
    fields(input, ["archive", "password", "expectedDigest", "confirmed", "title"]);
    if (input.confirmed !== true) throw new HttpError(400, "capsule_import_confirmation_required", "Preview and explicitly confirm the capsule before importing.");
    if (input.expectedDigest !== digest(checkedText(input.archive, CAPSULE_TRANSFER_MAX_BYTES))) throw new HttpError(409, "capsule_preview_changed", "The archive changed after preview.");
    const preview = await this.preview(userId, { archive: input.archive, password: input.password });
    if (!preview.canImport) throw new HttpError(409, "capsule_snapshot_revoked", "This hosted snapshot has been revoked.");
    const capsuleId = randomUUID();
    // The only transaction starts after KDF and parsing have finished. All rows
    // are new, owned by this account, candidates and context-only.
    const records = await this.documents.createBatch(userId, [
      { kind: "capsule", id: capsuleId, payload: { title: checkedText(input.title ?? "Imported research capsule", 150), description: "Imported entries require explicit approval.", imported: true, activationMode: "guest",
        transfer: { snapshotId: preview.snapshotId, archiveSha256: preview.archiveSha256, issuerTrust: preview.issuerTrust } } },
      ...preview.entries.map(entry => ({ kind: "fact", id: randomUUID(), payload: {
        capsuleId, factKind: entry.factKind, layer: entry.layer, content: entry.content, origin: "system", status: "candidate", contextOnly: true,
        provenance: [{ type: "import", id: `${preview.snapshotId}:${entry.id}` }],
        transfer: { version: entry.version, sha256: entry.sha256, path: entry.path, snapshotId: preview.snapshotId, issuerTrust: preview.issuerTrust },
      } })),
    ]);
    return records[0];
  }
}
