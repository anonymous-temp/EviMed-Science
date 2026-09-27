import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CAPSULE_FACT_ORIGINS } from "@evimed/domain";
import { packCapsule, openCapsule, verifyCapsule } from "./capsuleContainer.mjs";
import { capsuleAccountHash, protectedCapsuleDirectory, readProtectedCapsuleFile, writeProtectedCapsuleFile, unlinkCapsuleFile, syncCapsuleDirectory } from "./capsuleIdentityStore.mjs";
import { CapsuleScanner } from "./capsuleScan.mjs";
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
/**
 * A learned method as shared text: its name, what it is for, and its body.
 * The recipient mounts it as a capsule method (`renderCapsuleMethod`), so the
 * sharer's frontmatter is not carried — its digest and learning counters
 * describe the sharer's library, not the recipient's.
 * @param {any} payload
 */
function learnedMethodText(payload) {
  const front = payload?.frontmatter ?? {};
  const head = [`# ${String(front.name ?? "method")}`, String(front.description ?? "").trim(),
    front.whenToUse ? `适用：${String(front.whenToUse).trim()}` : ""].filter(Boolean).join("\n\n");
  return `${head}\n\n${String(payload?.body ?? "").trim()}`.slice(0, 20_000);
}

/** What a pack's card may say, and how long each field may be. The card is
 *  plain text in the signed manifest: what a recipient reads before any entry
 *  (2026-09-26 audit, M-6: 「包卡片」 — a received pack was named by whoever
 *  imported it, 「收到的研究胶囊」, and said nothing of who sent it). */
const CARD_LIMITS = Object.freeze({ title: 150, author: 150, summary: 500, changelog: 2000 });

/** What each kind is called on a card. */
const CARD_KIND_LABELS = Object.freeze({
  method_preference: "做法", writing_style: "写作偏好", preference: "工作偏好", tooling: "工具习惯",
  profile: "个人背景", behavior: "工作习惯", expertise: "背景知识",
  project_fact: "项目事实", analysis: "分析", decision: "决定", stance: "立场", tension: "分歧", correction: "经验教训", follow_up: "待办",
});

/** One card field, trimmed and bounded, or absent. @param {unknown} value @param {number} max */
function cardText(value, max) {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.includes("\0")) throw invalid();
  const text = value.trim();
  if (text.length > max) throw invalid();
  return text || undefined;
}

/** A card as a manifest carries it; unknown fields are refused. @param {unknown} value */
export function capsuleCard(value) {
  if (value == null) return null;
  fields(value, Object.keys(CARD_LIMITS));
  const card = Object.fromEntries(Object.entries(CARD_LIMITS)
    .map(([name, max]) => [name, cardText(/** @type {any} */ (value)[name], max)])
    .filter(([, text]) => text !== undefined));
  return Object.keys(card).length ? card : null;
}

/** Latin text meets Chinese across a typed space (「cdss-access 的工作方式」). @param {string} left @param {string} right */
function joinZh(left, right) {
  return /[A-Za-z0-9]$/.test(left) ? `${left} ${right}` : `${left}${right}`;
}

/** What a pack holds, counted in the recipient's words: 「2 条做法、1 条工作偏好」. @param {readonly { factKind: string }[]} entries */
export function capsuleCardSummary(entries) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const entry of entries) {
    const label = CARD_KIND_LABELS[/** @type {keyof typeof CARD_KIND_LABELS} */ (entry.factKind)] ?? "其他内容";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // In the table's order, whatever order the entries were read in.
  const order = [...Object.values(CARD_KIND_LABELS), "其他内容"];
  return [...counts].sort(([left], [right]) => order.indexOf(left) - order.indexOf(right))
    .map(([label, count]) => `${count} 条${label}`).join("、");
}

/**
 * What changed since the snapshot a new one replaces, counted by content: an
 * entry is the same entry when its text is (ids are minted per export).
 * @param {readonly string[]} before the replaced snapshot's entry digests
 * @param {readonly string[]} after this snapshot's entry digests
 */
export function capsuleChangelog(before, after) {
  const earlier = new Set(before);
  const later = new Set(after);
  const added = [...later].filter((sha) => !earlier.has(sha)).length;
  const removed = [...earlier].filter((sha) => !later.has(sha)).length;
  const kept = [...later].filter((sha) => earlier.has(sha)).length;
  const parts = [...(added ? [`新增 ${added} 条`] : []), ...(removed ? [`移除 ${removed} 条`] : []), ...(kept ? [`保留 ${kept} 条`] : [])];
  return { added, removed, kept, text: parts.join("、") || "内容未变" };
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
  // A pack sealed only for named recipients carries no password wrap.
  const passwordWrap = envelope.passwordWrap === undefined ? null : decodeBase64(envelope.passwordWrap, 1086);
  return { envelope, container: { manifest: envelope.manifest, payload }, passwordWrap };
}
function snapshotView(record) {
  // Preserve version/digest evidence while omitting private local record identifiers.
  const { sourceEntries, capsuleId: _capsuleId, issuerId: _issuerId, recipients: _recipients, ...metadata } = record.payload;
  return { id: record.id, revision: record.revision, createdAt: record.createdAt, ...metadata,
    recipientCount: Array.isArray(record.payload.recipients) ? record.payload.recipients.length : 0,
    entryVersions: sourceEntries.map(entry => ({ version: entry.revision, sha256: entry.sha256 })) };
}

/** Portable snapshots are immutable ciphertext; online state can be revoked, offline copies cannot. */
export class CapsuleTransferService {
  /** @param {{documents: import('./productStore.mjs').ProductDocuments, capsules: import('./capsuleService.mjs').CapsuleService, identities: import('./capsuleIdentityStore.mjs').CapsuleIdentityStore, dataDir: string,
   *   scanner?: import('./capsuleScan.mjs').CapsuleScanner | null}} options */
  constructor({ documents, capsules, identities, dataDir, scanner = null }) {
    this.documents = documents; this.capsules = capsules; this.identities = identities; this.dataDir = dataDir;
    this.scanner = scanner;
    /** One scan per pack and account while a preview turns into an import. @type {Map<string, { at: number, result: any }>} */
    this.scans = new Map();
  }

  /**
   * The automatic scan of a pack's entries (`capsuleScan.mjs`), remembered for
   * half an hour so the preview the researcher read is the import they get,
   * without paying the model twice. A deployment without a scanner runs the
   * closed-set half only.
   * @param {string} userId @param {string | null} projectId @param {string} archiveSha256
   * @param {readonly { id: string, factKind: string, content: string }[]} entries
   */
  async scanned(userId, projectId, archiveSha256, entries) {
    const key = `${userId}\u0000${archiveSha256}`;
    const cached = this.scans.get(key);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.result;
    // No project, no ledger row to meter the language check against.
    const result = await (this.scanner ?? new CapsuleScanner({})).scan({ userId, projectId: projectId ?? "" }, entries, { useModel: Boolean(projectId) });
    if (this.scans.size >= 500) this.scans.delete(this.scans.keys().next().value);
    this.scans.set(key, { at: Date.now(), result });
    return result;
  }

  /**
   * What a pack of this capsule would carry, read in one snapshot of the
   * stores: the facts, learned methods and stated preferences `export` packs.
   * @param {string} userId @param {string} capsuleId @param {readonly string[]} kinds
   */
  async #assemble(userId, capsuleId, kinds) {
    return this.documents.database.transaction(async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const capsule = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' AND id=$2 AND deleted_at IS NULL", [productId(userId), productId(capsuleId)]);
      if (!capsule.rows[0]) throw new HttpError(404, "capsule_not_found", "The capsule is unavailable.");
      // A note a run wrote takes effect without anyone approving it, and the
      // researcher who never acted on it has not adopted it: the export promises
      // 「只分享已采用的研究方法与工作偏好 … 运行记录不会随包导出」. So an
      // `inferred` entry leaves only once the researcher's own act is on it —
      // they changed its status or corrected it, or it records their decision.
      // Before this, a note a page had talked a run into writing left in the
      // pack and was imported as the pack's own, mountable method (security
      // review 2026-09-20). What does leave carries its origin (below).
      const facts = await client.query(`SELECT id,revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND deleted_at IS NULL
        AND payload @> $2::jsonb AND payload->>'factKind'=ANY($3::text[]) AND payload->>'layer'<>'sources'
        AND (payload->>'origin' IS DISTINCT FROM 'inferred' OR payload->>'curatedAt' IS NOT NULL OR payload->>'correctedAt' IS NOT NULL
          OR payload->'provenance' @> '[{"type":"user"}]'::jsonb)
        ORDER BY id LIMIT 101`, [userId, JSON.stringify({ capsuleId, status: "approved" }), kinds]);
      // 「我是怎么干活的」 is assembled here from what the platform actually
      // holds (spec §19.15, build spec §9.1), not only from capsule entries: once
      // the authoring forms were deleted (2026-09-20) nothing an ordinary user
      // did produced one, and every export answered `capsule_export_empty`
      // while the researcher's learnt methods and stated preferences sat in two
      // other stores. So a pack also carries
      //   - every effective learned method, as the method it is; and
      //   - what the researcher said about how they work (`explicit` or edited
      //     by them, account-level, never sensitive).
      // Inferred notes still do not leave — the defence against a page talking
      // a run into writing one stands — and the recipient's import scans the
      // whole pack before any of it can mount.
      const methods = await client.query(`SELECT id,revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='method'
        AND deleted_at IS NULL AND payload->>'recordType'='learned-method' AND payload->>'status'='approved'
        ORDER BY updated_at DESC,id LIMIT 50`, [userId]);
      const stated = await client.query(`SELECT id,version,kind,value,summary FROM evimed_memory.records WHERE user_id=$1
        AND scope='user' AND status='active' AND NOT sensitive AND origin IN ('explicit','manual') AND kind=ANY($2::text[])
        ORDER BY updated_at DESC,id LIMIT 50`, [userId, kinds]);
      return { revision: capsule.rows[0].revision, facts: [
        ...facts.rows,
        ...methods.rows.map((row) => ({ id: row.id, revision: row.revision, payload: {
          factKind: "method_preference", origin: "system", content: learnedMethodText(row.payload) } })),
        ...stated.rows.map((row) => ({ id: row.id, revision: row.version, payload: {
          factKind: row.kind, origin: "explicit", content: String(row.summary || row.value) } })),
      ] };
    });
  }

  /**
   * The card a pack of this account carries: who sent it (the account's
   * display name, never its id), what it is called and what it holds, and —
   * for one that replaces an earlier snapshot — what changed. The sender may
   * name the title, summary and changelog; the author is the account's own.
   * @param {string} userId @param {readonly { factKind: string, sha256: string }[]} entries
   * @param {any} previous the snapshot record this one replaces, or null @param {any} requested
   */
  async #card(userId, entries, previous, requested) {
    const asked = capsuleCard(requested) ?? {};
    const name = String((await this.documents.database.query("SELECT name FROM evimed_control.users WHERE id=$1", [userId])).rows[0]?.name ?? "").trim();
    const author = name ? cardText(name.slice(0, CARD_LIMITS.author), CARD_LIMITS.author) : undefined;
    const changes = previous
      ? capsuleChangelog((previous.payload.sourceEntries ?? []).map((/** @type {any} */ entry) => entry.sha256), entries.map((entry) => entry.sha256))
      : null;
    return capsuleCard({
      title: asked.title ?? (author ? joinZh(author, "的工作方式") : "分享的工作方式"),
      ...(author ? { author } : {}),
      summary: asked.summary ?? capsuleCardSummary(entries),
      ...(asked.changelog ?? changes?.text ? { changelog: asked.changelog ?? changes?.text } : {}),
    });
  }

  /**
   * The X25519 keys of the accounts a pack is sealed for (build spec §9.2):
   * each named account on this deployment can open it with its own key, and
   * nobody needs the password. An account that does not exist is refused by
   * name rather than silently left out of a pack its sender thinks it reaches.
   * @param {unknown} recipients @param {string} sender
   */
  async #recipientKeys(recipients, sender) {
    if (recipients == null) return [];
    if (!Array.isArray(recipients) || recipients.length > 32 || recipients.some((id) => typeof id !== "string" || !id.trim())) throw invalid();
    const ids = [...new Set(recipients.map((id) => id.trim()))].filter((id) => id !== sender);
    const keys = [];
    for (const id of ids) {
      productId(id, "user");
      const exists = await this.documents.database.query("SELECT 1 FROM evimed_control.users WHERE id=$1", [id]);
      if (exists.rowCount !== 1) throw new HttpError(400, "capsule_recipient_unknown", "A named recipient is not an account on this deployment.");
      const identity = await this.withAccount(id, null, () => this.identities.forUser(id));
      if (!identity?.encryption?.keyId || !identity.encryption.publicKey) throw new HttpError(503, "capsule_identity_unavailable", "A recipient key is unavailable.");
      keys.push({ userId: id, encKeyId: identity.encryption.keyId, publicKey: identity.encryption.publicKey });
    }
    return keys;
  }

  /**
   * 「对方会看到什么」: the pack as its recipient would read it, before any
   * password is chosen — the card, and every entry that would leave. An
   * account with nothing to share hears it here as a state, not as a refused
   * export (2026-09-26 audit, M-6: the owner's own account had no learned
   * method and no stated preference, and 加密导出 answered 400).
   * @param {string} userId @param {string} capsuleId @param {any} input
   */
  async exportPreview(userId, capsuleId, input = {}) {
    fields(input, ["scopes", "supersedes", "card"]);
    const scopes = scopesOf(input.scopes ?? undefined);
    await this.capsules.get(userId, capsuleId);
    const previous = input.supersedes != null ? await this.snapshot(userId, capsuleId, input.supersedes) : null;
    const source = await this.#assemble(userId, capsuleId, kindsFor(scopes));
    const entries = source.facts.slice(0, MAX_ENTRIES).map((fact) => {
      const content = String(fact.payload.content ?? "");
      return { factKind: fact.payload.factKind, layer: location(fact.payload.factKind).layer, content, sha256: digest(content),
        origin: CAPSULE_FACT_ORIGINS.includes(fact.payload.origin) ? fact.payload.origin : "inferred" };
    });
    return {
      scopes, empty: entries.length === 0, tooMany: source.facts.length > MAX_ENTRIES,
      card: entries.length ? await this.#card(userId, entries, previous, input.card) : null,
      entries: entries.map(({ sha256: _sha256, ...entry }) => entry),
    };
  }

  async export(userId, capsuleId, input, options = {}) {
    fields(input, ["password", "scopes", "supersedes", "recipients", "card"]);
    if (input.password !== undefined) checkedText(input.password, 1024);
    const accountCreatedAt = await this.withAccount(userId, options.accountCreatedAt ?? null);
    const previous = input.supersedes != null ? await this.snapshot(userId, capsuleId, input.supersedes) : null;
    const scopes = scopesOf(input.scopes); const kinds = kindsFor(scopes);
    await this.capsules.get(userId, capsuleId);
    const recipients = await this.#recipientKeys(input.recipients, userId);
    // Sealed for a password, for named accounts, or both; never for nobody.
    if (input.password === undefined && recipients.length === 0) throw invalid();
    const source = await this.#assemble(userId, capsuleId, kinds);
    if (!source.facts.length) throw new HttpError(409, "capsule_export_empty", "No approved entries are eligible for these share scopes.");
    if (source.facts.length > MAX_ENTRIES) throw new HttpError(413, "capsule_transfer_too_large", "A snapshot supports at most 100 approved entries.");
    const snapshotId = randomUUID();
    const entries = source.facts.map(fact => {
      const id = randomUUID(); const place = location(fact.payload.factKind); const content = checkedText(fact.payload.content);
      return { id, version: fact.revision, factKind: fact.payload.factKind, layer: place.layer, content, sha256: digest(content), path: place.path ?? `methods/${id}/SKILL.md`,
        origin: CAPSULE_FACT_ORIGINS.includes(fact.payload.origin) ? fact.payload.origin : "inferred" };
    });
    const card = await this.#card(userId, entries, previous, input.card);
    const files = renderedFiles(snapshotId, entries);
    const identity = await this.withAccount(userId, accountCreatedAt, () => this.identities.forUser(userId, { accountCreatedAt }));
    const container = await packCapsule({ capsuleId: snapshotId, version: source.revision, createdAt: new Date().toISOString(),
      issuer: { userId: identity.issuerId, signingKeyId: identity.signing.keyId, signingPrivateKey: identity.signing.privateKey },
      scope: scopes, layers: [...new Set([...entries.map(entry => entry.layer), "methods"])],
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(recipients.length ? { recipients: recipients.map(({ encKeyId, publicKey }) => ({ encKeyId, publicKey })) } : {}),
      // The version chain (build spec §9.2): what an importer that holds the
      // replaced snapshot upgrades in place.
      prevManifestSha256: previous?.payload.manifestSha256 ?? null,
      ...(card ? { card } : {}),
      entries: Object.entries(files).map(([file, content]) => ({ path: file, content,
        mime: file.endsWith(".json") ? "application/json" : file.endsWith(".jsonl") ? "application/x-ndjson" : "text/markdown",
        layer: file === "provenance.json" ? "methods" : entries.find(entry => entry.path === file).layer })),
    });
    const archive = JSON.stringify({ format: "evimedcap", version: 1, manifest: container.manifest, issuerPublicKey: identity.signing.publicKey,
      ...(container.passwordWrap ? { passwordWrap: container.passwordWrap.toString("base64") } : {}),
      payload: Object.fromEntries(Object.entries(container.payload).map(([file, bytes]) => [file, bytes.toString("base64")])) });
    if (Buffer.byteLength(archive) > CAPSULE_TRANSFER_MAX_BYTES) throw new HttpError(413, "capsule_transfer_too_large", "This encrypted snapshot exceeds 2 MiB.");
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
    const filename = `${capsuleAccountHash(userId)}-${snapshotId}.evimedcap`;
    await this.withAccount(userId, accountCreatedAt, () => writeProtectedCapsuleFile(directory, filename, archive));
    let record;
    try { [record] = await this.documents.createBatch(userId, [{ kind: "preferences", id: snapshotId, payload: {
      recordType: "capsule-snapshot", capsuleId, issuerId: identity.issuerId, status: "active", scopes, supersedes: input.supersedes ?? null,
      archiveSha256: digest(archive), manifestSha256: digest(JSON.stringify(container.manifest)), capsuleRevision: source.revision,
      entryCount: entries.length, sourceEntries: source.facts.map((fact, index) => ({ id: fact.id, revision: fact.revision, sha256: entries[index].sha256 })),
      ...(card ? { card } : {}), ...(recipients.length ? { recipients: recipients.map((recipient) => recipient.userId) } : {}),
    } }], { accountCreatedAt }); } catch (error) {
      await unlinkCapsuleFile(directory, filename);
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
    const archive = await readProtectedCapsuleFile(directory, `${capsuleAccountHash(userId)}-${record.id}.evimedcap`, CAPSULE_TRANSFER_MAX_BYTES)
      ?? await readProtectedCapsuleFile(directory, `${record.id}.evimedcap`, CAPSULE_TRANSFER_MAX_BYTES);
    if (!archive || digest(archive) !== record.payload.archiveSha256) throw new HttpError(503, "capsule_snapshot_unavailable", "The snapshot file is unavailable.");
    return { archive, filename: `capsule-${record.id}.evimedcap` };
  }

  async revoke(userId, capsuleId, snapshotId, expectedRevision) {
    const record = await this.snapshot(userId, capsuleId, snapshotId);
    return snapshotView(await this.documents.put(userId, "preferences", record.id, { ...record.payload, status: "revoked", revokedAt: new Date().toISOString() }, { expectedRevision }));
  }

  async preview(userId, input, options = {}) { return (await this.inspect(userId, input, options)).preview; }

  async inspect(userId, input, options = {}) {
    const accountCreatedAt = await this.withAccount(userId, options.accountCreatedAt ?? null);
    productId(userId); fields(input, ["archive", "password"]);
    if (input.password !== undefined) checkedText(input.password, 1024);
    const { envelope, container, passwordWrap } = parseArchive(input.archive);
    const manifest = envelope.manifest;
    const beforeKdf = await this.identities.resolve(manifest.issuer?.userId, manifest.issuer?.signingKeyId);
    // A pack sealed for this account opens with its own key; any other needs
    // the password its sender chose.
    const own = await this.withAccount(userId, accountCreatedAt, () => this.identities.forUser(userId, { accountCreatedAt }));
    const addressed = Array.isArray(manifest.encryption?.recipients)
      && manifest.encryption.recipients.some((/** @type {any} */ entry) => entry?.encKeyId === own?.encryption?.keyId);
    if (!addressed && input.password === undefined) throw new HttpError(400, "capsule_password_required", "This capsule needs the password its sender chose.");
    const keys = addressed
      ? { recipient: { encKeyId: own.encryption.keyId, privateKey: own.encryption.privateKey, publicKey: own.encryption.publicKey } }
      : { password: input.password, passwordWrap: passwordWrap ?? undefined };
    const opened = await openCapsule(container, { issuer: { signingPublicKey: beforeKdf?.publicKey ?? envelope.issuerPublicKey }, ...keys });
    if ("issues" in opened) throw new HttpError(opened.issues[0]?.code === "capsule_password_busy" ? 429 : 400, "capsule_transfer_open_failed", "The capsule could not be verified or decrypted.");
    // KDF can outlive account deletion. Refresh the issuer and retain any prior
    // local classification; disappearance must never grant foreign-import fallback.
    const currentIssuer = await this.identities.resolve(manifest.issuer?.userId, manifest.issuer?.signingKeyId);
    const known = currentIssuer ?? beforeKdf;
    if (currentIssuer && !verifyCapsule(container, { signingPublicKey: currentIssuer.publicKey }).ok) throw invalid();
    const scopes = scopesOf(opened.manifest.scope);
    let metadata;
    try { metadata = JSON.parse(opened.entries["provenance.json"]); } catch { throw invalid(); }
    fields(metadata, ["format", "version", "snapshotId", "entries"]);
    if (metadata.format !== "evimed-capsule-transfer" || metadata.version !== 1 || !UUID.test(metadata.snapshotId) || metadata.snapshotId !== manifest.capsuleId
      || !Array.isArray(metadata.entries) || !metadata.entries.length || metadata.entries.length > MAX_ENTRIES) throw invalid();
    const ids = new Set();
    for (const entry of metadata.entries) {
      // `origin` since 2026-09-20; a pack exported before carries none.
      fields(entry, ["id", "version", "factKind", "layer", "content", "sha256", "path", "origin"]);
      if (entry.origin !== undefined && !CAPSULE_FACT_ORIGINS.includes(entry.origin)) throw invalid();
      if (!UUID.test(entry.id) || ids.has(entry.id) || !kindsFor(scopes).includes(entry.factKind)) throw invalid();
      ids.add(entry.id); productInteger(entry.version, 1, 2_147_483_647); checkedText(entry.content);
      const place = location(entry.factKind);
      if (entry.layer !== place.layer || entry.path !== (place.path ?? `methods/${entry.id}/SKILL.md`) || entry.sha256 !== digest(entry.content)) throw invalid();
    }
    const canonicalFiles = renderedFiles(metadata.snapshotId, metadata.entries);
    if (Object.keys(opened.entries).length !== Object.keys(canonicalFiles).length || Object.entries(canonicalFiles).some(([file, content]) => opened.entries[file] !== content)) throw invalid();
    const archiveSha256 = digest(input.archive);
    const hosted = known && !known.revoked ? await this.documents.get(known.ownerId, "preferences", metadata.snapshotId) : null;
    const sourceAccountPresent = known && !known.revoked ? (await this.documents.database.query("SELECT 1 FROM evimed_control.users WHERE id=$1", [known.ownerId])).rowCount === 1 : false;
    if (hosted && (hosted.payload.recordType !== "capsule-snapshot" || hosted.payload.archiveSha256 !== archiveSha256)) throw invalid();
    const replacements = hosted ? await this.documents.list(known.ownerId, "preferences", { limit: 1, filter: { recordType: "capsule-snapshot", supersedes: metadata.snapshotId } }) : { items: [] };
    // Whole-pack trust with an automatic scan (plan §3.3 #4): what would be
    // dropped is part of what the researcher previews.
    const scan = await this.scanned(userId, options.projectId ?? null, archiveSha256, metadata.entries);
    let card = null;
    try { card = capsuleCard(manifest.card); } catch { throw invalid(); }
    const manifestSha256 = digest(JSON.stringify(manifest));
    const upgrade = await this.#upgradeTarget(userId, manifest, metadata.entries);
    const preview = { archiveSha256, manifestSha256, snapshotId: metadata.snapshotId, scopes, entries: metadata.entries, newerSnapshotId: replacements.items[0]?.id ?? null, scan,
      card, upgrades: upgrade ? upgrade.view : null,
      issuerTrust: known ? "verified" : "unverified", issuerId: manifest.issuer.userId,
      hostedStatus: known && (known.revoked || !sourceAccountPresent) ? "revoked" : hosted?.payload.status ?? (known ? "unavailable" : "unknown"),
      canImport: !known || Boolean(currentIssuer && !currentIssuer.revoked && sourceAccountPresent && hosted?.payload.status === "active"), offlineRevocable: false };
    if (!preview.canImport) preview.entries = [];
    const guards = known?.ownerId ? [{ userId: known.ownerId, kind: "preferences", id: metadata.snapshotId, filter: { status: "active", archiveSha256 } }] : [];
    return { preview, guards, accountCreatedAt, upgrade };
  }

  /**
   * The received pack this one continues, when the account holds it: the same
   * issuer, and a manifest whose version chain names the one it was imported
   * from. What changed is counted by content, since ids are minted per export.
   * @param {string} userId @param {any} manifest @param {readonly any[]} entries
   */
  async #upgradeTarget(userId, manifest, entries) {
    if (typeof manifest.prevManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.prevManifestSha256)) return null;
    const received = await this.documents.list(userId, "capsule", { limit: 100,
      filter: { imported: true, transfer: { manifestSha256: manifest.prevManifestSha256, issuerId: manifest.issuer.userId } } });
    const capsule = received.items[0];
    if (!capsule) return null;
    const facts = (await this.documents.list(userId, "fact", { limit: 100, filter: { capsuleId: capsule.id } })).items
      .filter((/** @type {any} */ fact) => fact.payload.status !== "retired" && fact.payload.transfer?.sha256);
    const changes = capsuleChangelog(facts.map((/** @type {any} */ fact) => fact.payload.transfer.sha256), entries.map((entry) => entry.sha256));
    return { capsule, facts, view: { capsuleId: capsule.id, title: capsule.payload.title, added: changes.added, removed: changes.removed, kept: changes.kept } };
  }

  async import(userId, input, options = {}) {
    fields(input, ["archive", "password", "expectedDigest", "confirmed", "title"]);
    if (input.confirmed !== true) throw new HttpError(400, "capsule_import_confirmation_required", "Preview and explicitly confirm the capsule before importing.");
    if (input.expectedDigest !== digest(checkedText(input.archive, CAPSULE_TRANSFER_MAX_BYTES))) throw new HttpError(409, "capsule_preview_changed", "The archive changed after preview.");
    const { preview, guards, accountCreatedAt, upgrade } = await this.inspect(userId,
      { archive: input.archive, ...(input.password !== undefined ? { password: input.password } : {}) }, options);
    if (!preview.canImport) throw new HttpError(409, "capsule_snapshot_revoked", "This hosted snapshot has been revoked.");
    if (upgrade) return this.#upgrade(userId, preview, upgrade, guards);
    const capsuleId = randomUUID();
    // The only transaction starts after KDF and parsing have finished. All rows
    // are new, owned by this account and context-only. The pack is trusted as
    // a whole: what the scan let through is in force the moment the pack is
    // enabled, and what it flagged is not written at all — it is listed on the
    // pack instead. Nothing is enabled by importing it.
    const kept = new Set(preview.scan.kept);
    // What no model verdict covered is context, not a method, until a later
    // scan judges it (`capsuleScan.mjs`, `CapsuleService.#scannedPack`). A
    // scanner that does not list it is read by its model status: anything
    // short of "ok" leaves every kept entry unjudged.
    const unchecked = new Set(Array.isArray(preview.scan.unchecked) ? preview.scan.unchecked
      : preview.scan.model === "ok" ? [] : preview.scan.kept);
    // A toxic herb's dose above its bound stays context (`capsuleScan.mjs`).
    const held = new Set(Array.isArray(preview.scan.held) ? preview.scan.held : []);
    let records;
    try { records = await this.documents.createBatch(userId, [
      { kind: "capsule", id: capsuleId, payload: { title: checkedText(input.title ?? preview.card?.title ?? "收到的研究胶囊", 150), description: "别人分享的胶囊：整包生效，随时停用。", imported: true, activationMode: "guest",
        transfer: { snapshotId: preview.snapshotId, archiveSha256: preview.archiveSha256, manifestSha256: preview.manifestSha256, issuerId: preview.issuerId,
          issuerTrust: preview.issuerTrust, importedAt: new Date().toISOString() },
        ...(preview.card ? { card: preview.card } : {}),
        scan: preview.scan } },
      ...preview.entries.filter(entry => kept.has(entry.id)).map(entry => ({ kind: "fact", id: randomUUID(), payload: {
        // The sharer's runtime note stays the assistant's note here, and so is
        // never mounted (`capsuleMethods.mjs`); only what a person wrote or a
        // pack brought becomes this pack's own. A pack exported before origins
        // travelled could hold only entries its sharer had approved by hand.
        capsuleId, factKind: entry.factKind, layer: entry.layer, content: entry.content, origin: entry.origin === "inferred" ? "inferred" : "system",
        status: "approved", contextOnly: true, ...(unchecked.has(entry.id) ? { unscanned: true } : {}),
        ...(held.has(entry.id) ? { safetyHold: true } : {}),
        provenance: [{ type: "import", id: `${preview.snapshotId}:${entry.id}` }],
        transfer: { version: entry.version, sha256: entry.sha256, path: entry.path, snapshotId: preview.snapshotId, issuerTrust: preview.issuerTrust },
      } })),
    ], { guards, accountCreatedAt }); } catch (error) {
      if (error.code === "product_guard_conflict") throw new HttpError(409, "capsule_snapshot_revoked", "The hosted snapshot was revoked or changed before import.");
      throw error;
    }
    return records[0];
  }

  /**
   * Take a newer snapshot of a pack the account holds in place: the same
   * capsule, so whether and where it is in force does not change; its card,
   * transfer record and scan move to the new snapshot; the entries the new
   * snapshot no longer carries are retired, and what it carries is written as
   * this pack's. One transaction, so no reader sees both or neither.
   * @param {string} userId @param {any} preview @param {any} upgrade @param {readonly any[]} guards
   */
  async #upgrade(userId, preview, upgrade, guards) {
    const kept = new Set(preview.scan.kept);
    const unchecked = new Set(Array.isArray(preview.scan.unchecked) ? preview.scan.unchecked : preview.scan.model === "ok" ? [] : preview.scan.kept);
    const held = new Set(Array.isArray(preview.scan.held) ? preview.scan.held : []);
    const at = new Date().toISOString();
    try {
      return await this.documents.database.transaction(async (/** @type {any} */ client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${productId(userId)}`]);
        for (const guard of guards) {
          const source = await client.query(`SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind=$2 AND id=$3
            AND deleted_at IS NULL AND payload @> $4::jsonb FOR SHARE`, [guard.userId, guard.kind, guard.id, JSON.stringify(guard.filter)]);
          if (source.rowCount !== 1) throw new HttpError(409, "capsule_snapshot_revoked", "The hosted snapshot was revoked or changed before import.");
        }
        for (const fact of upgrade.facts) {
          await this.documents.put(userId, "fact", fact.id, { ...fact.payload, status: "retired", retiredBy: { type: "upgrade", snapshotId: preview.snapshotId, at } },
            { expectedRevision: fact.revision, transactionClient: client });
        }
        for (const entry of preview.entries.filter((/** @type {any} */ item) => kept.has(item.id))) {
          await this.documents.put(userId, "fact", randomUUID(), {
            capsuleId: upgrade.capsule.id, factKind: entry.factKind, layer: entry.layer, content: entry.content,
            origin: entry.origin === "inferred" ? "inferred" : "system", status: "approved", contextOnly: true,
            ...(unchecked.has(entry.id) ? { unscanned: true } : {}), ...(held.has(entry.id) ? { safetyHold: true } : {}),
            provenance: [{ type: "import", id: `${preview.snapshotId}:${entry.id}` }],
            transfer: { version: entry.version, sha256: entry.sha256, path: entry.path, snapshotId: preview.snapshotId, issuerTrust: preview.issuerTrust },
          }, { expectedRevision: 0, transactionClient: client });
        }
        return this.documents.put(userId, "capsule", upgrade.capsule.id, {
          ...upgrade.capsule.payload,
          transfer: { ...upgrade.capsule.payload.transfer, snapshotId: preview.snapshotId, archiveSha256: preview.archiveSha256,
            manifestSha256: preview.manifestSha256, issuerId: preview.issuerId, issuerTrust: preview.issuerTrust, upgradedAt: at,
            previousSnapshotId: upgrade.capsule.payload.transfer?.snapshotId ?? null },
          ...(preview.card ? { card: preview.card } : {}),
          scan: preview.scan,
        }, { expectedRevision: upgrade.capsule.revision, transactionClient: client });
      });
    } catch (error) {
      if (error?.code === "product_revision_conflict") throw new HttpError(409, "capsule_preview_changed", "The received capsule changed before the upgrade completed.");
      throw error;
    }
  }

  /** File publication only holds the same short lock as account deletion; never perform KDF inside it. */
  async withAccount(userId, expectedCreatedAt = null, operation = null) {
    return this.documents.database.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${productId(userId)}`]);
      const row = (await client.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId])).rows[0];
      if (!row || (expectedCreatedAt !== null && row.generation !== expectedCreatedAt)) throw new HttpError(409, "product_account_changed", "The account changed before this operation completed.");
      await this.identities.assertAccountActive(userId, row.generation);
      return operation ? operation() : row.generation;
    });
  }

  /** Runs inside PostgresStore.deleteUser's account lock before its DELETE commits. */
  async prepareAccountDeletion(userId, client) {
    const row = (await client.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId])).rows[0];
    if (!row) return;
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
    // Adopt old flat filenames before their ownership rows are cascaded away.
    const snapshots = await client.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='preferences' AND payload->>'recordType'='capsule-snapshot'", [userId]);
    for (const snapshot of snapshots.rows) {
      if (!UUID.test(snapshot.id)) throw invalid();
      await fs.rename(path.join(directory, `${snapshot.id}.evimedcap`), path.join(directory, `${capsuleAccountHash(userId)}-${snapshot.id}.evimedcap`)).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    await syncCapsuleDirectory(directory);
    await this.identities.prepareDeletion(userId, row.generation);
  }

  async finishAccountDeletion(userId) {
    try {
      return await this.documents.database.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${productId(userId)}`]);
        const state = await this.identities.deletionState(userId);
        if (!state || state.phase === "completed") return { completed: true };
        const live = (await client.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId])).rows[0];
        // DB rollback leaves the original live account and its private keys intact.
        if (live?.generation === state.accountCreatedAt) return { completed: false, awaitingAccountDeletion: true };
        const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
        const files = await fs.opendir(directory);
        for await (const file of files) {
          if (file.name.startsWith(`${capsuleAccountHash(userId)}-`) && /\.evimedcap(?:\.[a-f0-9-]{36}\.tmp)?$/.test(file.name)) await unlinkCapsuleFile(directory, file.name);
        }
        await syncCapsuleDirectory(directory);
        await this.identities.finishDeletion(userId, state);
        return { completed: true };
      });
    } catch { throw new HttpError(503, "capsule_cleanup_pending", "The account is removed, but protected capsule cleanup must be retried."); }
  }

  /** Durable post-commit cleanup resumes after restart; failures remain pending for the next attempt. */
  async recoverPendingDeletions() {
    const results = { completed: 0, pending: 0 };
    for (const userId of await this.identities.pendingDeletions()) {
      try { const result = await this.finishAccountDeletion(userId); results[result.completed ? "completed" : "pending"]++; }
      catch { results.pending++; }
    }
    return results;
  }

}

// The container layout an import accepts, byte for byte, for the one other
// producer of packs: `scripts/ops/pack-lineage-capsule.mjs`. A copy of these two
// functions there would be a second definition of what `inspect` compares
// against, and the first change to either would make every lineage pack
// unimportable without a test noticing.
export { location as capsuleTransferLocation, renderedFiles as renderCapsuleTransferFiles };
