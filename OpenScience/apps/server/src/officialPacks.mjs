/**
 * The platform's base tier of methods: official starter packs from 「EviMed 证据中心」, published once and held by every ordinary account.
 *
 * Why it exists: a person's own learning loop has little to learn from while they have used the platform little, and pooled methods beat
 * personal ones when data is thin (SkillsBench; owner decision 2026-10-25, item 2). So the platform writes a handful of focused methods
 * itself, from texts it has already vetted (`capsules/official/`, read by `officialPackSources.mjs`), and every account starts with them.
 * What a person's own work teaches comes before them (`selectOfficialMethods`).
 *
 * Hidden knowledge:
 *
 * - **A pack is published, not distributed from the folder.** At start each pack's source is hashed; a pack whose hash is the one already
 *   published is left alone (every restart of every replica is a no-op), and one that changed is scanned once (`capsuleScan.mjs`: the closed
 *   sets and the model judge), sealed and signed by the publisher account with the same code a person's pack is (`CapsuleTransferService
 *   .publishOfficial`), recorded as `official-pack:<id>` on the publisher account, and continues the version before it. The scan is the
 *   publisher's, and its verdict is what every account's copy carries: nothing here pays for a model call per account. The texts are the
 *   platform's own, reviewed before they reach the folder, so a model that cannot be reached does not hold a pack back (the verdict says it
 *   did not run); an entry the scan flags is not published.
 * - **An account's copy is made when the account first reads its capsules**, not when it is created. Creation is several routes (a
 *   password, an identity provider, a credit account) inside the account's own transaction, and a hook in each would be a place for a pack to be
 *   silently missing; every read of the shelf and every mount is one place, and it is idempotent (`ensureFor`): the copy's id is fixed per
 *   account and pack, so two readers racing make one copy, and an account that already holds the version does nothing but read it. An account
 *   that cannot hold a capsule of its own (a platform account, an integration's subject account) is not given one.
 * - **A copy is a received pack, kept apart from the eight.** It is written as any received pack is (`receivedPackRecords`), shown on the shelf
 *   with its sender, taken down by the same takedown; but it is enabled by a flag on the copy (`official.disabled`) and never by the account's
 *   list of capsules in force, so it does not count towards the eight. A pack its account switched off stays off when its next version arrives,
 *   and a copy the account deleted is not made again.
 * - **The counters are the platform's, across accounts.** What the researcher did after a run that opened an official method is folded into
 *   that method's record (`official-method:<pack>:<method>:<body>`) with the same fold and the same sequential harm test a learned method's
 *   own runs go through (`foldApplied`, `methodHarmTest`); a body whose accounts' runs say it is harmful is stopped for everyone, at once, with
 *   the reason on the record (`status: stopped`), and given back by an operator in one command (`restore`). A new body is a new record: the
 *   counts of a text are about that text.
 * - **Promotion shares this machinery.** A person's general method that passed the promotion gates (`officialPromotion.mjs`) is one more
 *   method of the pack 「大家的做法」, which is published from those records the way the other packs are published from the folder.
 *
 * Which model capability would make it deletable: a model that does not need to be told how to write a weekly report without inventing its
 * figures.
 *
 * @module officialPacks
 */

import { PLATFORM_ACCOUNT_AUTH_TYPE, PLATFORM_PUBLISHER_NAME, PLATFORM_PUBLISHER_USER_ID, emptyLearning, foldApplied, methodHarmTest } from "@evimed/domain";
import { OFFICIAL_PACKS_DIR, officialPack, readOfficialPackSources } from "./officialPackSources.mjs";

/** The publisher's record of a published pack, of a method body's outcomes, and of a promoted method (`officialPromotion.mjs`). */
export const OFFICIAL_PACK_RECORD = "official-pack";
export const OFFICIAL_METHOD_RECORD = "official-method";
export const OFFICIAL_PROMOTED_RECORD = "official-promoted";
/** The pack that is made of promoted methods, and what it is called. */
export const SHARED_PRACTICES_PACK_ID = "shared-practices";
export const SHARED_PRACTICES_TITLE = "大家的做法";
const SHARED_PRACTICES_SUMMARY = "用过的人普遍觉得好用、也不涉及任何个人内容的做法，EviMed 收集在这里，所有人都可以用。";

/** What one method body keeps of its runs: the newest observations are enough for the sequential test, which reads forty at most. */
const OBSERVATION_LIMIT = 200;
/** How long what is read from the ledger for the mount (the stopped bodies) may be reused, in ms: a stop takes effect within this. */
const STOPPED_TTL_MS = 15_000;
/** How many times a seal is asked again when the password derivation was busy. */
const SEAL_RETRIES = 4;
/** The accounts whose copies are known to be current, and how many are remembered. */
const SETTLED_LIMIT = 5_000;

/** The key one method body's record is kept under. @param {string} methodKey @param {string} sha */
export const officialBodyKey = (methodKey, sha) => `${methodKey}@${sha}`;

/** The counters of this process, for the operator's metrics (`officialPackMetricFamilies`). */
function newCounters() {
  return {
    /** Packs at start: published as a new version, left alone because unchanged, refused because nothing in them passed, lost to another writer. */
    publication: { published: 0, unchanged: 0, refused: 0, lost: 0, failed: 0 },
    /** What the folder's texts were refused for, by the closed reason. */
    sourceIssues: /** @type {Record<string, number>} */ ({}),
    /** The scan of each published version, by what the model did. */
    scan: { ok: 0, partial: 0, unavailable: 0 },
    /** A method flagged by the scan and left out of its pack. */
    flagged: 0,
    /** Accounts' copies made, continued to a newer version, and found current. */
    adoption: { created: 0, upgraded: 0, unchanged: 0, removed: 0, failed: 0 },
    /** What a run was given: official cards offered, left out because the person's own method covers the same thing, the nearness could not be read. */
    mount: { offered: 0, leftOutPersonal: 0, deltaUnread: 0 },
    /** The official methods runs opened. */
    opened: 0,
    /** The applied outcomes folded into the records, and the bodies stopped for harm or given back. */
    applied: { corrected: 0, clean: 0 },
    stopped: 0,
    restored: 0,
  };
}

/**
 * @typedef {object} OfficialMethod
 * @property {string} key `official:<pack>:<method>`: the method across its versions
 * @property {string} packId @property {string} methodId @property {string} name @property {string} description @property {string} whenToUse
 * @property {string[]} scope @property {string} body @property {string} sha the body's own hash
 * @property {string} entryId the fact it is held as in the account @property {string} capsuleId
 */

export class OfficialPacks {
  /**
   * @param {{ documents: import('./productStore.mjs').ProductDocuments, database: any, transfers: import('./capsuleTransferService.mjs').CapsuleTransferService,
   *   scanner: import('./capsuleScan.mjs').CapsuleScanner, scanOwner?: (() => Promise<{ userId: string, projectId: string }>) | null,
   *   sourcesDir?: string, publisherId?: string, publisherName?: string, enabled?: boolean, now?: () => Date, report?: (line: string) => void }} options
   *   `scanOwner` names the account and project the one model scan of a version is metered to; absent, the publisher's `default` project.
   */
  constructor({ documents, database, transfers, scanner, scanOwner = null, sourcesDir = OFFICIAL_PACKS_DIR, publisherId = PLATFORM_PUBLISHER_USER_ID,
    publisherName = PLATFORM_PUBLISHER_NAME, enabled = true, now = () => new Date(), report = () => {} }) {
    this.documents = documents;
    this.database = database;
    this.transfers = transfers;
    this.scanner = scanner;
    this.scanOwner = scanOwner;
    this.sourcesDir = sourcesDir;
    this.publisherId = publisherId;
    this.publisherName = publisherName;
    this.enabled = enabled;
    this.now = now;
    this.report = report;
    this.counters = newCounters();
    /** The packs held now, as published; null until the first read. @type {any[] | null} */
    this.publications = null;
    /** Accounts whose copies were current at the publications' stamp. @type {Map<string, string>} */
    this.settled = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.inflight = new Map();
    /** The pass in flight (`publishAll`). @type {Promise<any> | null} */
    this.publishing = null;
    /** @type {{ at: number, bodies: Set<string> } | null} */
    this.stoppedCache = null;
  }

  // -------------------------------------------------------------------------------------------------------------- publication

  /**
   * Publish what the folder (and the promoted methods) say, once each. Idempotent and never throws for a pack's fault: a pack that cannot
   * be published is said on the report line and counted, and the previous version stays what accounts are given.
   * @returns {Promise<{ packId: string, state: "published" | "unchanged" | "refused" | "lost" | "failed", version?: number }[]>}
   */
  async publishAll() {
    if (!this.enabled) return [];
    // One pass at a time in a process: a second caller is given the first's answer, and the password derivation of a seal (one at a time per
    // account) is never asked for by two of this process's own passes.
    if (this.publishing) return this.publishing;
    this.publishing = this.#publishAll().finally(() => { this.publishing = null; });
    return this.publishing;
  }

  async #publishAll() {
    const { packs, issues } = await readOfficialPackSources(this.sourcesDir);
    for (const issue of issues) {
      this.counters.sourceIssues[issue.issue] = (this.counters.sourceIssues[issue.issue] ?? 0) + 1;
      this.report(`official pack source refused: ${[issue.pack, issue.method].filter(Boolean).join("/")} ${issue.issue}`);
    }
    const promoted = await this.#promotedPack();
    const sources = promoted ? [...packs, promoted] : packs;
    /** @type {{ packId: string, state: "published" | "unchanged" | "refused" | "lost" | "failed", version?: number }[]} */
    const results = [];
    for (const source of sources) {
      try { results.push(await this.#publish(source)); } catch (error) {
        this.counters.publication.failed += 1;
        this.report(`official pack ${source.id} not published: ${/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.name ?? "error"}`);
        results.push({ packId: source.id, state: "failed" });
      }
    }
    // A pack the folder no longer has is withdrawn: not given to accounts any more, and removed from the shelves that hold it. Only when the folder
    // was read and holds packs: an image that lost its folder, or one whose texts are all refused, is a mistake to be said and not an instruction to
    // take every pack off every shelf.
    const live = new Set(sources.map((source) => source.id));
    const trustworthy = packs.length > 0 && !issues.some((issue) => issue.issue === "directory_missing");
    for (const row of trustworthy ? await this.#publicationRows() : []) {
      if (row.payload.status === "published" && !live.has(row.payload.packId) && !issues.some((issue) => issue.pack === row.payload.packId)) {
        await this.documents.put(this.publisherId, "preferences", row.id, { ...row.payload, status: "withdrawn", withdrawnAt: this.now().toISOString() }, { expectedRevision: row.revision })
          .catch(() => null);
        if (row.payload.snapshotId) await this.transfers.retireOfficialSnapshot(this.publisherId, row.payload.snapshotId).catch(() => null);
      }
    }
    this.publications = null;
    this.settled.clear();
    return results;
  }

  /** Resolves when the publication pass in flight, if any, has ended: a shutdown waits for it, and a failure of it is the pass's own to say. */
  async idle() {
    await this.publishing?.catch(() => null);
  }

  /** The pack made of promoted methods, from the publisher's records of them; null while there is none. */
  async #promotedPack() {
    const rows = await this.#listAll(OFFICIAL_PROMOTED_RECORD);
    const methods = rows.filter((row) => row.payload.status === "active").map((row) => row.payload.method).filter(Boolean);
    if (!methods.length) return null;
    return officialPack({ id: SHARED_PRACTICES_PACK_ID, title: SHARED_PRACTICES_TITLE, summary: SHARED_PRACTICES_SUMMARY, order: 1000, methods });
  }

  /** @param {string} recordType @returns {Promise<any[]>} every record of the publisher account of this type, newest first */
  async #listAll(recordType) {
    /** @type {any[]} */
    const rows = [];
    /** @type {string | null} */
    let cursor = null;
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await this.documents.list(this.publisherId, "preferences", { limit: 100, cursor, filter: { recordType } });
      rows.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return rows;
  }

  async #publicationRows() { return this.#listAll(OFFICIAL_PACK_RECORD); }

  /** @param {ReturnType<typeof officialPack>} source */
  async #publish(source) {
    const id = `official-pack:${source.id}`;
    const previous = await this.documents.get(this.publisherId, "preferences", id);
    if (previous?.payload.status === "published" && previous.payload.contentHash === source.contentHash) {
      this.counters.publication.unchanged += 1;
      return { packId: source.id, state: /** @type {const} */ ("unchanged"), version: Number(previous.payload.version) };
    }
    const owner = (await this.scanOwner?.().catch(() => null)) ?? { userId: this.publisherId, projectId: "default" };
    const scan = await this.scanner.scan(owner, source.methods.map((method) => ({ id: method.key, factKind: "method_preference", content: method.content })), { useModel: true });
    this.counters.scan[/** @type {"ok" | "partial" | "unavailable"} */ (scan.model)] += 1;
    for (const dropped of scan.dropped) {
      this.counters.flagged += 1;
      this.report(`official method refused by the scan: ${dropped.id} ${dropped.code}`);
    }
    const kept = source.methods.filter((method) => scan.kept.includes(method.key));
    if (!kept.length) {
      this.counters.publication.refused += 1;
      return { packId: source.id, state: /** @type {const} */ ("refused") };
    }
    const version = Number(previous?.payload.version ?? 0) + 1;
    const made = await this.#sealed({ publisherId: this.publisherId, packId: source.id, version,
      methods: kept.map((method) => ({ key: method.key, content: method.content })),
      card: { title: source.title, author: this.publisherName, summary: source.summary },
      previousSnapshotId: previous?.payload.status === "published" ? previous.payload.snapshotId : null });
    const publishedAt = this.now().toISOString();
    const payload = {
      recordType: OFFICIAL_PACK_RECORD, status: "published", packId: source.id, title: source.title, contentHash: source.contentHash, version, publishedAt,
      publisherId: this.publisherId,
      snapshotId: made.snapshot.id, manifestSha256: made.snapshot.manifestSha256, archiveSha256: made.snapshot.archiveSha256, issuerId: made.issuerId,
      signingKeyFingerprint: made.signingKeyFingerprint, card: made.snapshot.card ?? null,
      scan: { model: scan.model, checkedAt: scan.checkedAt, dropped: scan.dropped, safety: scan.safety },
      methods: kept.map((method) => ({ key: method.key, packId: method.packId, methodId: method.id, name: method.name, description: method.description,
        whenToUse: method.whenToUse, scope: method.scope, body: method.body, content: method.content, sha: method.sha })),
      ...(previous ? { previous: { contentHash: previous.payload.contentHash, snapshotId: previous.payload.snapshotId ?? null, version: previous.payload.version ?? null } } : {}),
    };
    try {
      await this.documents.put(this.publisherId, "preferences", id, payload, { expectedRevision: previous?.revision ?? 0 });
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
      // Another control plane published first: its record is the pack, and this snapshot is nobody's.
      await this.transfers.retireOfficialSnapshot(this.publisherId, made.snapshot.id).catch(() => null);
      this.counters.publication.lost += 1;
      return { packId: source.id, state: /** @type {const} */ ("lost") };
    }
    if (previous?.payload.snapshotId && previous.payload.snapshotId !== made.snapshot.id) {
      await this.transfers.retireOfficialSnapshot(this.publisherId, previous.payload.snapshotId).catch(() => null);
    }
    this.counters.publication.published += 1;
    return { packId: source.id, state: /** @type {const} */ ("published"), version };
  }

  /**
   * The seal of a pack, asked again after the wait it names when the platform's one password derivation at a time was busy (another control plane
   * starting beside this one, or a person's export): a pack that waits a few seconds is published, and one that was given up on waited a restart.
   * @param {Parameters<import('./capsuleTransferService.mjs').CapsuleTransferService["publishOfficial"]>[0]} input
   */
  async #sealed(input) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.transfers.publishOfficial(input); } catch (error) {
        if (/** @type {any} */ (error)?.code !== "capsule_password_busy" || attempt >= SEAL_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.max(250, Number(/** @type {any} */ (error)?.retryAfterSeconds ?? 2) * 1_000)));
      }
    }
  }

  /** The packs as published now, in the shelf's order. @returns {Promise<any[]>} */
  async current() {
    if (!this.publications) {
      this.publications = (await this.#publicationRows()).map((row) => row.payload).filter((payload) => payload.status === "published")
        .sort((left, right) => String(left.packId) < String(right.packId) ? -1 : 1);
    }
    return this.publications;
  }

  // ------------------------------------------------------------------------------------------------------------ distribution

  /**
   * Bring one account's copies of the platform's packs to what is published: made when it has none, continued when it holds an older
   * version, left alone when current. Never throws — a shelf that cannot be brought up to date is read as it is, and the next read tries again.
   * @param {string} userId
   * @returns {Promise<{ created: number, upgraded: number, unchanged: number, removed: number } | null>} null for an account that is given none
   */
  async ensureFor(userId) {
    if (!this.enabled) return null;
    const held = this.inflight.get(userId);
    if (held) return held;
    const work = this.#ensure(userId).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, work);
    return work;
  }

  /** @param {string} userId */
  async #ensure(userId) {
    const publications = await this.current();
    const stamp = publications.map((publication) => `${publication.packId}:${publication.contentHash}`).join(",");
    if (this.settled.get(userId) === stamp) return { created: 0, upgraded: 0, unchanged: publications.length, removed: 0 };
    if (!await this.#ordinary(userId)) return null;
    const result = { created: 0, upgraded: 0, unchanged: 0, removed: 0 };
    let clean = true;
    for (const publication of publications) {
      try {
        const copy = await this.documents.get(userId, "capsule", `official-copy:${publication.packId}`, { includeDeleted: true });
        // What the account deleted is not made again; what an author or the operator took down stays down (`CapsuleTransferService.takeDown`).
        if (copy?.deletedAt || copy?.payload?.takenDown) { result.unchanged += 1; continue; }
        const outcome = await this.transfers.adoptOfficial(userId, publication, { existing: copy ?? null });
        result[outcome] += 1;
        this.counters.adoption[outcome] += 1;
      } catch (error) {
        clean = false;
        this.counters.adoption.failed += 1;
        // A changed publication or a version that moved under the write is read again next time; anything else is said.
        if (!["capsule_snapshot_revoked", "capsule_preview_changed", "product_account_changed"].includes(String(/** @type {any} */ (error)?.code))) {
          this.report(`official pack ${publication.packId} not adopted: ${/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.name ?? "error"}`);
        }
      }
    }
    // A pack that is no longer published is taken off the shelf it was on.
    const live = new Set(publications.map((publication) => `official-copy:${publication.packId}`));
    for (const copy of await this.#copies(userId)) {
      if (live.has(copy.id)) continue;
      try { await this.documents.remove(userId, "capsule", copy.id, copy.revision); result.removed += 1; this.counters.adoption.removed += 1; }
      catch { clean = false; }
    }
    if (clean) {
      if (this.settled.size >= SETTLED_LIMIT) this.settled.delete(/** @type {string} */ (this.settled.keys().next().value));
      this.settled.set(userId, stamp);
    }
    return result;
  }

  /** An account a person holds: not the platform's own, not an integration's subject. @param {string} userId */
  async #ordinary(userId) {
    const row = (await this.database.query("SELECT auth_type FROM evimed_control.users WHERE id=$1", [userId])).rows[0];
    return Boolean(row) && !["subject", PLATFORM_ACCOUNT_AUTH_TYPE].includes(String(row.auth_type));
  }

  /** The account's copies of official packs. @param {string} userId @returns {Promise<any[]>} */
  async #copies(userId) {
    /** @type {any[]} */
    const copies = [];
    /** @type {string | null} */
    let cursor = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await this.documents.list(userId, "capsule", { limit: 100, cursor, filter: { imported: true } });
      copies.push(...page.items.filter((/** @type {any} */ item) => item.payload?.official));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return copies;
  }

  // ------------------------------------------------------------------------------------------------------------------- the mount

  /**
   * The official methods this account may be given: those of its enabled copies that are in force, none that were stopped. Which of them a run
   * is given is the mount's decision (`selectOfficialMethods`).
   * @param {string} userId
   * @returns {Promise<OfficialMethod[]>}
   */
  async methodsFor(userId) {
    if (!this.enabled) return [];
    await this.ensureFor(userId).catch(() => null);
    const stopped = await this.stoppedBodies().catch(() => new Set());
    /** @type {OfficialMethod[]} */
    const methods = [];
    for (const copy of await this.#copies(userId)) {
      if (copy.payload.takenDown || copy.payload.official?.disabled === true) continue;
      const facts = (await this.documents.list(userId, "fact", { limit: 100, filter: { capsuleId: copy.id, status: "approved" } })).items;
      for (const fact of facts) {
        const held = fact.payload.official;
        if (!held?.key || !held.body || stopped.has(officialBodyKey(held.key, held.sha))) continue;
        methods.push({ key: held.key, packId: held.packId, methodId: held.methodId, name: held.name, description: held.description, whenToUse: held.whenToUse,
          scope: Array.isArray(held.scope) ? held.scope : [], body: held.body, sha: held.sha, entryId: String(fact.id), capsuleId: String(copy.id) });
      }
    }
    return methods.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  }

  /** The bodies the outcomes of runs stopped, as `key@sha`, read at most every few seconds. @returns {Promise<Set<string>>} */
  async stoppedBodies() {
    const now = Date.now();
    if (this.stoppedCache && now - this.stoppedCache.at < STOPPED_TTL_MS) return this.stoppedCache.bodies;
    const rows = (await this.#listAll(OFFICIAL_METHOD_RECORD)).filter((row) => row.payload.status === "stopped");
    const bodies = new Set(rows.map((row) => officialBodyKey(row.payload.key, row.payload.sha)));
    this.stoppedCache = { at: now, bodies };
    return bodies;
  }

  // ----------------------------------------------------------------------------------------------------------------- counters

  /** A mount told what it did, for the operator's counters. @param {"offered" | "leftOutPersonal" | "deltaUnread"} what @param {number} [count] */
  noteMount(what, count = 1) { this.counters.mount[what] += Math.max(0, Math.trunc(count) || 0); }

  /** A run opened an official method. @param {number} [count] */
  noteOpened(count = 1) { this.counters.opened += Math.max(0, Math.trunc(count) || 0); }

  /**
   * What became of one run that opened an official method, from the researcher's own next words (`methodAppliedOutcomes.mjs`): folded into
   * the method body's record, once per run, and read by the sequential harm test. A body the test finds harmful is stopped for every account
   * (`status: stopped`, with the numbers it was stopped on) and the mount stops offering it within seconds.
   * @param {{ key: string, sha: string, runId: string, outcome: "corrected" | "clean", at: string }} applied
   * @returns {Promise<{ changed: boolean, stopped: boolean }>}
   */
  async recordApplied({ key, sha, runId, outcome, at }) {
    const parsed = key.split(":");
    if (parsed[0] !== "official" || parsed.length !== 3 || !sha) return { changed: false, stopped: false };
    const id = `official-method:${parsed[1]}:${parsed[2]}:${String(sha).slice(0, 12)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await this.documents.get(this.publisherId, "preferences", id);
      const base = row?.payload ?? { recordType: OFFICIAL_METHOD_RECORD, key, sha, packId: parsed[1], methodId: parsed[2], status: "active", learning: emptyLearning(sha), createdAt: this.now().toISOString() };
      if (base.status === "stopped") return { changed: false, stopped: true };
      const learning = foldApplied(base.learning, { runId, outcome, at });
      if (learning === base.learning) return { changed: false, stopped: false };
      const trimmed = { ...learning, observations: (learning.observations ?? []).slice(-OBSERVATION_LIMIT) };
      const verdict = methodHarmTest(trimmed);
      const stopped = verdict.state === "harm";
      const payload = { ...base, learning: trimmed,
        ...(stopped ? { status: "stopped", stopped: { at: this.now().toISOString(), reason: "harm", runs: verdict.runs, bad: verdict.bad, llr: verdict.llr } } : {}) };
      try {
        if (row) await this.documents.put(this.publisherId, "preferences", id, payload, { expectedRevision: row.revision, telemetry: !stopped });
        else await this.documents.put(this.publisherId, "preferences", id, payload, { expectedRevision: 0 });
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "product_revision_conflict" && attempt < 4) continue;
        throw error;
      }
      this.counters.applied[outcome] += 1;
      if (stopped) {
        this.counters.stopped += 1;
        this.stoppedCache = null;
        this.report(`official method stopped: ${key} corrected ${verdict.bad} of ${verdict.runs} runs`);
      }
      return { changed: true, stopped };
    }
    return { changed: false, stopped: false };
  }

  /**
   * Give a stopped body back: the record is active again with its runs counted from nothing, because what stopped it was read against the
   * body as it was; and the mount offers it again within seconds. One call, with the reason it was stopped still on the record's history.
   * @param {string} key `official:<pack>:<method>` @param {string} sha the body's hash (or its first twelve characters)
   * @returns {Promise<boolean>}
   */
  async restore(key, sha) {
    const parsed = key.split(":");
    if (parsed[0] !== "official" || parsed.length !== 3) return false;
    const id = `official-method:${parsed[1]}:${parsed[2]}:${String(sha).slice(0, 12)}`;
    const row = await this.documents.get(this.publisherId, "preferences", id);
    if (!row || row.payload.status !== "stopped") return false;
    await this.documents.put(this.publisherId, "preferences", id, { ...row.payload, status: "active", learning: emptyLearning(row.payload.sha),
      restoredAt: this.now().toISOString(), restoredFrom: row.payload.stopped }, { expectedRevision: row.revision });
    this.stoppedCache = null;
    this.counters.restored += 1;
    return true;
  }

  /**
   * What an operator reads: each published pack, and each method body that has outcomes or was stopped, with its numbers and the reason.
   * @returns {Promise<{ packs: any[], methods: any[] }>}
   */
  async snapshot() {
    const packs = (await this.#publicationRows()).map((row) => ({ packId: row.payload.packId, status: row.payload.status, version: row.payload.version, contentHash: row.payload.contentHash,
      publishedAt: row.payload.publishedAt, methods: (row.payload.methods ?? []).map((/** @type {any} */ method) => ({ key: method.key, sha: method.sha })) }));
    const methods = (await this.#listAll(OFFICIAL_METHOD_RECORD)).map((row) => {
      const harm = methodHarmTest(row.payload.learning ?? emptyLearning(row.payload.sha));
      return { key: row.payload.key, sha: row.payload.sha, status: row.payload.status, runs: harm.runs, corrected: harm.bad, test: harm.state, ...(row.payload.stopped ? { stopped: row.payload.stopped } : {}) };
    });
    return { packs, methods };
  }

  /** @returns {ReturnType<typeof newCounters>} */
  stats() { return JSON.parse(JSON.stringify(this.counters)); }
}

/**
 * The operator's counters for the platform's official packs.
 * @param {ReturnType<OfficialPacks["stats"]> | null | undefined} stats
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function officialPackMetricFamilies(stats) {
  if (!stats) return [];
  /** @param {Record<string, number>} map @param {string} label */
  const series = (map, label) => Object.entries(map).map(([key, value]) => ({ value, labels: { [label]: key } }));
  return [
    { name: "open_science_official_pack_publications_total", type: "counter", series: series(stats.publication, "result"),
      help: "The platform's official packs at start: published as a new version, unchanged since the last start, refused because nothing in them passed the scan, lost to another control plane, or failed." },
    { name: "open_science_official_pack_source_issues_total", type: "counter", series: series(stats.sourceIssues, "issue"),
      help: "Texts in the official packs' folder that were refused, by the reason." },
    { name: "open_science_official_pack_scans_total", type: "counter", series: series(stats.scan, "model"),
      help: "The one scan of each published official pack version, by what the model did: judged every entry, some, or none." },
    { name: "open_science_official_method_flagged_total", type: "counter", series: [{ value: stats.flagged }],
      help: "Official methods the scan flagged and left out of their pack." },
    { name: "open_science_official_pack_adoptions_total", type: "counter", series: series(stats.adoption, "result"),
      help: "Accounts' copies of official packs: made, continued to a newer version, found current, removed because the pack is no longer published, or failed (read again next time)." },
    { name: "open_science_official_method_mount_total", type: "counter", series: series(stats.mount, "result"),
      help: "Official methods in the mount: offered to a run, left out because the person's own method says the same thing (`leftOutPersonal`), or not decided because the closeness could not be read (`deltaUnread`)." },
    { name: "open_science_official_method_opened_total", type: "counter", series: [{ value: stats.opened }],
      help: "Official methods a run opened after being offered them." },
    { name: "open_science_official_method_applied_total", type: "counter", series: series(stats.applied, "outcome"),
      help: "What the researcher did after a run that opened an official method, across accounts: corrected it, or moved on." },
    { name: "open_science_official_method_stopped_total", type: "counter", series: [{ value: stats.stopped }],
      help: "Official method bodies stopped for every account by the sequential harm test over their runs." },
    { name: "open_science_official_method_restored_total", type: "counter", series: [{ value: stats.restored }],
      help: "Stopped official method bodies an operator gave back." },
  ];
}
