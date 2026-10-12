// 2026-10-10 review M-9 (a) and (d): what a shared pack says about its sender, and whether a pack that was taken down
// can still reach a conversation.
//   (d) The card's author is the sender's display name "never its id" (capsuleTransferService.mjs), but a local
//       account's display name defaults to its login name and an OIDC account's fell back to its e-mail address, so a
//       pack could be signed — and shown to every recipient as 「来自 … 的分享」 — with either.
//   (a) `trialContext` read a received pack whatever had happened to it since the trial began.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";

import { CapsuleService } from "../src/capsuleService.mjs";
import { NEUTRAL_SENDER_NAME, SIGNATURE_MAX_CHARS, senderDisplayName, shareSignature, sharedFrom } from "../src/capsuleShareLabel.mjs";
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
  // A published evidence card is signed by the same rule with its own neutral word.
  assert.equal(senderDisplayName("someone@example.invalid", "oidc_0123", "研究者"), "研究者");
  assert.equal(senderDisplayName("alice", "alice", "研究者"), "研究者");
  assert.equal(senderDisplayName("李主任", "alice", "研究者"), "李主任");
});

test("a share is signed with what its sender typed for it, else their display name, by the one rule and with one bound (2026-10-10 review C4c)", () => {
  assert.equal(SIGNATURE_MAX_CHARS, 60);
  assert.equal(shareSignature("心内科  王医生", "李主任", "share_sender_1"), "心内科 王医生", "typed, whitespace flattened");
  assert.equal(shareSignature("名".repeat(60), "李主任", "share_sender_1"), "名".repeat(60), "the bound itself is allowed");
  // None typed: today's name, by today's rule.
  for (const none of [undefined, null, "", "   ", 42]) assert.equal(shareSignature(none, "李主任", "share_sender_1"), "李主任", String(none));
  assert.equal(shareSignature(undefined, "alice", "alice"), NEUTRAL_SENDER_NAME);
  assert.equal(shareSignature(undefined, "ada@example.invalid", "oidc_0123"), NEUTRAL_SENDER_NAME);
  // Typed, but a name that cannot be shown: the neutral label, not a refusal and not the account's name.
  for (const typed of ["wang@example.invalid", "王医生 <wang@example.invalid>", "share_sender_1", "SHARE_SENDER_1"]) assert.equal(shareSignature(typed, "李主任", "share_sender_1"), NEUTRAL_SENDER_NAME, typed);
  // Past the bound is the one thing refused, by returning null for the caller to name.
  assert.equal(shareSignature("名".repeat(61), "李主任", "share_sender_1"), null);
  // What the recipient's recall then says under each entry.
  assert.equal(sharedFrom({ payload: { imported: true, card: { author: shareSignature("王医生", "李主任", "share_sender_1") } } })?.label, "来自 王医生 的分享");
});

test("the share dialog's 署名 field is bounded by the number the control plane enforces", async () => {
  const dialogSide = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/lib/capsuleText.ts"), "utf8");
  assert.equal(Number(/export const CAPSULE_SIGNATURE_MAX_CHARS = (\d+);/.exec(dialogSide)?.[1]), SIGNATURE_MAX_CHARS);
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

test("a shared method opens with its name and purpose in the researcher's words, so a preview never shows the text written for the model", async () => {
  const methodRow = { id: "method:learned:beta", revision: 3, payload: {
    recordType: "learned-method", status: "approved", provenance: {},
    display: { title: "证据分级先看设计再看偏倚", summary: "先按研究设计定起点，再逐项降级。" },
    frontmatter: { name: "grade-design-first", description: "Grades evidence by design first.", whenToUse: "When grading." }, body: "## Steps\n1. Read the design.",
  } };
  const client = { async query(/** @type {string} */ sql) {
    if (/kind='method'/.test(sql)) return { rows: [methodRow], rowCount: 1 };
    if (/kind='capsule' AND id=/.test(sql)) return { rows: [{ revision: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const database = { ...client, async transaction(/** @type {(client: any) => Promise<any>} */ work) { return work(client); } };
  const service = new CapsuleTransferService({ documents: /** @type {any} */ ({ database }),
    capsules: /** @type {any} */ ({ async get() { return { payload: { imported: false } }; } }), identities: /** @type {any} */ (null), dataDir: "/nonexistent" });
  const preview = await service.exportPreview("alice", "capsule-1", {});
  const method = preview.entries.find((/** @type {any} */ entry) => entry.factKind === "method_preference");
  assert.ok(method, "the learned method is in the pack");
  assert.match(method.content, /^# 证据分级先看设计再看偏倚\n\n先按研究设计定起点，再逐项降级。\n\n/);
  assert.match(method.content, /Grades evidence by design first\.[\s\S]*## Steps/, "the model still receives the method it runs");
});
