import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CAPSULE_FACT_ORIGINS, cleanMethodDisplay } from "@evimed/domain";
import { packCapsule, openCapsule, verifyCapsule } from "./capsuleContainer.mjs";
import { capsuleAccountHash, protectedCapsuleDirectory, readProtectedCapsuleFile, writeProtectedCapsuleFile, unlinkCapsuleFile, syncCapsuleDirectory } from "./capsuleIdentityStore.mjs";
import { buildAgentSkillsPack } from "./capsuleMethodPack.mjs";
import { senderDisplayName, shareSignature } from "./capsuleShareLabel.mjs";
import { guestMarkedRuns } from "./capsuleShareTrust.mjs";
import { CapsuleScanner } from "./capsuleScan.mjs";
import { SCAN_METER_PROJECT } from "./capsuleService.mjs";
import { nativeMemoryFile, PROJECT_MEMORY_TYPES } from "./openVikingSessions.mjs";
import { nativeMemoryRoot } from "./openVikingLayout.mjs";
import { LEGACY_KIND_OF_TYPE, SOURCE_LABEL_PREFIX, versionOfHash } from "./nativeMemoryStore.mjs";
import { flatStatement, MIGRATED_KINDS, replayedForm } from "./nativeMemoryMigration.mjs";
import { reachableAccounts } from "./capsuleRecipients.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { boundedText } from "./researchMemory.mjs";
import { migrateResearchMemory } from "./researchMemoryPersistence.mjs";
import { HttpError } from "./security.mjs";
import { productId, productInteger } from "./productPersistence.mjs";
import { recordAccountCleanup, recordKdfRefused, recordShareImported, recordShareRefused, recordShared, recordSnapshotFile } from "./capsuleShareMetrics.mjs";

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
/**
 * Entries the sender unticked, by the ids the preview gave them (`fact:`, `method:`, `record:` or `native:` and the source's own id).
 * An id that matches nothing any more is not an error: what is left out is what the sender looked at, and the pack changes under them.
 * @param {unknown} value @returns {Set<string>}
 */
function excludedIds(value) {
  if (value == null) return new Set();
  if (!Array.isArray(value) || value.length > 500 || value.some((id) => typeof id !== "string" || id.length > 100 || !/^(?:fact|method|record|native):\S+$/.test(id))) throw invalid();
  return new Set(value);
}

/**
 * Why a kind of entry is not in the pack, said to the sender in one plain sentence each (no back-office words: what the platform
 * calls an entry's origin is not what a person calls it). The sentence carries its count.
 * @type {Record<"inferred" | "document" | "sensitive" | "received" | "unconfirmed" | "paused", (count: number) => string>}
 */
const EXCLUDED_TEXT = Object.freeze({
  inferred: (count) => `助手替你记下、你还没有确认或改过的 ${count} 条内容没有放进来。`,
  document: (count) => `从你上传的资料里整理出来的 ${count} 条内容没有放进来。`,
  sensitive: (count) => `你标为敏感的 ${count} 条内容没有放进来。`,
  received: (count) => `别人分享给你的 ${count} 条内容不会再转发。`,
  unconfirmed: (count) => `从旧记忆整理过来、没法确认是你原话的 ${count} 条内容没有放进来。`,
  paused: (count) => `你暂停了记忆的项目里的 ${count} 条内容没有放进来。`,
});

/** The statements of a memory file's body: its lines without headings and the platform's own label lines. @param {string} body */
function statementLines(body) {
  return String(body ?? "").split("\n").map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(SOURCE_LABEL_PREFIX.trim()));
}

/**
 * Whether a file the migration replay touched says only what the person said before the migration: every statement of its body is
 * (in the form the replay wrote it) a legacy record of theirs that they stated or edited themselves. The replay also carried the
 * records an assistant had inferred, and the engine may have worded or merged what it was told, so a body that holds anything else
 * is not their statement and stays out.
 * @param {string} body @param {ReadonlySet<string>} legacy `replayedForm` of each statement of the person's own
 */
function bodyIsOwnLegacyStatement(body, legacy) {
  const lines = statementLines(body);
  if (!lines.length) return false;
  return legacy.has(lines.map(flatStatement).join(" ")) || lines.every((line) => legacy.has(flatStatement(line)));
}

function location(kind) {
  return kind === "method_preference" ? { layer: "methods", path: null }
    : WORKSTYLE.includes(kind) ? { layer: "profile", path: "standards.jsonl" }
      : PROFILE.includes(kind) ? { layer: "profile", path: "profile.md" } : { layer: "knowledge", path: "knowledge/chunks.jsonl" };
}

/**
 * What a shared pack may carry, entry by entry: the text files `renderedFiles` writes and nothing else (plan §7, 2026-10-05).
 * Between users only methods travel, and only as text: never a script from a skill's `scripts/` directory, never an
 * attachment, never a tool definition. The container's own safety check (`checkImportSafety`) already refuses executable
 * formats and a method directory holding anything but a `SKILL.md`; this is the same property stated once for the share —
 * every entry the manifest declares is one of the five files an export produces, with the MIME type that file has, and
 * the payload holds no entry the manifest does not declare — so a pack that carries more is refused by name before any
 * key is derived, any entry decrypted or any scan paid for.
 */
const SHARE_FILES = Object.freeze({ "standards.jsonl": "application/x-ndjson", "profile.md": "text/markdown", "knowledge/chunks.jsonl": "application/x-ndjson", "provenance.json": "application/json" });
const SHARE_METHOD_PATH = /^methods\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/SKILL\.md$/;
/** @param {string} filePath @returns {string | null} the MIME type the share gives that file, or null when it is not one of them */
function shareMimeOf(filePath) {
  if (Object.hasOwn(SHARE_FILES, filePath)) return /** @type {Record<string, string>} */ (SHARE_FILES)[filePath];
  return SHARE_METHOD_PATH.test(filePath) ? "text/markdown" : null;
}
const notTextOnly = () => {
  recordShareRefused("not_text_only");
  return new HttpError(400, "capsule_share_not_text_only", "The shared pack carries more than text.");
};

/**
 * The most live (not revoked) snapshots one account keeps: each is a file of up to 2 MiB that stays on the disk until it is revoked.
 * This is the default; the deployment's is `OPEN_SCIENCE_CAPSULE_MAX_LIVE_SNAPSHOTS` (review C4e), handed in as `maxLiveSnapshots`.
 */
export const MAX_LIVE_SNAPSHOTS = 300;
/** How long a snapshot file may sit without a record before it is taken for a crashed write's leftover, not one being written. */
const SNAPSHOT_FILE_GRACE_MS = 60 * 60_000;
/** The most files one sweep looks at: a valve against a directory that has run away, not a schedule (a normal one holds far fewer). */
const SNAPSHOT_SWEEP_FILES = 20_000;
/** The file names a sweep may touch: `<account hash>-<snapshot id>.evimedcap`, the flat `<snapshot id>.evimedcap` older builds wrote, and a write's temporary copy. */
const SNAPSHOT_FILE = /^(?:([a-f0-9]{64})-)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.evimedcap(\.[a-f0-9-]{36}\.tmp)?$/;

/** What went wrong, as a short code an audit line and a counter can carry: the error's own code, else its name. @param {any} error */
function causeCode(error) {
  const cause = error?.cause ?? error;
  const code = typeof cause?.code === "string" && cause.code ? cause.code : typeof cause?.name === "string" && cause.name ? cause.name : "unknown";
  return code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

/**
 * What a refused or unrunnable password derivation is to the person who asked: a named answer instead of a failure that reads
 * as a wrong password or as the server breaking. Null for anything else.
 * @param {{ code?: unknown, reason?: unknown } | null | undefined} cause
 */
function kdfRefusalOf(cause) {
  if (cause?.code === "capsule_password_busy") {
    recordKdfRefused(String(cause.reason ?? "account_busy"));
    return new HttpError(429, "capsule_password_busy", "Capsule password operations are busy; try again shortly.", { retryAfterSeconds: 2 });
  }
  if (cause?.code === "capsule_password_params_unsupported") {
    recordKdfRefused("params_unsupported");
    return new HttpError(400, "capsule_password_params_unsupported", "The capsule's password key derivation is not one this platform writes.");
  }
  return null;
}
/** @param {any} manifest @param {readonly string[]} payloadPaths */
function assertShareTextOnly(manifest, payloadPaths) {
  if (!Array.isArray(manifest?.entries)) throw invalid();
  const declared = new Set();
  for (const entry of manifest.entries) {
    const mime = typeof entry?.path === "string" ? shareMimeOf(entry.path) : null;
    if (mime === null || entry.mime !== mime || declared.has(entry.path)) throw notTextOnly();
    declared.add(entry.path);
  }
  for (const name of payloadPaths) if (!declared.has(name)) throw notTextOnly();
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
 *
 * The heading and the paragraph under it are the method in the researcher's
 * words (`display`) when it has them: they are what the sender's preview, the
 * recipient's preview and its shelf show of a method, and the name and
 * description written for the model follow them with the body (2026-10-12:
 * every preview read `# claim-verdict-audit` and an English SKILL body).
 * @param {any} payload
 */
function learnedMethodText(payload) {
  const front = payload?.frontmatter ?? {};
  const display = cleanMethodDisplay(payload?.display);
  const head = [`# ${display?.title || String(front.name ?? "method")}`, display?.summary ?? "", String(front.description ?? "").trim(),
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

/**
 * The learned methods of an account that may leave it: not one learned in a run marked as having used an uncorroborated guest capsule.
 * @param {{ query: Function }} client @param {string} userId @param {any[]} rows
 */
async function exportableMethods(client, userId, rows) {
  const runIds = [...new Set(rows.map((row) => row.payload?.provenance?.runId).filter((id) => typeof id === "string" && id))];
  const marked = await guestMarkedRuns(client, userId, runIds);
  return marked.size ? rows.filter((row) => !marked.has(row.payload?.provenance?.runId)) : rows;
}

/** Portable snapshots are immutable ciphertext; online state can be revoked, offline copies cannot. */
export class CapsuleTransferService {
  /** @param {{documents: import('./productStore.mjs').ProductDocuments, capsules: import('./capsuleService.mjs').CapsuleService, identities: import('./capsuleIdentityStore.mjs').CapsuleIdentityStore, dataDir: string,
   *   nativeMemory?: import("./nativeMemoryStore.mjs").NativeMemoryStore | null, memoryEngine?: ((userId: string) => Promise<string>) | null,
   *   scanner?: import('./capsuleScan.mjs').CapsuleScanner | null, privateAccountCleanup?: ((userId:string)=>Promise<void>) | null,
   *   maxLiveSnapshots?: number, now?: () => number, report?: (event: "rolled_back" | "cleanup_failed", details: { userId: string, code?: string }) => void}} options */
  constructor({ documents, capsules, identities, dataDir, scanner = null, nativeMemory = null, memoryEngine = null, privateAccountCleanup = null, maxLiveSnapshots = MAX_LIVE_SNAPSHOTS, now = Date.now, report = () => {} }) {
    this.documents = documents; this.capsules = capsules; this.identities = identities; this.dataDir = dataDir;
    this.scanner = scanner;
    this.nativeMemory = nativeMemory; this.memoryEngine = memoryEngine;
    this.privateAccountCleanup = privateAccountCleanup;
    this.maxLiveSnapshots = maxLiveSnapshots;
    this.now = now;
    /** Where an account's capsule cleanup says what became of it, for the operator's audit line; never for the account. */
    this.report = report;
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
    // With no project in view the language check is metered to the account's own default project, so a preview made from somewhere
    // that names none is judged like any other, and the entries it imports are not left `unscanned` — never mounted — for good.
    const result = await (this.scanner ?? new CapsuleScanner({})).scan({ userId, projectId: projectId || SCAN_METER_PROJECT }, entries, { useModel: true });
    if (this.scans.size >= 500) this.scans.delete(this.scans.keys().next().value);
    this.scans.set(key, { at: Date.now(), result });
    return result;
  }

  /**
   * What a pack carries: captured native file bytes, then a repeatable-read database snapshot of capsule facts,
   * learned methods, selection policy and legacy preferences. No transaction spans the engine and database.
   *
   * Every entry leaves with the id the preview shows it by (`entryId`: its source's kind and id), so that what the sender unticked
   * (`exclude`) is the same entry at export as it was in the preview. `tally` also counts what the rules keep out, by reason, for
   * the sender's preview: the sentence that says why a thing they remember saying is not in the pack.
   * @param {string} userId @param {string} capsuleId @param {readonly string[]} kinds
   * @param {{ tally?: boolean, exclude?: ReadonlySet<string> }} [options]
   */
  async #assemble(userId, capsuleId, kinds, { tally = false, exclude = new Set() } = {}) {
    // Native bytes are hydrated before the database snapshot. These are two stores, not a cross-engine atomic read.
    // Engine failures must remain failures: an account on native memory must never export stale legacy copies.
    const native = await this.memoryEngine?.(userId) === "native";
    const snapshot = native ? await this.#nativeSnapshot(userId, kinds) : null;
    const nativeFacts = snapshot?.facts ?? null;
    await migrateResearchMemory(this.documents.database);
    return this.documents.database.transaction(async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const capsule = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' AND id=$2 AND deleted_at IS NULL", [productId(userId), productId(capsuleId)]);
      if (!capsule.rows[0]) throw new HttpError(404, "capsule_not_found", "The capsule is unavailable.");
      /** What the rules keep out, by reason (counted only when `tally`). */
      const held = { inferred: 0, document: 0, sensitive: snapshot?.sensitive ?? 0, received: 0, unconfirmed: 0, paused: 0 };
      // A note a run wrote takes effect without anyone approving it, and the
      // researcher who never acted on it has not adopted it: the export promises
      // 「只分享已采用的研究方法与工作偏好 … 运行记录不会随包导出」. So an
      // `inferred` entry leaves only once the researcher's own act is on it —
      // they changed its status or corrected it, or it records their decision.
      // Before this, a note a page had talked a run into writing left in the
      // pack and was imported as the pack's own, mountable method (security
      // review 2026-09-20). What does leave carries its origin (below).
      // An entry that arrived by a share (`payload.share`) never leaves again as this account's own: a pack is the author's, and
      // forwarding it under another name would erase who made it (plan §7, provenance that cannot be edited).
      const facts = await client.query(`SELECT id,revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND deleted_at IS NULL
        AND payload @> $2::jsonb AND payload->>'factKind'=ANY($3::text[]) AND payload->>'layer'<>'sources'
        AND (payload->>'origin' IS DISTINCT FROM 'inferred' OR payload->>'curatedAt' IS NOT NULL OR payload->>'correctedAt' IS NOT NULL
          OR payload->'provenance' @> '[{"type":"user"}]'::jsonb)
        AND payload->'share' IS NULL
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
      // A method learned in a run that drew on a pack nobody had vouched for yet does not leave either: shared text would
      // otherwise be re-shared as this account's own once the loop had restated it (capsuleShareTrust.mjs).
      methods.rows = await exportableMethods(client, userId, methods.rows);
      const stated = native ? { rows: [] } : await client.query(`SELECT id,version,kind,value,summary FROM evimed_memory.records WHERE user_id=$1
        AND scope='user' AND status='active' AND NOT sensitive AND origin IN ('explicit','manual') AND kind=ANY($2::text[])
        ORDER BY updated_at DESC,id LIMIT 50`, [userId, kinds.filter((kind) => !KNOWLEDGE.includes(kind))]);
      // 「知识与项目事实」 (build spec §9.1), only when the sender ticked it:
      // the same predicate as above — active, their own, never sensitive, and
      // said, edited or confirmed by them — but read from the projects too,
      // because a project fact, a decision or a follow-up is recorded against
      // the project it is about (`memoryIntelligence.mjs`). Reading only
      // account-level records, the box was offered and carried nothing. Not
      // from a project the platform works in for itself, nor from one the
      // researcher paused memory for, and never a conversation's own notes.
      // Newest first, into whatever room the default layer leaves.
      const knowledgeKinds = kinds.filter((kind) => KNOWLEDGE.includes(kind));
      const known = !native && knowledgeKinds.length ? await client.query(`SELECT id,version,kind,value,summary,scope,scope_id FROM evimed_memory.records r
        WHERE user_id=$1 AND scope IN ('user','project') AND status='active' AND NOT sensitive AND origin IN ('explicit','manual')
          AND kind=ANY($2::text[]) AND NOT (scope='project' AND scope_id=ANY(COALESCE(
            (SELECT paused_projects FROM evimed_memory.settings s WHERE s.user_id=r.user_id), '{}'::text[])))
        ORDER BY updated_at DESC,id LIMIT $3`, [userId, knowledgeKinds, MAX_ENTRIES + 1]) : { rows: [] };
      const selectedNative = [];
      if (nativeFacts) {
        const policy = await client.query("SELECT paused_projects FROM evimed_memory.settings WHERE user_id=$1", [userId]);
        const paused = new Set(policy.rows[0]?.paused_projects ?? []);
        const projects = await client.query("SELECT id FROM evimed_control.projects WHERE user_id=$1", [userId]);
        const owned = new Set(projects.rows.map((row) => row.id));
        // Migration replayed old records as user messages, including inferred records. That erases line provenance.
        // Follow replay lineage and conservatively omit those files unless the person edited this exact body.
        const migrated = await client.query(`WITH RECURSIVE migration AS (
          SELECT archive_uri,replayed_as FROM evimed_memory.native_commits WHERE user_id=$1 AND origin='migration'
          UNION
          SELECT c.archive_uri,c.replayed_as FROM evimed_memory.native_commits c JOIN migration m ON c.archive_uri=m.replayed_as
            WHERE c.user_id=$1
        ) SELECT DISTINCT r.uri FROM evimed_memory.native_revisions r JOIN migration m ON r.archive_uri=m.archive_uri
          WHERE r.user_id=$1 AND r.uri=ANY($2::text[])`, [userId, nativeFacts.map((row) => row.nativeUri)]);
        const migrationFiles = new Set(migrated.rows.map((row) => row.uri));
        // Once the migration is complete (`migrated_at`) the replay's files stop being out for good: a file whose body is the
        // person's own legacy statement — what they stated or edited before the move, which the legacy rows still hold — is
        // theirs, and so is a profile line a later conversation brought. Until then, and for anything else the replay wrote, the
        // rule above stands (the account's own export used to be empty for ever after a migration).
        const complete = migrationFiles.size > 0
          && Boolean((await client.query("SELECT migrated_at FROM evimed_memory.native_accounts WHERE user_id=$1", [userId])).rows[0]?.migrated_at);
        const legacy = complete ? await this.#legacyStatements(client, userId) : null;
        const theirs = (/** @type {any} */ row) => row.adoptedBody || (legacy !== null && (row.nativeType === "profile"
          ? row.conversations > 0 || legacy.has(flatStatement(row.payload.content))
          : bodyIsOwnLegacyStatement(row.payload.content, legacy)));
        for (const row of nativeFacts) {
          if (!kinds.includes(row.payload.factKind)) continue;
          const knowledgeOfProject = row.scope !== "user";
          if (knowledgeOfProject && !(KNOWLEDGE.includes(row.payload.factKind) && owned.has(row.scopeId) && !isInternalProject(row.scopeId))) continue;
          if (knowledgeOfProject && paused.has(row.scopeId)) { held.paused += 1; continue; }
          if (migrationFiles.has(row.nativeUri) && !theirs(row)) { held.unconfirmed += 1; continue; }
          selectedNative.push(row);
        }
      }
      if (tally) await this.#tallyHeld(client, userId, kinds, native, held);
      const recorded = (/** @type {any} */ row) => ({ id: row.id, entryId: `record:${row.id}`, revision: row.version, payload: {
        factKind: row.kind, origin: "explicit", content: boundedText(row.summary || row.value, 20_000) } });
      const workstyle = [
        ...facts.rows.map((row) => ({ ...row, entryId: `fact:${row.id}` })),
        ...methods.rows.map((row) => ({ id: row.id, entryId: `method:${row.id}`, revision: row.revision, payload: {
          factKind: "method_preference", origin: "system", content: learnedMethodText(row.payload) } })),
        ...stated.rows.map(recorded),
        ...selectedNative.filter((row) => !KNOWLEDGE.includes(row.payload.factKind)).map((row) => ({ ...row, entryId: `native:${row.id}` })),
      ];
      const knowledge = [...selectedNative.filter((row) => KNOWLEDGE.includes(row.payload.factKind)).map((row) => ({ ...row, entryId: `native:${row.id}` })),
        ...known.rows.filter((row) => row.scope === "user" || !isInternalProject(row.scope_id)).map(recorded)];
      // What the sender unticked is out before the bound is read: leaving entries out is how a pack that is too big gets small.
      const unticked = [...workstyle, ...knowledge].filter((fact) => exclude.has(fact.entryId));
      const ticked = (/** @type {any[]} */ list) => list.filter((fact) => !exclude.has(fact.entryId));
      const kept = ticked(workstyle);
      const room = ticked(knowledge).slice(0, Math.max(0, MAX_ENTRIES + (native ? 1 : 0) - kept.length));
      return { revision: capsule.rows[0].revision, facts: [...kept, ...room], unticked, held };
    });
  }

  /**
   * What the account's own words were before its migration to the native engine: the legacy records it stated or edited itself,
   * in the form the replay wrote them into files (`replayedForm`), each statement and each line of a longer one.
   * @param {{ query: Function }} client @param {string} userId @returns {Promise<Set<string>>}
   */
  async #legacyStatements(client, userId) {
    const rows = await client.query(`SELECT value FROM evimed_memory.records WHERE user_id=$1 AND status='active' AND NOT sensitive
      AND origin IN ('explicit','manual') AND kind=ANY($2::text[])`, [userId, MIGRATED_KINDS]);
    const forms = new Set();
    for (const row of rows.rows) {
      forms.add(replayedForm(row.value));
      for (const line of String(row.value ?? "").split("\n")) if (line.trim()) forms.add(replayedForm(line));
    }
    forms.delete("");
    return forms;
  }

  /**
   * Count, by reason, what the rules kept out of a pack of these kinds, for the sender's preview: the assistant's own notes the
   * person never confirmed, what a document yielded, what they marked sensitive, what someone else shared with them. Counts only;
   * nothing of those entries is read into the answer.
   * @param {{ query: Function }} client @param {string} userId @param {readonly string[]} kinds @param {boolean} native
   * @param {Record<string, number>} held
   */
  async #tallyHeld(client, userId, kinds, native, held) {
    const facts = (await client.query(`SELECT
        count(*) FILTER (WHERE payload->'share' IS NOT NULL)::integer AS received,
        count(*) FILTER (WHERE payload->'share' IS NULL AND payload->>'layer'='sources')::integer AS document,
        count(*) FILTER (WHERE payload->'share' IS NULL AND payload->>'layer'<>'sources' AND payload->>'origin'='inferred'
          AND payload->>'curatedAt' IS NULL AND payload->>'correctedAt' IS NULL
          AND NOT COALESCE(payload->'provenance' @> '[{"type":"user"}]'::jsonb, false))::integer AS inferred
      FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND deleted_at IS NULL
        AND payload->>'status'='approved' AND payload->>'factKind'=ANY($2::text[])`, [userId, kinds])).rows[0];
    held.received += Number(facts?.received) || 0;
    held.document += Number(facts?.document) || 0;
    held.inferred += Number(facts?.inferred) || 0;
    // A native account's records are the engine's files (counted above); the legacy rows it left behind are not its memory.
    if (native) return;
    const records = (await client.query(`SELECT
        count(*) FILTER (WHERE sensitive AND origin IN ('explicit','manual'))::integer AS sensitive,
        count(*) FILTER (WHERE NOT sensitive AND origin='inferred')::integer AS inferred
      FROM evimed_memory.records WHERE user_id=$1 AND scope IN ('user','project') AND status='active' AND kind=ANY($2::text[])`, [userId, kinds])).rows[0];
    held.sensitive += Number(records?.sensitive) || 0;
    held.inferred += Number(records?.inferred) || 0;
  }

  /**
   * Snapshot the native engine's own explicitly stated memories, under the account identity alone.
   * The extraction templates admit only the person's statements; this is file provenance, never inferred line adoption.
   * Files in the derived capsule index are excluded by nativeMemoryFile. Preserve the exact body and source hash privately.
   * `sensitive` is how many the person marked sensitive, which stay out and are counted for the sender's preview.
   * @param {string} userId @param {readonly string[]} kinds
   */
  async #nativeSnapshot(userId, kinds) {
    if (!this.nativeMemory?.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
    const files = await this.nativeMemory.files(userId);
    for (const file of files) {
      const place = nativeMemoryFile(file.uri, nativeMemoryRoot(userId));
      if (!place || place.type !== file.type || typeof file.body !== "string" || digest(file.body) !== file.hash)
        throw new HttpError(503, "memory_engine_unavailable", "The memory snapshot could not be verified.");
    }
    const records = await this.nativeMemory.records(userId, { files });
    const histories = await this.nativeMemory.overlay.revisionsOfMany(userId, files.map((file) => file.uri));
    // A correction lives under `preferences/corrections/` and is a `correction` here (its own kind, in the knowledge scope), never
    // a `preference` for sharing its directory's name.
    const eligible = records.filter((row) => (!PROJECT_MEMORY_TYPES.includes(row.nativeType) || (row.scope === "project" && Boolean(row.scopeId)))
      && kinds.includes(row.kind) && row.engine === "native" && row.status === "active" && !row.share
      && ["explicit", "manual"].includes(row.origin) && ["user", "project"].includes(row.scope)
      && row.kind === LEGACY_KIND_OF_TYPE[row.nativeType] && row.version === versionOfHash(row.contentHash));
    const facts = eligible.filter((row) => !row.sensitive)
      .map((row) => {
        const file = files.find((item) => item.uri === row.uri);
        if (!file || file.hash !== row.contentHash || (row.nativeType !== "profile" && row.value !== file.body))
          throw new HttpError(503, "memory_engine_unavailable", "The memory snapshot could not be verified.");
        // The capsule wire uses int32 revisions; retain the engine's full hash-derived token beside it.
        // A profile edit changes one line; it cannot adopt the other migrated statements in that document.
        // Undo/restore likewise is not an adoption of the restored text.
        // revisionsOfMany orders by the unique revision id DESC (not changedAt, which may tie).
        // Only the latest operation can attest this body; an older edit cannot adopt a later engine write or undo.
        const latest = histories.get(file.uri)?.[0];
        const adoptedBody = row.nativeType !== "profile" && latest?.actor === "user"
          && latest.change === "updated" && latest.reason !== "undo" && !latest.undoneAt
          && typeof latest.after === "string" && digest(latest.after) === file.hash;
        return { id: row.id, revision: Number.parseInt(file.hash.slice(0, 7), 16) + 1, scope: row.scope, scopeId: row.scopeId,
          nativeUri: file.uri, adoptedBody,
          // How many conversations of the person's wrote this line (a profile line's own commit; none for a migration's or a replay's).
          conversations: Array.isArray(row.evidence) ? row.evidence.length : 0,
          nativeSource: { engine: "native", sha256: file.hash, version: row.version },
          payload: { factKind: row.kind, origin: "explicit", content: checkedText(row.value) } };
      });
    return { facts, sensitive: eligible.length - facts.length };
  }

  /**
   * The card a pack of this account carries: who sent it, what it is called and what it holds, and — for one that replaces an
   * earlier snapshot — what changed. The sender may name the title, summary and changelog, and may sign this share with a name
   * of their own (署名, 2026-10-10 review C4c): the card's author, which is what every recipient sees — on the card, as the
   * delivery's sender, and as the label a recall puts under each entry. Without one the share is signed with the account's
   * display name, and a signature that is the login name or holds an address is the neutral label (`shareSignature`).
   * @param {string} userId @param {readonly { factKind: string, sha256: string }[]} entries
   * @param {any} previous the snapshot record this one replaces, or null @param {any} requested
   */
  async #card(userId, entries, previous, requested) {
    const asked = capsuleCard(requested) ?? {};
    const name = shareSignature(asked.author, (await this.documents.database.query("SELECT name FROM evimed_control.users WHERE id=$1", [userId])).rows[0]?.name, userId);
    if (name === null) throw invalid();
    const author = cardText(name.slice(0, CARD_LIMITS.author), CARD_LIMITS.author) || undefined;
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
   * The accounts a pack is to be sealed for (build spec §9.2), checked and nothing more: a named account that does not exist is
   * refused by name rather than silently left out of a pack its sender thinks it reaches. This reads, and creates nothing for
   * any account: a refused export used to leave key files for every existing account it had named, one more for each name a
   * sender probed (review C-9). The keys are made by `#recipientKeys`, once the export can no longer be refused.
   * @param {unknown} recipients @param {string} sender
   * @returns {Promise<string[]>}
   */
  async #recipientIds(recipients, sender) {
    if (recipients == null) return [];
    if (!Array.isArray(recipients) || recipients.length > 32 || recipients.some((id) => typeof id !== "string" || !id.trim())) throw invalid();
    const ids = [...new Set(recipients.map((id) => id.trim()))].filter((id) => id !== sender);
    for (const id of ids) {
      productId(id, "user");
      const exists = await this.documents.database.query("SELECT 1 FROM evimed_control.users WHERE id=$1", [id]);
      if (exists.rowCount !== 1) throw new HttpError(400, "capsule_recipient_unknown", "A named recipient is not an account on this deployment.");
    }
    return ids;
  }

  /**
   * Accounts named the way a delivery names them — an exact account id or an exact display name (`reachableAccounts`) — for a file
   * sealed to named people. Names that reach nobody are left out and counted; nothing says which, or why.
   * @param {unknown} names @param {string} sender
   * @returns {Promise<{ requested: number, ids: string[] }>}
   */
  async #reachNames(names, sender) {
    if (names == null) return { requested: 0, ids: [] };
    if (!Array.isArray(names) || names.length > 32 || names.some((name) => typeof name !== "string" || !name.trim() || name.length > 200)) throw invalid();
    const refs = [...new Set(names.map((name) => name.trim()))];
    return { requested: refs.length, ids: await reachableAccounts(this.documents.database, sender, refs) };
  }

  /**
   * The X25519 keys of the accounts a pack is sealed for: each named account on this deployment can open it with its own key,
   * and nobody needs the password. An account without a key is given one here, which is why this runs last.
   * @param {readonly string[]} ids
   */
  async #recipientKeys(ids) {
    const keys = [];
    for (const id of ids) {
      const identity = await this.withAccount(id, null, () => this.identities.forUser(id));
      if (!identity?.encryption?.keyId || !identity.encryption.publicKey) throw new HttpError(503, "capsule_identity_unavailable", "A recipient key is unavailable.");
      keys.push({ userId: id, encKeyId: identity.encryption.keyId, publicKey: identity.encryption.publicKey });
    }
    return keys;
  }

  /**
   * An account keeps a bounded number of live snapshots: each is a file of up to 2 MiB that stays on the disk until it is
   * revoked, and nothing else limited how many an account could make. One beyond the bound is refused by name before any key
   * is derived or anything is written (review C-10); revoking an old one makes room.
   * @param {string} userId
   */
  async #assertRoomForSnapshot(userId) {
    const live = await this.documents.database.query(`SELECT count(*)::integer AS n FROM evimed_product.documents
      WHERE user_id=$1 AND kind='preferences' AND deleted_at IS NULL AND payload @> '{"recordType":"capsule-snapshot","status":"active"}'::jsonb`, [productId(userId)]);
    if (live.rows[0].n >= this.maxLiveSnapshots) {
      recordShareRefused("snapshot_limit");
      throw new HttpError(409, "capsule_snapshots_limit", "Too many live shared snapshots; revoke some first.");
    }
  }

  /**
   * 「对方会看到什么」: the pack as its recipient would read it, before any
   * password is chosen — the card, and every entry that would leave. An
   * account with nothing to share hears it here as a state, not as a refused
   * export (2026-09-26 audit, M-6: the owner's own account had no learned
   * method and no stated preference, and 加密导出 answered 400).
   *
   * Every entry that could leave is listed with an `id` and whether it is `included`: the sender unticks one by sending its id as
   * `excludeEntryIds` (here, to see the pack without it, and again at export), and the card, the count and `empty` are the pack
   * as it would then be. And `excluded` says, in one plain sentence per reason, what the rules keep out and why — what the
   * assistant wrote down that the person never confirmed, what a document yielded, what is marked sensitive, what someone else
   * shared with them — so that a thing they remember saying and cannot find in the list is not a mystery.
   * @param {string} userId @param {string} capsuleId @param {any} input
   */
  async exportPreview(userId, capsuleId, input = {}) {
    fields(input, ["scopes", "supersedes", "card", "excludeEntryIds"]);
    const scopes = scopesOf(input.scopes ?? undefined);
    const exclude = excludedIds(input.excludeEntryIds);
    await this.assertOwnCapsule(userId, capsuleId);
    const previous = input.supersedes != null ? await this.snapshot(userId, capsuleId, input.supersedes) : null;
    const source = await this.#assemble(userId, capsuleId, kindsFor(scopes), { tally: true, exclude });
    /** @param {any} fact @param {boolean} included */
    const entryOf = (fact, included) => {
      const content = String(fact.payload.content ?? "");
      return { id: fact.entryId, included, factKind: fact.payload.factKind, layer: location(fact.payload.factKind).layer, content, sha256: digest(content),
        origin: CAPSULE_FACT_ORIGINS.includes(fact.payload.origin) ? fact.payload.origin : "inferred" };
    };
    const included = source.facts.slice(0, MAX_ENTRIES).map((fact) => entryOf(fact, true));
    const listed = [...included, ...source.unticked.map((fact) => entryOf(fact, false))];
    const excluded = Object.entries(EXCLUDED_TEXT)
      .map(([reason, say]) => ({ reason, count: source.held[reason] ?? 0, say }))
      .filter((item) => item.count > 0).map(({ reason, count, say }) => ({ reason, count, text: say(count) }));
    return {
      scopes, empty: included.length === 0 && source.unticked.length === 0, tooMany: source.facts.length > MAX_ENTRIES,
      card: included.length ? await this.#card(userId, included, previous, input.card) : null,
      entries: listed.map(({ sha256: _sha256, ...entry }) => entry),
      excluded,
    };
  }

  /**
   * A capsule that is this account's own. A pack that arrived by a share is somebody else's, and re-exporting it would hand
   * on their words under this account's name: refused by name (plan §7).
   * @param {string} userId @param {string} capsuleId
   */
  async assertOwnCapsule(userId, capsuleId) {
    const capsule = await this.capsules.get(userId, capsuleId);
    if (capsule.payload.imported === true) throw new HttpError(400, "capsule_share_not_own", "A received capsule cannot be shared again.");
    return capsule;
  }

  /**
   * `options.channel` is how the pack reaches its readers: `file` (a download), `delivery` (to named accounts, in the app) or
   * `link` (a share link). It is recorded on the snapshot and travels in the pack's provenance on import.
   * @param {string} userId @param {string} capsuleId @param {any} input
   * @param {{ accountCreatedAt?: string | null, channel?: "file" | "delivery" | "link" }} [options]
   */
  async export(userId, capsuleId, input, options = {}) {
    fields(input, ["password", "scopes", "supersedes", "recipients", "recipientNames", "card", "excludeEntryIds"]);
    if (input.password !== undefined) checkedText(input.password, 1024);
    const accountCreatedAt = await this.withAccount(userId, options.accountCreatedAt ?? null);
    const previous = input.supersedes != null ? await this.snapshot(userId, capsuleId, input.supersedes) : null;
    const scopes = scopesOf(input.scopes); const kinds = kindsFor(scopes);
    const exclude = excludedIds(input.excludeEntryIds);
    const channel = ["delivery", "link"].includes(String(options.channel)) ? String(options.channel) : "file";
    await this.assertOwnCapsule(userId, capsuleId);
    await this.#assertRoomForSnapshot(userId);
    const named = await this.#reachNames(input.recipientNames, userId);
    const recipientIds = [...new Set([...await this.#recipientIds(input.recipients, userId), ...named.ids])];
    if (recipientIds.length > 32) throw invalid();
    // Sealed for a password, for named accounts, or both; never for nobody. Names that reached nobody are refused by name when
    // they were all the file was to be sealed for: a file its sender thinks is addressed to someone, and is not, is worse than none.
    if (input.password === undefined && recipientIds.length === 0) {
      if (named.requested > 0) throw new HttpError(400, "capsule_recipient_unknown", "A named recipient is not an account on this deployment.");
      throw invalid();
    }
    const source = await this.#assemble(userId, capsuleId, kinds, { exclude });
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
    // Every sealed entry is its text and 28 bytes, in base64 inside the archive: a pack that cannot fit is refused here, before
    // any recipient is given a key for it. (The exact size is checked once the pack is made.)
    const sealedBytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content) + 28, 0);
    if (Math.ceil(sealedBytes / 3) * 4 > CAPSULE_TRANSFER_MAX_BYTES) throw new HttpError(413, "capsule_transfer_too_large", "This encrypted snapshot exceeds 2 MiB.");
    const recipients = await this.#recipientKeys(recipientIds);
    const identity = await this.withAccount(userId, accountCreatedAt, () => this.identities.forUser(userId, { accountCreatedAt }));
    /** @type {Awaited<ReturnType<typeof packCapsule>>} */
    let container;
    try { container = await packCapsule({ capsuleId: snapshotId, version: source.revision, createdAt: new Date().toISOString(), account: userId,
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
    }); } catch (error) { throw kdfRefusalOf(/** @type {any} */ (error)) ?? error; }
    const archive = JSON.stringify({ format: "evimedcap", version: 1, manifest: container.manifest, issuerPublicKey: identity.signing.publicKey,
      ...(container.passwordWrap ? { passwordWrap: container.passwordWrap.toString("base64") } : {}),
      payload: Object.fromEntries(Object.entries(container.payload).map(([file, bytes]) => [file, bytes.toString("base64")])) });
    if (Buffer.byteLength(archive) > CAPSULE_TRANSFER_MAX_BYTES) throw new HttpError(413, "capsule_transfer_too_large", "This encrypted snapshot exceeds 2 MiB.");
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
    const filename = `${capsuleAccountHash(userId)}-${snapshotId}.evimedcap`;
    await this.withAccount(userId, accountCreatedAt, () => writeProtectedCapsuleFile(directory, filename, archive));
    let record;
    try { [record] = await this.documents.createBatch(userId, [{ kind: "preferences", id: snapshotId, payload: {
      recordType: "capsule-snapshot", capsuleId, issuerId: identity.issuerId, status: "active", channel, scopes, supersedes: input.supersedes ?? null,
      archiveSha256: digest(archive), manifestSha256: digest(JSON.stringify(container.manifest)), capsuleRevision: source.revision,
      entryCount: entries.length, sourceEntries: source.facts.map((fact, index) => ({ id: fact.id, revision: fact.revision, sha256: entries[index].sha256, ...(fact.nativeSource ? { nativeSource: fact.nativeSource } : {}) })),
      ...(card ? { card } : {}), ...(recipients.length ? { recipients: recipients.map((recipient) => recipient.userId) } : {}),
    } }], { accountCreatedAt }); } catch (error) {
      await unlinkCapsuleFile(directory, filename);
      throw error;
    }
    if (channel !== "delivery") recordShared(channel);
    // How many of the names the sender typed the file is sealed for: the count, never which (the same answer a delivery gives).
    return { filename: `capsule-${snapshotId}.evimedcap`, archive, snapshot: snapshotView(record),
      ...(named.requested > 0 ? { reached: { requested: named.requested, sealed: named.ids.length } } : {}) };
  }

  /**
   * The archive of one of an account's own snapshots, by its id alone — what a delivery or a share link reads on the
   * recipient's behalf so that nobody but its author ever handles the file. The snapshot has to be active and the file has to
   * be the bytes it was sealed as; a revoked or taken-down one answers the same refusal a download of it does.
   * @param {string} ownerId @param {string} snapshotId
   */
  async snapshotArchive(ownerId, snapshotId) {
    const record = await this.documents.get(ownerId, "preferences", snapshotId);
    if (!record || record.payload.recordType !== "capsule-snapshot") throw new HttpError(404, "capsule_snapshot_not_found", "The snapshot is unavailable.");
    if (record.payload.status === "revoked") throw new HttpError(409, "capsule_snapshot_revoked", "This hosted snapshot has been revoked.");
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
    const archive = await readProtectedCapsuleFile(directory, `${capsuleAccountHash(ownerId)}-${record.id}.evimedcap`, CAPSULE_TRANSFER_MAX_BYTES)
      ?? await readProtectedCapsuleFile(directory, `${record.id}.evimedcap`, CAPSULE_TRANSFER_MAX_BYTES);
    if (!archive || digest(archive) !== record.payload.archiveSha256) throw new HttpError(503, "capsule_snapshot_unavailable", "The snapshot file is unavailable.");
    return { archive, record };
  }

  /**
   * The account's approved learned methods as an Agent Skills pack (`capsuleMethodPack.mjs`): a zip, text only, one folder per
   * method, each with who made it. Not a snapshot a recipient can import — it leaves the platform for any tool that reads the
   * open format — so it is not sealed and cannot be revoked, and the answer to that is in what it carries: only text, and the
   * author's name.
   * @param {string} userId @param {string} capsuleId @param {{ exportedAt?: Date }} [options]
   */
  async methodPack(userId, capsuleId, { exportedAt = new Date() } = {}) {
    await this.assertOwnCapsule(userId, capsuleId);
    const database = this.documents.database;
    const found = await database.query(`SELECT id,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='method'
      AND deleted_at IS NULL AND payload->>'recordType'='learned-method' AND payload->>'status'='approved'
      ORDER BY updated_at DESC,id LIMIT 50`, [userId]);
    const rows = await exportableMethods(database, userId, found.rows);
    if (!rows.length) throw new HttpError(409, "capsule_export_empty", "No approved method is eligible for this pack.");
    const author = senderDisplayName((await database.query("SELECT name FROM evimed_control.users WHERE id=$1", [userId])).rows[0]?.name, userId);
    const pack = buildAgentSkillsPack({ authorName: author, exportedAt, methods: rows.map((row) => ({
      name: String(row.payload.frontmatter?.name ?? ""), description: String(row.payload.frontmatter?.description ?? ""),
      whenToUse: String(row.payload.frontmatter?.whenToUse ?? ""), body: String(row.payload.body ?? "") })) });
    recordShared("file");
    return { ...pack, filename: `evimed-methods-${exportedAt.toISOString().slice(0, 10)}.zip` };
  }

  async history(userId, capsuleId, options = {}) {
    await this.capsules.get(userId, capsuleId);
    const page = await this.documents.list(userId, "preferences", { limit: 20, cursor: options.cursor, filter: { recordType: "capsule-snapshot", capsuleId } });
    return { items: page.items.map(snapshotView), nextCursor: page.nextCursor };
  }

  /**
   * Revoke every hosted snapshot of a capsule that has been deleted, so nothing more is imported from it; what
   * recipients already imported is theirs, as with `revoke`. Reads the snapshot records directly: the capsule
   * itself is already gone. Idempotent. @param {string} userId @param {string} capsuleId @returns {Promise<string[]>}
   */
  async revokeAllForCapsule(userId, capsuleId) {
    const revoked = [];
    /** @type {string | null} */
    let cursor = null;
    for (let pages = 0; pages < 50; pages += 1) {
      const page = await this.documents.list(userId, "preferences", { limit: 100, cursor, filter: { recordType: "capsule-snapshot", capsuleId } });
      for (const record of page.items) {
        if (record.payload.status === "revoked") continue;
        await this.documents.put(userId, "preferences", record.id, { ...record.payload, status: "revoked", revokedAt: new Date().toISOString() },
          { expectedRevision: record.revision });
        await this.#discardArchive(userId, record.id);
        revoked.push(record.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return revoked;
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
    const revoked = snapshotView(await this.documents.put(userId, "preferences", record.id, { ...record.payload, status: "revoked", revokedAt: new Date().toISOString() }, { expectedRevision }));
    await this.#discardArchive(userId, record.id);
    return revoked;
  }

  /**
   * A revoked snapshot is never served again (`snapshotArchive` and `download` refuse it by its record), so its ciphertext has
   * no reader left and goes off the disk with the revoke. Best effort, because the revoke has already happened: a file that
   * could not be removed is counted, and the sweep (`sweepSnapshots`) takes it later. A snapshot a take-down revoked is
   * kept — what an operator took down may be wanted for review — and so is nothing else this does not name.
   * @param {string} userId @param {string} snapshotId
   */
  async #discardArchive(userId, snapshotId) {
    try {
      const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
      const hashed = await unlinkCapsuleFile(directory, `${capsuleAccountHash(userId)}-${snapshotId}.evimedcap`);
      const flat = await unlinkCapsuleFile(directory, `${snapshotId}.evimedcap`);
      if (hashed || flat) recordSnapshotFile("discarded");
    } catch { recordSnapshotFile("failed"); }
  }

  /**
   * Take off the disk what nothing can serve: a snapshot file no snapshot record names (a write that crashed between the file
   * and its record, or whose cleanup failed), a revoked snapshot's file that its revoke could not remove, and a write's
   * temporary copy. A file younger than `graceMs` is left alone, since an export in flight has written its file a moment before
   * its record; a take-down's file and a file whose record belongs to someone else are never touched. Idempotent, and bounded
   * to `limit` files per pass. Nothing here reads a file's contents.
   * @param {{ graceMs?: number, limit?: number }} [options]
   * @returns {Promise<{ examined: number, removed: { orphan: number, revoked: number, temporary: number }, failed: number }>}
   */
  async sweepSnapshots({ graceMs = SNAPSHOT_FILE_GRACE_MS, limit = SNAPSHOT_SWEEP_FILES } = {}) {
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
    const result = { examined: 0, removed: { orphan: 0, revoked: 0, temporary: 0 }, failed: 0 };
    /** @param {string} name @param {"orphan" | "revoked" | "temporary"} why */
    const remove = async (name, why) => {
      try { if (await unlinkCapsuleFile(directory, name)) { result.removed[why] += 1; recordSnapshotFile(why); } }
      catch { result.failed += 1; recordSnapshotFile("failed"); }
    };
    /** @type {{ name: string, hash: string | null, id: string }[]} */
    let batch = [];
    const settle = async () => {
      const wanted = batch; batch = [];
      if (!wanted.length) return;
      const rows = (await this.documents.database.query(`SELECT user_id,id,payload->>'status' AS status,(payload->'takenDown') IS NOT NULL AS taken_down
        FROM evimed_product.documents WHERE kind='preferences' AND id=ANY($1::text[]) AND payload @> '{"recordType":"capsule-snapshot"}'::jsonb`,
      [wanted.map((file) => file.id)])).rows;
      for (const file of wanted) {
        const records = rows.filter((/** @type {any} */ row) => row.id === file.id);
        if (!records.length) { await remove(file.name, "orphan"); continue; }
        const own = records.find((/** @type {any} */ row) => file.hash === null || capsuleAccountHash(row.user_id) === file.hash);
        if (own && own.status === "revoked" && !own.taken_down) await remove(file.name, "revoked");
      }
    };
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      const match = SNAPSHOT_FILE.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const info = await fs.lstat(path.join(directory, entry.name)).catch(() => null);
      if (!info || !info.isFile() || this.now() - info.mtimeMs < graceMs) continue;
      if (result.examined >= limit) break;
      result.examined += 1;
      if (match[3]) { await remove(entry.name, "temporary"); continue; }
      batch.push({ name: entry.name, hash: match[1] ?? null, id: match[2] });
      if (batch.length >= 200) await settle();
    }
    await settle();
    return result;
  }

  /**
   * Take shares down (plan §7: every defence sits on the write side, and a bad share is withdrawn from the people it reached,
   * not filtered at reading time). What is marked is the author's snapshots — one of them, or with no `snapshotId` every one the
   * author ever made — as revoked and taken down, so nothing more is imported from them; what is disabled is each recipient's
   * copy of them, in every project, with the reason on the copy. The recipients' own memory is untouched, and an offline file
   * cannot be reached, as `revoke` has always said. Idempotent: a snapshot or a copy already taken down is left as it is.
   * @param {{ authorId: string, snapshotId?: string | null, by: "author" | "operator", reason?: string }} input
   * @returns {Promise<{ snapshots: string[], copies: { userId: string, capsuleId: string, title: string, snapshotId: string }[] }>}
   */
  async takeDown({ authorId, snapshotId = null, by, reason = "" }) {
    productId(authorId, "user");
    const why = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const at = new Date().toISOString();
    /** @type {any[]} */
    let snapshots = [];
    if (snapshotId != null) {
      const record = await this.documents.get(authorId, "preferences", productId(snapshotId, "snapshot"));
      if (!record || record.payload.recordType !== "capsule-snapshot") throw new HttpError(404, "capsule_snapshot_not_found", "The snapshot is unavailable.");
      snapshots = [record];
    } else {
      /** @type {string | null} */
      let cursor = null;
      for (let pages = 0; pages < 50; pages += 1) {
        const page = await this.documents.list(authorId, "preferences", { limit: 100, cursor, filter: { recordType: "capsule-snapshot" } });
        snapshots.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
    for (const record of snapshots) {
      if (record.payload.takenDown) continue;
      let current = record;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.documents.put(authorId, "preferences", current.id, { ...current.payload, status: "revoked", revokedAt: current.payload.revokedAt ?? at,
            takenDown: { by, at, ...(why ? { reason: why } : {}) } }, { expectedRevision: current.revision });
          break;
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== "product_revision_conflict" || attempt === 2) throw error;
          current = await this.documents.get(authorId, "preferences", current.id);
          if (!current) break;
        }
      }
    }
    const ids = snapshots.map((record) => String(record.id));
    if (!ids.length) return { snapshots: [], copies: [] };
    const found = await this.documents.database.query(`SELECT user_id,id,payload->>'title' AS title,payload->'transfer'->>'snapshotId' AS snapshot_id
      FROM evimed_product.documents WHERE kind='capsule' AND deleted_at IS NULL AND payload @> '{"imported":true}'::jsonb
        AND payload->'takenDown' IS NULL
        AND (payload->'transfer'->>'snapshotId'=ANY($1::text[]) OR ($2::boolean AND payload->'transfer'->>'authorId'=$3))
      ORDER BY user_id,id LIMIT 5000`, [ids, snapshotId == null, authorId]);
    /** @type {{ userId: string, capsuleId: string, title: string, snapshotId: string }[]} */
    const copies = [];
    for (const row of found.rows) {
      // Out of every list first, so a pack that fails to be marked is still not in force.
      await this.capsules.disable(row.user_id, row.id);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const capsule = await this.documents.get(row.user_id, "capsule", row.id);
        if (!capsule) break;
        try {
          await this.documents.put(row.user_id, "capsule", row.id, { ...capsule.payload, keptSince: null,
            takenDown: { by, at, ...(why ? { reason: why } : {}) } }, { expectedRevision: capsule.revision });
          copies.push({ userId: row.user_id, capsuleId: row.id, title: String(row.title ?? ""), snapshotId: String(row.snapshot_id ?? "") });
          break;
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== "product_revision_conflict" || attempt === 2) throw error;
        }
      }
    }
    return { snapshots: ids, copies };
  }

  async preview(userId, input, options = {}) { return (await this.inspect(userId, input, options)).preview; }

  async inspect(userId, input, options = {}) {
    const accountCreatedAt = await this.withAccount(userId, options.accountCreatedAt ?? null);
    productId(userId); fields(input, ["archive", "password"]);
    if (input.password !== undefined) checkedText(input.password, 1024);
    const { envelope, container, passwordWrap } = parseArchive(input.archive);
    const manifest = envelope.manifest;
    // Before any key is derived or any entry opened: a share carries text and nothing else.
    assertShareTextOnly(manifest, Object.keys(container.payload));
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
    const opened = await openCapsule(container, { issuer: { signingPublicKey: beforeKdf?.publicKey ?? envelope.issuerPublicKey }, account: userId, ...keys });
    if ("issues" in opened) {
      // The container's own refusals of executable content or an unlisted entry are the same property as the share's.
      if (opened.issues.some((/** @type {any} */ issue) => ["capsule_executable_content", "capsule_method_shape_invalid", "capsule_unlisted_entry"].includes(issue.code))) throw notTextOnly();
      // A busy derivation and a cost nobody wrote are named, not read as a wrong password.
      throw kdfRefusalOf(opened.issues[0]) ?? new HttpError(400, "capsule_transfer_open_failed", "The capsule could not be verified or decrypted.");
    }
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
    assertShareTextOnly(opened.manifest, Object.keys(opened.entries));
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
    // The key the pack was verified with: the registry's for a known issuer, else the archive's own. A pack continues
    // one the account holds only when it is signed by the same key (2026-10-10 review C-4).
    const signingKeyFingerprint = digest(String(known?.publicKey ?? envelope.issuerPublicKey));
    const upgrade = await this.#upgradeTarget(userId, manifest, metadata.entries, { signingKeyFingerprint, trust: known ? "verified" : "unverified" });
    const preview = { archiveSha256, manifestSha256, snapshotId: metadata.snapshotId, scopes, entries: metadata.entries, newerSnapshotId: replacements.items[0]?.id ?? null, scan,
      card, sharedAt: typeof opened.manifest.createdAt === "string" ? opened.manifest.createdAt : null, upgrades: upgrade ? upgrade.view : null,
      issuerTrust: known ? "verified" : "unverified", issuerId: manifest.issuer.userId,
      hostedStatus: known && (known.revoked || !sourceAccountPresent) ? "revoked" : hosted?.payload.status ?? (known ? "unavailable" : "unknown"),
      canImport: !known || Boolean(currentIssuer && !currentIssuer.revoked && sourceAccountPresent && hosted?.payload.status === "active"), offlineRevocable: false };
    if (!preview.canImport) preview.entries = [];
    const guards = known?.ownerId ? [{ userId: known.ownerId, kind: "preferences", id: metadata.snapshotId, filter: { status: "active", archiveSha256 } }] : [];
    // Who made it, as this deployment knows: the account behind the verified issuer key. Internal — it is recorded beside what
    // the pack brought and never sent to a browser; a reader is shown the card's display name.
    const author = { id: known && !known.revoked && sourceAccountPresent ? known.ownerId : null, name: preview.card?.author ?? null };
    return { preview, guards, accountCreatedAt, upgrade, author, signingKeyFingerprint };
  }

  /**
   * The received pack this one continues, when the account holds it: the same
   * issuer, and a manifest whose version chain names the one it was imported
   * from. What changed is counted by content, since ids are minted per export.
   *
   * The same issuer means the same signing key, not the same self-asserted id: the issuer id and the held
   * manifest's hash are cleartext in any copy, so a pack signed by another key that names both is a different
   * pack, imported beside the one held — never in its place, keeping its standing (2026-10-10 review C-4). A
   * pack held from before keys were recorded is continued only at the same trust, never verified → unverified.
   * @param {string} userId @param {any} manifest @param {readonly any[]} entries
   * @param {{ signingKeyFingerprint: string, trust: "verified" | "unverified" }} signer
   */
  async #upgradeTarget(userId, manifest, entries, { signingKeyFingerprint, trust }) {
    if (typeof manifest.prevManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.prevManifestSha256)) return null;
    const received = await this.documents.list(userId, "capsule", { limit: 100,
      filter: { imported: true, transfer: { manifestSha256: manifest.prevManifestSha256, issuerId: manifest.issuer.userId } } });
    const capsule = received.items.find((/** @type {any} */ item) => {
      const held = item.payload.transfer ?? {};
      // A copy the author or the operator took down stays down: an upgrade in place would keep it marked and the new version would
      // never be in force, so what replaces a taken-down version is a pack of its own.
      if (item.payload.takenDown) return false;
      return held.signingKeyFingerprint ? held.signingKeyFingerprint === signingKeyFingerprint : !(held.issuerTrust === "verified" && trust !== "verified");
    });
    if (!capsule) return null;
    const facts = (await this.documents.list(userId, "fact", { limit: 100, filter: { capsuleId: capsule.id } })).items
      .filter((/** @type {any} */ fact) => fact.payload.status !== "retired" && fact.payload.transfer?.sha256);
    const changes = capsuleChangelog(facts.map((/** @type {any} */ fact) => fact.payload.transfer.sha256), entries.map((entry) => entry.sha256));
    return { capsule, facts, view: { capsuleId: capsule.id, title: capsule.payload.title, added: changes.added, removed: changes.removed, kept: changes.kept } };
  }

  /**
   * `options.channel` says how the pack reached this account — a file handed over (`file`, the default), a delivery to this
   * account (`delivery`) or a share link (`link`).
   * @param {string} userId @param {any} input
   * @param {{ accountCreatedAt?: string | null, projectId?: string | null, channel?: "file" | "delivery" | "link" }} [options]
   */
  async import(userId, input, options = {}) {
    fields(input, ["archive", "password", "expectedDigest", "confirmed", "title"]);
    if (input.confirmed !== true) throw new HttpError(400, "capsule_import_confirmation_required", "Preview and explicitly confirm the capsule before importing.");
    if (input.expectedDigest !== digest(checkedText(input.archive, CAPSULE_TRANSFER_MAX_BYTES))) throw new HttpError(409, "capsule_preview_changed", "The archive changed after preview.");
    const { preview, guards, accountCreatedAt, upgrade, author, signingKeyFingerprint } = await this.inspect(userId,
      { archive: input.archive, ...(input.password !== undefined ? { password: input.password } : {}) }, options);
    if (!preview.canImport) throw new HttpError(409, "capsule_snapshot_revoked", "This hosted snapshot has been revoked.");
    const channel = ["delivery", "link"].includes(String(options.channel)) ? String(options.channel) : "file";
    // Where the pack came from, kept beside everything it brings and never rewritten (plan §7): the author's account (internal)
    // and display name, the snapshot's hash, when it was made and by which channel it reached this account.
    const share = { authorId: author.id, authorName: author.name, snapshotHash: preview.manifestSha256, sharedAt: preview.sharedAt, channel };
    if (upgrade) return this.#upgrade(userId, preview, upgrade, guards, share, signingKeyFingerprint);
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
          issuerTrust: preview.issuerTrust, signingKeyFingerprint, importedAt: new Date().toISOString(), authorId: share.authorId, channel },
        share,
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
        provenance: [{ type: "import", id: `${preview.snapshotId}:${entry.id}` }], share,
        transfer: { version: entry.version, sha256: entry.sha256, path: entry.path, snapshotId: preview.snapshotId, issuerTrust: preview.issuerTrust },
      } })),
    ], { guards, accountCreatedAt }); } catch (error) {
      if (error.code === "product_guard_conflict") throw new HttpError(409, "capsule_snapshot_revoked", "The hosted snapshot was revoked or changed before import.");
      throw error;
    }
    recordShareImported(channel);
    return records[0];
  }

  /**
   * Take a newer snapshot of a pack the account holds in place: the same
   * capsule, so whether and where it is in force does not change; its card,
   * transfer record and scan move to the new snapshot; the entries the new
   * snapshot no longer carries are retired, and what it carries is written as
   * this pack's. One transaction, so no reader sees both or neither.
   * A newer snapshot is a different pack: whatever the account had kept of the old one does not count towards this one
   * (`keptSince` starts again), so an author cannot earn corroboration with a harmless snapshot and replace it with another.
   * @param {string} userId @param {any} preview @param {any} upgrade @param {readonly any[]} guards @param {Record<string, any>} share
   * @param {string} signingKeyFingerprint
   */
  async #upgrade(userId, preview, upgrade, guards, share, signingKeyFingerprint) {
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
            provenance: [{ type: "import", id: `${preview.snapshotId}:${entry.id}` }], share,
            transfer: { version: entry.version, sha256: entry.sha256, path: entry.path, snapshotId: preview.snapshotId, issuerTrust: preview.issuerTrust },
          }, { expectedRevision: 0, transactionClient: client });
        }
        return this.documents.put(userId, "capsule", upgrade.capsule.id, {
          ...upgrade.capsule.payload,
          transfer: { ...upgrade.capsule.payload.transfer, snapshotId: preview.snapshotId, archiveSha256: preview.archiveSha256,
            manifestSha256: preview.manifestSha256, issuerId: preview.issuerId, issuerTrust: preview.issuerTrust, signingKeyFingerprint, upgradedAt: at,
            previousSnapshotId: upgrade.capsule.payload.transfer?.snapshotId ?? null, authorId: share.authorId, channel: share.channel },
          share,
          ...(upgrade.capsule.payload.keptSince ? { keptSince: at } : {}),
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
      // With the account's lock held no deletion is mid-flight, so a pending state for the generation that is still live is a
      // deletion that rolled back: it is released here rather than answered 409 for good (review C-11).
      const pending = await this.identities.deletionState(userId);
      if (pending?.phase === "pending" && pending.accountCreatedAt === row.generation) await this.#releaseRolledBackDeletion(userId, pending);
      await this.identities.assertAccountActive(userId, row.generation);
      return operation ? operation() : row.generation;
    });
  }

  /**
   * Put the capsule side of an account back as it was before a deletion that rolled back, and say so: a counter and the
   * operator's audit line. The cause of the rollback is the deletion's own error, which the route has already answered; what is
   * recorded here is that the state had to be released and for which account. @param {string} userId @param {any} state
   */
  async #releaseRolledBackDeletion(userId, state) {
    await this.identities.restoreAfterRolledBackDeletion(userId, state);
    recordAccountCleanup("rolled_back");
    this.report("rolled_back", { userId });
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
        // DB rollback leaves the original live account and its private keys intact, and nothing else will clear the state.
        if (live?.generation === state.accountCreatedAt) {
          await this.#releaseRolledBackDeletion(userId, state);
          return { completed: false, rolledBack: true };
        }
        // Private extension roots are account-owned, so a recreated account
        // must not have its new files erased by an older pending deletion.
        if (live && this.privateAccountCleanup) return { completed: false, awaitingAccountDeletion: true };
        const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-snapshots");
        const files = await fs.opendir(directory);
        for await (const file of files) {
          if (file.name.startsWith(`${capsuleAccountHash(userId)}-`) && /\.evimedcap(?:\.[a-f0-9-]{36}\.tmp)?$/.test(file.name)) await unlinkCapsuleFile(directory, file.name);
        }
        await syncCapsuleDirectory(directory);
        await this.privateAccountCleanup?.(userId);
        await this.identities.finishDeletion(userId, state);
        recordAccountCleanup("completed");
        return { completed: true };
      });
    } catch (error) {
      // The cleanup stays pending and is retried; what stopped it is kept as a code (it used to be thrown away).
      recordAccountCleanup("failed");
      this.report("cleanup_failed", { userId, code: causeCode(error) });
      throw Object.assign(new HttpError(503, "capsule_cleanup_pending", "The account is removed, but protected capsule cleanup must be retried."), { cause: error });
    }
  }

  /**
   * Durable post-commit cleanup resumes after restart; failures remain pending for the next attempt. `rolledBack` counts the
   * states of accounts that are still here (their deletion did not commit), released; `causes` is the codes that kept a cleanup
   * from finishing.
   * @returns {Promise<{ completed: number, pending: number, rolledBack: number, causes: string[] }>}
   */
  async recoverPendingDeletions() {
    /** @type {{ completed: number, pending: number, rolledBack: number, causes: string[] }} */
    const results = { completed: 0, pending: 0, rolledBack: 0, causes: [] };
    for (const userId of await this.identities.pendingDeletions()) {
      try {
        const result = await this.finishAccountDeletion(userId);
        if (result.rolledBack) results.rolledBack++;
        else results[result.completed ? "completed" : "pending"]++;
      } catch (error) { results.pending++; results.causes.push(causeCode(error)); }
    }
    results.causes = [...new Set(results.causes)];
    return results;
  }

}

// The container layout an import accepts, byte for byte, for the one other
// producer of packs: `scripts/ops/pack-lineage-capsule.mjs`. A copy of these two
// functions there would be a second definition of what `inspect` compares
// against, and the first change to either would make every lineage pack
// unimportable without a test noticing.
export { location as capsuleTransferLocation, renderedFiles as renderCapsuleTransferFiles };
