// 2026-10-10 review M-9 (a) and (d): what a shared pack says about its sender, and whether a pack that was taken down
// can still reach a conversation.
//   (d) The card's author is the sender's display name "never its id" (capsuleTransferService.mjs), but a local
//       account's display name defaults to its login name and an OIDC account's fell back to its e-mail address, so a
//       pack could be signed — and shown to every recipient as 「来自 … 的分享」 — with either.
//   (a) `trialContext` read a received pack whatever had happened to it since the trial began.
import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

import { CapsuleService } from "../src/capsuleService.mjs";
import { NEUTRAL_SENDER_NAME, senderDisplayName, sharedFrom } from "../src/capsuleShareLabel.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

test("a sender is named by their display name, and by a neutral label when that is their login name or an address", () => {
  assert.equal(NEUTRAL_SENDER_NAME, "一位研究者");
  assert.equal(senderDisplayName("李主任", "share_sender_1"), "李主任");
  assert.equal(senderDisplayName("  Ada   Researcher ", "oidc_0123"), "Ada Researcher", "whitespace is flattened, the name is theirs");
  // A local account's display name defaults to its login name.
  assert.equal(senderDisplayName("alice", "alice"), NEUTRAL_SENDER_NAME);
  assert.equal(senderDisplayName("Alice", "alice"), NEUTRAL_SENDER_NAME, "a login name differing in case is still the login name");
  // An address, bare or inside a name, is not a name.
  assert.equal(senderDisplayName("someone@example.invalid", "oidc_0123"), NEUTRAL_SENDER_NAME);
  assert.equal(senderDisplayName("Ada <ada@example.invalid>", "oidc_0123"), NEUTRAL_SENDER_NAME);
  for (const nothing of ["", "   ", null, undefined, 42]) assert.equal(senderDisplayName(nothing, "alice"), NEUTRAL_SENDER_NAME);
  // The recipient reads it as the label under every entry of the pack.
  const received = { payload: { imported: true, card: { author: senderDisplayName("alice", "alice") } } };
  assert.equal(sharedFrom(received)?.label, "来自 一位研究者 的分享");
});

test("a method pack is signed with the sender's display name, never their login name or address", async () => {
  const methodRow = { id: "method:learned:alpha", payload: {
    recordType: "learned-method", status: "approved", provenance: {},
    frontmatter: { name: "alpha", description: "Does alpha.", whenToUse: "When needed." }, body: "## Purpose\nDo it.",
  } };
  /** @param {string} name */
  const packBy = async (name) => {
    const database = { async query(/** @type {string} */ sql) {
      if (/FROM evimed_control\.users/.test(sql)) return { rows: [{ name }], rowCount: 1 };
      if (/kind='method'/.test(sql)) return { rows: [methodRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } };
    const service = new CapsuleTransferService({ documents: /** @type {any} */ ({ database }),
      capsules: /** @type {any} */ ({ async get() { return { payload: { imported: false } }; } }), identities: /** @type {any} */ (null), dataDir: "/nonexistent" });
    const pack = await service.methodPack("alice", "capsule-1", { exportedAt: new Date("2026-10-10T00:00:00Z") });
    const files = unzipSync(pack.zip);
    return strFromU8(files["alpha/PROVENANCE.md"]);
  };
  assert.match(await packBy("李主任"), /- Author \(作者\): 李主任/);
  assert.match(await packBy("alice"), /- Author \(作者\): 一位研究者/, "the login name is not an author");
  assert.match(await packBy("ada@example.invalid"), /- Author \(作者\): 一位研究者/);
});

test("a trial conversation is handed no pack that has been taken down since the trial began", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const pack = await documents.put("u1", "capsule", "pack-t", { title: "李主任的工作方式", imported: true, activationMode: "guest" }, { expectedRevision: 0 });
  await documents.put("u1", "fact", "ft-1", { capsuleId: pack.id, factKind: "method_preference", layer: "methods", content: "合并前先报告 I²",
    origin: "system", status: "approved", contextOnly: true }, { expectedRevision: 0 });
  assert.match(await service.trialContext("u1", pack.id), /合并前先报告 I²/, "in force: the trial reads it");

  const current = await documents.get("u1", "capsule", pack.id);
  await documents.put("u1", "capsule", pack.id, { ...current.payload, takenDown: { by: "author", at: "2026-10-10T00:00:00.000Z", reason: "withdrawn" } },
    { expectedRevision: current.revision });
  assert.equal(await service.trialContext("u1", pack.id), "", "taken down: out of force everywhere, trials included (plan §7)");
});
