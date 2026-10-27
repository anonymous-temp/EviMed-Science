// A copy of an official pack the platform took off the shelf is given back when the pack is published again, so that it can continue to the version
// published. If that continuation fails, the copy must not stay restored with the approved facts it had: `methodsFor` mounts every undeleted copy
// (2026-10-27 review). Against an in-memory ledger; the end-to-end shelf, on a real PostgreSQL, is `officialPacks.integration.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";
import { OfficialPacks } from "../src/officialPacks.mjs";

const USER = "shelf-user";
const COPY = "official-copy:shared-practices";
const PUBLICATION = { packId: "shared-practices", contentHash: "h2", version: 2, methods: [] };

/** A ledger of capsule documents with the deletion and restore rules the shelf relies on. @param {Record<string, any>} [payload] */
function ledgerWith(payload) {
  /** @type {Map<string, any>} */ const rows = new Map([[`${USER}:capsule:${COPY}`, { id: COPY, payload: { imported: true, official: { packId: "shared-practices", contentHash: "h1" }, withdrawnByPlatform: true, ...payload }, revision: 3, deletedAt: "2026-10-26T00:00:00Z" }]]);
  const key = (userId, kind, id) => `${userId}:${kind}:${id}`;
  return {
    rows,
    failRemove: false,
    async get(userId, kind, id, { includeDeleted = false } = {}) {
      const row = rows.get(key(userId, kind, id));
      return !row || (row.deletedAt && !includeDeleted) ? null : structuredClone(row);
    },
    async put(userId, kind, id, next, { expectedRevision, restoreDeleted = false }) {
      const row = rows.get(key(userId, kind, id));
      if (!row || row.revision !== expectedRevision || (row.deletedAt && !restoreDeleted)) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
      Object.assign(row, { payload: structuredClone(next), revision: row.revision + 1, deletedAt: restoreDeleted ? null : row.deletedAt });
      return structuredClone(row);
    },
    async remove(userId, kind, id, expectedRevision) {
      const row = rows.get(key(userId, kind, id));
      if (this.failRemove) throw Object.assign(new Error("down"), { code: "product_unavailable" });
      if (!row || row.revision !== expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
      Object.assign(row, { revision: row.revision + 1, deletedAt: "2026-10-27T00:00:00Z" });
      return structuredClone(row);
    },
    async list(userId, kind) {
      return { items: [...rows.entries()].filter(([name, row]) => name.startsWith(`${userId}:${kind}:`) && !row.deletedAt).map(([, row]) => structuredClone(row)), nextCursor: null };
    },
  };
}

function shelf(documents, adopt, reports = []) {
  const packs = new OfficialPacks({ documents: /** @type {any} */ (documents), database: { query: async () => ({ rows: [{ auth_type: "password" }] }) },
    transfers: /** @type {any} */ ({ adoptOfficial: adopt }), scanner: /** @type {any} */ (null), report: (line) => reports.push(line) });
  packs.publications = [PUBLICATION];
  return packs;
}

test("a copy given back for an upgrade that then fails goes off the shelf again, and is given back at the next good pass", async () => {
  const documents = ledgerWith();
  /** @type {string[]} */ const reports = [];
  let failing = true;
  const seen = [];
  const packs = shelf(documents, async (_user, _publication, { existing }) => {
    seen.push(existing.deletedAt ?? null);
    if (failing) throw Object.assign(new Error("db"), { code: "capsule_adoption_failed" });
    return "upgraded";
  }, reports);
  await packs.ensureFor(USER);
  const held = documents.rows.get(`${USER}:capsule:${COPY}`);
  assert.deepEqual(seen, [null], "the upgrade was handed the copy restored");
  assert.ok(held.deletedAt, "the copy is off the shelf again");
  assert.equal(held.payload.withdrawnByPlatform, true, "and marked as the platform's doing, so that a later publication gives it back");
  assert.deepEqual((await documents.list(USER, "capsule")).items, [], "nothing of it is left for a mount to read");
  assert.deepEqual([packs.counters.adoption.failed, packs.counters.adoption.reshelved], [1, 1]);
  assert.ok(reports.some((line) => /not adopted: capsule_adoption_failed/.test(line)));
  // The next pass does not trust the settled stamp (the failed one is not recorded) and gives the copy back, this time to a good upgrade.
  failing = false;
  const result = await packs.ensureFor(USER);
  assert.deepEqual([result.upgraded, held.deletedAt, held.payload.withdrawnByPlatform], [1, null, undefined]);
  assert.equal(packs.counters.adoption.upgraded, 1);
});

test("a copy that was on the shelf all along stays there when its upgrade fails, and a copy that cannot be taken off again is said", async () => {
  const alive = ledgerWith({ withdrawnByPlatform: undefined });
  alive.rows.get(`${USER}:capsule:${COPY}`).deletedAt = null;
  const kept = shelf(alive, async () => { throw Object.assign(new Error("db"), { code: "capsule_adoption_failed" }); });
  await kept.ensureFor(USER);
  assert.equal(alive.rows.get(`${USER}:capsule:${COPY}`).deletedAt, null, "an upgrade that fails leaves the copy the person had as it was");
  assert.equal(kept.counters.adoption.reshelved, 0);
  const stuck = ledgerWith();
  stuck.failRemove = true;
  /** @type {string[]} */ const reports = [];
  const packs = shelf(stuck, async () => { throw Object.assign(new Error("db"), { code: "capsule_adoption_failed" }); }, reports);
  await packs.ensureFor(USER);
  assert.equal(packs.counters.adoption.reshelved, 0);
  assert.ok(reports.some((line) => /could not be taken off the shelf again: product_unavailable/.test(line)), reports.join("\n"));
  assert.ok(reports.some((line) => /not adopted: capsule_adoption_failed/.test(line)), "the upgrade's own failure is still the one reported");
});
