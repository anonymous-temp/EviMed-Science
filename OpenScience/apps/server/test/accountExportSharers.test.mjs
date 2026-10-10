// 2026-10-10 review C-9: the account archive carried capsule, fact and snapshot rows as they are stored, and a received pack is
// stored with its sharer's account id (`share.authorId`, `transfer.authorId`: the take-down and the corroboration count match on
// it). The id of a local account is its login name, so a recipient who exported their account was handed the login name of
// everyone who had shared with them, and a sender was handed the ids of the accounts a delivery went to. The archive carries
// what belongs to the account; what came from another account is named by the display label an in-app reader is shown.
import assert from "node:assert/strict";
import test from "node:test";

import { exportDocumentRow, withAccountExportSnapshot } from "../src/accountExport.mjs";
import { NEUTRAL_SENDER_NAME } from "../src/capsuleShareLabel.mjs";

const SHARER = "sharer_login_name";

/** A received pack as the import stores it. @param {Record<string, any>} [overrides] */
function receivedCapsule(overrides = {}) {
  return {
    id: "pack-1", kind: "capsule", projectId: null, revision: 2,
    payload: {
      title: "收到的研究胶囊", description: "别人分享的胶囊：整包生效，随时停用。", imported: true, activationMode: "guest",
      transfer: { snapshotId: "snap-1", archiveSha256: "a".repeat(64), manifestSha256: "b".repeat(64), issuerId: "issuer-0123", issuerTrust: "verified",
        signingKeyFingerprint: "c".repeat(64), importedAt: "2026-10-09T00:00:00.000Z", authorId: SHARER, channel: "link" },
      share: { authorId: SHARER, authorName: SHARER, snapshotHash: "b".repeat(64), sharedAt: "2026-10-08T00:00:00.000Z", channel: "link" },
      card: { title: "一份工作方式", author: SHARER, summary: "2 条做法" },
      ...overrides,
    },
  };
}

test("a received pack leaves the archive without its sharer's account id, signed with a name that may be shown", () => {
  const exported = exportDocumentRow(receivedCapsule());
  assert.ok(!JSON.stringify(exported).includes(SHARER), "the login name is nowhere in the row");
  assert.equal(exported.payload.share.authorId, undefined);
  assert.equal(exported.payload.transfer.authorId, undefined);
  assert.equal(exported.payload.share.authorName, NEUTRAL_SENDER_NAME, "a name that was the login name reads as the neutral label, as in the app");
  assert.equal(exported.payload.card.author, NEUTRAL_SENDER_NAME);
  // Everything else of the record is the account's own and stays: where the pack came from, by hash, channel and time.
  assert.equal(exported.payload.transfer.snapshotId, "snap-1");
  assert.equal(exported.payload.transfer.issuerId, "issuer-0123");
  assert.deepEqual(exported.payload.share.snapshotHash, "b".repeat(64));
  assert.equal(exported.revision, 2);
});

test("a sharer's real display name stays, and an address in a name never leaves", () => {
  const named = exportDocumentRow(receivedCapsule({
    share: { authorId: SHARER, authorName: "李主任", snapshotHash: "b".repeat(64), channel: "link" }, card: { title: "t", author: "李主任" },
  }));
  assert.equal(named.payload.share.authorName, "李主任");
  assert.equal(named.payload.card.author, "李主任");
  const address = exportDocumentRow(receivedCapsule({
    share: { authorId: "oidc_0123", authorName: "someone@example.invalid", channel: "file" }, card: { author: "Ada <ada@example.invalid>" },
  }));
  assert.ok(!JSON.stringify(address).includes("example.invalid"));
  assert.equal(address.payload.share.authorName, NEUTRAL_SENDER_NAME);
  // A pack imported before authors were recorded has none to show, and none is made up.
  const unrecorded = exportDocumentRow(receivedCapsule({ share: { authorId: null, authorName: null, channel: "file" }, card: undefined }));
  assert.equal(unrecorded.payload.share.authorName, null);
});

test("the facts a pack brought, and the revisions of both, are cleaned the same way", () => {
  const fact = exportDocumentRow({ id: "f1", kind: "fact", projectId: null, payload: {
    capsuleId: "pack-1", factKind: "method_preference", content: "Report I² before pooling.", origin: "system", status: "approved",
    share: { authorId: SHARER, authorName: SHARER, snapshotHash: "b".repeat(64), channel: "delivery" },
    transfer: { version: 1, sha256: "d".repeat(64), snapshotId: "snap-1", issuerTrust: "verified" },
  } });
  assert.ok(!JSON.stringify(fact).includes(SHARER));
  assert.equal(fact.payload.share.authorName, NEUTRAL_SENDER_NAME);
  assert.equal(fact.payload.content, "Report I² before pooling.");
  const revision = exportDocumentRow({ ...receivedCapsule(), revision: 1 });
  assert.ok(!JSON.stringify(revision).includes(SHARER));
});

test("an account's own capsule and facts are exported as they are", () => {
  const own = { id: "mine", kind: "capsule", projectId: null, payload: { title: "我的记忆胶囊", description: "", imported: false } };
  assert.deepEqual(exportDocumentRow(own), own);
  const fact = { id: "f2", kind: "fact", projectId: null, payload: { capsuleId: "mine", factKind: "preference", content: "先给结论。", origin: "explicit", status: "approved" } };
  assert.deepEqual(exportDocumentRow(fact), fact);
});

test("a snapshot the account sent leaves without the ids of the accounts it was sealed for, only how many", () => {
  const snapshot = { id: "snap-9", kind: "preferences", projectId: null, payload: { recordType: "capsule-snapshot", capsuleId: "mine", issuerId: "issuer-0123",
    status: "active", channel: "delivery", scopes: ["workstyle"], archiveSha256: "a".repeat(64), entryCount: 2, recipients: ["bob_login", "carol_login"], card: { title: "我的工作方式", author: "Me" } } };
  const exported = exportDocumentRow(snapshot);
  assert.ok(!JSON.stringify(exported).includes("bob_login") && !JSON.stringify(exported).includes("carol_login"));
  assert.equal(exported.payload.recipientCount, 2);
  assert.equal(exported.payload.recipients, undefined);
  assert.equal(exported.payload.archiveSha256, "a".repeat(64));
  assert.equal(exported.payload.card.author, "Me");
  // Any other record of the same kind is untouched.
  const other = { id: "pref-1", kind: "preferences", projectId: null, payload: { recordType: "something-else", recipients: ["kept"] } };
  assert.deepEqual(exportDocumentRow(other), other);
  // A snapshot sealed by password only has no recipients to count.
  assert.equal(exportDocumentRow({ ...snapshot, payload: { ...snapshot.payload, recipients: undefined } }).payload.recipientCount, undefined);
});

/** A database double with one received delivery, whose sender's display name is their login name. */
function deliveryDatabase() {
  const database = {
    /** @param {(client: any) => Promise<any>} operation */
    transaction: (operation) => operation({ query: (/** @type {string} */ text, /** @type {any[]} */ values) => database.query(text, values) }),
    /** @param {string} text @param {any[]} [values] */
    async query(text, values = []) {
      if (text.startsWith("SELECT count(*)")) return { rows: [{ rows: "1", bytes: "32" }], rowCount: 1 };
      if (text.includes("FROM evimed_control.users")) {
        return { rowCount: 1, rows: [{ id: values[0], name: "Owner", accountCreatedAt: "2026-09-06 00:00:00+00", sameGeneration: true, snapshotAt: "2026-09-06T00:00:00.000Z" }] };
      }
      if (text.includes("JOIN evimed_control.users u ON u.id=d.owner_id")) {
        return { rowCount: 2, rows: [
          { id: "dlv_1", state: "opened", senderName: SHARER, ownerId: SHARER, packTitle: "一份工作方式", packSha256: "a".repeat(64) },
          { id: "dlv_2", state: "imported", senderName: "李主任", ownerId: "other_login", packTitle: "另一份", packSha256: "b".repeat(64) },
        ] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return database;
}

test("a delivery received is exported with its sender's display name, never their login name", async () => {
  const state = await withAccountExportSnapshot(deliveryDatabase(), { id: "owner", accountCreatedAt: "2026-09-06 00:00:00+00" }, {}, async (snapshot) => JSON.parse(snapshot.data.toString()));
  assert.deepEqual(state.shareDeliveriesReceived.map((row) => row.senderName), [NEUTRAL_SENDER_NAME, "李主任"]);
  assert.ok(state.shareDeliveriesReceived.every((row) => !("ownerId" in row)), "the sender's account id is not a column of the archive");
  assert.ok(!JSON.stringify(state).includes(SHARER) && !JSON.stringify(state).includes("other_login"));
  assert.equal(state.shareDeliveriesReceived[0].packTitle, "一份工作方式");
});
