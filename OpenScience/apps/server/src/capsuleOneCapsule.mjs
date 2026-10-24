import {
  ACTIVATION_KEY, ACTIVE_CAPSULE_LIMIT, LEGACY_NOTES_CAPSULE_PREFIX, LEGACY_PROJECT_ACTIVATION_PREFIX,
} from "./capsuleService.mjs";
import { entryProject } from "./capsuleEntryProject.mjs";
import { capsuleMemoryRoot } from "./openVikingClient.mjs";
import { migrateProductStore } from "./productPersistence.mjs";

/**
 * One capsule per person (2026-10-24, the owner's ruling: 「记忆胶囊有必要按项目拆分吗，没必要吧」).
 *
 * Until then a person's runs silently made a hidden 「项目笔记」 capsule for every project (`runtime-notes:<sha256(project)>`), put in
 * force for that project alone, and a received pack could be enabled for one project only (`active-capsules:project:<id>`). Both are
 * folded into the account's capsule here: a note becomes an entry of it, labelled with its project (`capsuleEntryProject.mjs`) and
 * read only in that project's conversations, as before; a project's list of packs joins the account's list.
 *
 * Hidden knowledge:
 *
 * - **Idempotent, and run at every start.** A rerun finds nothing to do: a notes capsule that was emptied is deleted, a project's list that
 *   was folded is deleted, and what an account has left is what the next pass finishes (a note written by a process of the release
 *   before, a fact whose revision moved under the move). So there is no done-marker to lose and none to forget to clear.
 * - **A note keeps its id, its text, its project and its history.** The move is one new revision of the same fact: `payload.capsuleId`
 *   is now the account capsule and `payload.movedFrom` says where it came from and why; the revisions before it are untouched and the
 *   document's `project_id` column (what a project's deletion cascades on) never changes. It is the same note, not a new one.
 * - **Restorable.** An emptied notes capsule and a folded list are soft-deleted, so the trash still holds them; the index copies of the
 *   emptied capsule's facts are withdrawn through the withdrawal ledger (`memoryIndexWithdrawals.mjs`) and, as for any deleted capsule, by
 *   the rebuild the capsule's deletion queues; the facts are published again under the account capsule by the rebuild their own update queues.
 * - **A notes capsule the person deleted stays deleted.** It is in the trash, and what it held was theirs to remove; a restored one is
 *   emptied by the next pass like any other.
 * - **The cap.** At most eight capsules are in force (`ACTIVE_CAPSULE_LIMIT`). The account's own come first, then the packs, the one
 *   enabled last ahead of the others (`keptSince`, the platform's record of when the account began keeping it in force). If the folded
 *   lists would hold more than eight, the ones that do not fit are left out of force — still on the received shelf, one click from
 *   enabled again — and named in the pass's report and log line.
 *
 * @module capsuleOneCapsule
 */

/** @typedef {{ userId: string, notesCapsules: number, entries: number, lists: number, dropped: { capsuleId: string, projectId: string | null }[], left: number }} OneCapsuleReport */

/** The reason stamped on a note that was moved, and in the log line of a pass. */
export const ONE_CAPSULE_REASON = "one-capsule-per-person";

/** Pages read of an account's capsules, lists and entries: far more than any account holds, and a bound so a pass cannot read for ever. */
const MAX_PAGES = 50;

/**
 * @param {any} documents @param {string} userId @param {string} kind @param {Record<string, any>} [filter]
 * @returns {Promise<any[]>}
 */
async function every(documents, userId, kind, filter = {}) {
  /** @type {any[]} */
  const items = [];
  /** @type {string | null} */
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await documents.list(userId, kind, { limit: 100, cursor, filter });
    items.push(...read.items);
    cursor = read.nextCursor ?? null;
    if (!cursor) break;
  }
  return items;
}

/**
 * Move each live entry of a notes capsule into the account capsule. An entry whose revision moved under the read is read again; one
 * that is gone, or that somebody else already moved, is left. Returns how many were moved.
 * @param {any} documents @param {string} userId @param {any} notes @param {any} account @param {string} at
 */
async function moveEntries(documents, userId, notes, account, at) {
  let moved = 0;
  for (const fact of await every(documents, userId, "fact", { capsuleId: notes.id })) {
    /** @type {any} */
    let current = fact;
    for (let attempt = 0; attempt < 3 && current; attempt += 1) {
      const project = entryProject(current) ?? entryProject(notes);
      try {
        await documents.put(userId, "fact", current.id, {
          ...current.payload, capsuleId: account.id, ...(project ? { projectId: project } : {}),
          movedFrom: { capsuleId: notes.id, at, reason: ONE_CAPSULE_REASON },
        }, { expectedRevision: current.revision });
        moved += 1;
        break;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
        current = await documents.get(userId, "fact", current.id);
        if (current?.payload?.capsuleId !== notes.id) break;
      }
    }
  }
  return moved;
}

/**
 * Fold the project lists of capsules into the account's list: the account's own capsules first, then the packs, newest enabled first,
 * each once, at most eight. The account's list is left alone when the project lists add nothing to it.
 * @param {import("./capsuleService.mjs").CapsuleService} capsules @param {string} userId @param {any[]} lists
 * @returns {Promise<{ dropped: { capsuleId: string, projectId: string | null }[] }>}
 */
async function foldLists(capsules, userId, lists) {
  const documents = capsules.documents;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const account = await capsules.active(userId);
    /** @type {Map<string, { capsuleId: string, mode: string, from: string | null, index: number, since: number }>} */
    const merged = new Map();
    const take = async (/** @type {any} */ item, /** @type {string | null} */ from) => {
      const capsuleId = String(item?.capsuleId ?? "");
      // A notes capsule is the thing being folded away; and a project's list can still name a capsule that is gone.
      if (!capsuleId || merged.has(capsuleId) || capsuleId.startsWith(LEGACY_NOTES_CAPSULE_PREFIX)) return;
      const capsule = await documents.get(userId, "capsule", capsuleId);
      if (from !== null && !capsule) return;
      merged.set(capsuleId, { capsuleId, mode: String(item.mode), from, index: merged.size, since: Date.parse(String(capsule?.payload?.keptSince ?? "")) || 0 });
    };
    for (const item of account.items) await take(item, null);
    for (const list of lists) {
      const project = String(list.id).slice(LEGACY_PROJECT_ACTIVATION_PREFIX.length) || null;
      for (const item of capsules.activationItems(list)) await take(item, project);
    }
    const entries = [...merged.values()];
    if (entries.some((entry) => entry.from !== null)) {
      const ordered = [...entries.filter((entry) => entry.mode === "own"), ...entries.filter((entry) => entry.mode !== "own")
        .sort((left, right) => right.since - left.since || left.index - right.index)];
      const kept = ordered.slice(0, ACTIVE_CAPSULE_LIMIT);
      try {
        await documents.put(userId, "preferences", ACTIVATION_KEY, { items: kept.map(({ capsuleId, mode }) => ({ capsuleId, mode })) },
          { expectedRevision: account.record?.revision ?? 0 });
        return { dropped: ordered.slice(ACTIVE_CAPSULE_LIMIT).map(({ capsuleId, from }) => ({ capsuleId, projectId: from })) };
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict" || attempt === 2) throw error;
        continue;
      }
    }
    return { dropped: [] };
  }
  return { dropped: [] };
}

/**
 * What an emptied capsule owes the recall index: the removal of its subtree, as a row of the withdrawal ledger written in a transaction
 * of its own (`memoryIndexWithdrawals.mjs`, the ledger every deletion uses), then asked for through `drain` when there is one. Never waited
 * on for an answer from the index.
 * @param {{ indexing: { accountGeneration: (userId: string) => Promise<string | null> },
 *   withdrawals: { migrate: () => Promise<unknown>, enqueue: (client: any, userId: string, uris: string[]) => Promise<unknown> },
 *   database: { transaction: (operation: (client: any) => Promise<unknown>) => Promise<unknown> }, drain?: (() => unknown) | null }} dependencies
 * @returns {(userId: string, capsuleIds: string[]) => Promise<void>}
 */
export function indexWithdrawalOfCapsules({ indexing, withdrawals, database, drain = null }) {
  return async (userId, capsuleIds) => {
    const generation = await indexing.accountGeneration(userId);
    if (!generation) return;
    await withdrawals.migrate();
    await database.transaction((client) => withdrawals.enqueue(client, userId, capsuleIds.map((capsuleId) => capsuleMemoryRoot(userId, { accountCreatedAt: generation, capsuleId }))));
    void drain?.();
  };
}

/**
 * Fold one account's notes capsules and project lists into its one capsule. A no-op for an account that has neither.
 * @param {{ capsules: import("./capsuleService.mjs").CapsuleService, userId: string,
 *   withdrawIndex?: ((userId: string, capsuleIds: string[]) => Promise<unknown>) | null, log?: (line: string) => void, now?: () => Date }} input
 *   `withdrawIndex` owes the recall index the removal of an emptied capsule's subtree; it is never waited on for the pass to succeed.
 * @returns {Promise<OneCapsuleReport>}
 */
export async function foldIntoOneCapsule({ capsules, userId, withdrawIndex = null, log = () => {}, now = () => new Date() }) {
  const documents = capsules.documents;
  /** @type {OneCapsuleReport} */
  const report = { userId, notesCapsules: 0, entries: 0, lists: 0, dropped: [], left: 0 };
  // Only an account's own capsules can be notes capsules (`imported: false`), and only a list has `items`: what the filters leave out is
  // every received pack and every export snapshot, which an account can hold by the hundred.
  const notes = (await every(documents, userId, "capsule", { imported: false }))
    .filter((capsule) => String(capsule.id).startsWith(LEGACY_NOTES_CAPSULE_PREFIX) && capsule.payload?.imported !== true);
  const lists = (await every(documents, userId, "preferences", { items: [] }))
    .filter((record) => String(record.id).startsWith(LEGACY_PROJECT_ACTIVATION_PREFIX));
  if (notes.length === 0 && lists.length === 0) return report;
  const account = /** @type {any} */ (await capsules.ownCapsule(userId, { create: true }));
  const at = now().toISOString();
  /** @type {string[]} */
  const emptied = [];
  for (const capsule of notes) {
    report.entries += await moveEntries(documents, userId, capsule, account, at);
    // Emptied, or changed under the move: the next pass finishes what is left.
    if ((await documents.list(userId, "fact", { limit: 1, filter: { capsuleId: capsule.id } })).items.length > 0) { report.left += 1; continue; }
    const fresh = await documents.get(userId, "capsule", capsule.id);
    if (!fresh) continue;
    try { await documents.remove(userId, "capsule", fresh.id, fresh.revision); }
    catch (error) { if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error; report.left += 1; continue; }
    emptied.push(capsule.id);
  }
  report.notesCapsules = emptied.length;
  if (emptied.length > 0 && withdrawIndex) {
    try { await withdrawIndex(userId, emptied); }
    catch (error) { log(`capsule one-capsule: index withdrawal not owed (${typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "error"})`); }
  }
  if (lists.length > 0) {
    report.dropped = (await foldLists(capsules, userId, lists)).dropped;
    for (const list of lists) {
      for (let attempt = 0, current = list; attempt < 2 && current; attempt += 1) {
        try { await documents.remove(userId, "preferences", current.id, current.revision); report.lists += 1; break; }
        catch (error) {
          if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
          current = await documents.get(userId, "preferences", current.id);
        }
      }
    }
  }
  const dropped = report.dropped.map((item) => `${item.capsuleId}${item.projectId ? `@${item.projectId}` : ""}`).join(",");
  log(`capsule one-capsule: user=${userId} notes_capsules=${report.notesCapsules} entries=${report.entries} lists=${report.lists} left=${report.left}${dropped ? ` dropped_from_force=${dropped}` : ""}`);
  return report;
}

/**
 * Every account that still has a per-project notes capsule or list of packs, folded one at a time. One account's failure is said and
 * costs the others nothing. Safe to run at every start and beside a server that is serving.
 * @param {{ database: any, capsules: import("./capsuleService.mjs").CapsuleService,
 *   withdrawIndex?: ((userId: string, capsuleIds: string[]) => Promise<unknown>) | null, log?: (line: string) => void }} input
 * @returns {Promise<{ accounts: number, failed: number, entries: number, notesCapsules: number, lists: number }>}
 */
export async function foldAllIntoOneCapsule({ database, capsules, withdrawIndex = null, log = () => {} }) {
  await migrateProductStore(database);
  const owners = await database.query(`SELECT DISTINCT user_id FROM evimed_product.documents
    WHERE deleted_at IS NULL AND ((kind='capsule' AND id LIKE $1) OR (kind='preferences' AND id LIKE $2))
    ORDER BY user_id`, [`${LEGACY_NOTES_CAPSULE_PREFIX}%`, `${LEGACY_PROJECT_ACTIVATION_PREFIX}%`]);
  const total = { accounts: 0, failed: 0, entries: 0, notesCapsules: 0, lists: 0 };
  for (const row of owners.rows) {
    try {
      const report = await foldIntoOneCapsule({ capsules, userId: String(row.user_id), withdrawIndex, log });
      total.accounts += 1; total.entries += report.entries; total.notesCapsules += report.notesCapsules; total.lists += report.lists;
    } catch (error) {
      total.failed += 1;
      log(`capsule one-capsule: user=${row.user_id} failed (${typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "error"})`);
    }
  }
  return total;
}
