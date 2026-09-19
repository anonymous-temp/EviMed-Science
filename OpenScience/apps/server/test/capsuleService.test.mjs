// The capsule service against an in-memory document store — the rules that do
// not need PostgreSQL to be decided. The integration suite holds the real store.
import assert from "node:assert/strict";
import test from "node:test";

import { CapsuleService } from "../src/capsuleService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const USER = "user_1";

test("a capsule is used as one's own or as a reference; 合并参考 is stored and read as a reference", async () => {
  // Nothing ever told `blend` apart from `guest` — every reader asks only
  // "own or not" — so the page offers two (2026-09-19 plan §3.3 #4).
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const mine = await service.create(USER, { title: "我的记忆胶囊" });
  const theirs = await service.create(USER, { title: "李主任的工作方式" });
  await service.activate(USER, mine.id, { mode: "own" });
  await service.activate(USER, theirs.id, { mode: "blend" });
  const stored = [...documents.rows.values()].find((row) => row.kind === "preferences");
  assert.deepEqual(stored.payload.items.map((item) => item.mode), ["own", "guest"], "a request for blend is stored as what it meant");

  // An activation written before the change still says `blend`; no migration.
  stored.payload.items = [{ capsuleId: mine.id, mode: "own" }, { capsuleId: theirs.id, mode: "blend" }];
  const { items } = await service.active(USER);
  assert.deepEqual(items.map((item) => item.mode), ["own", "guest"]);
  // A mode this build does not know contributes as a reference, never as an identity.
  stored.payload.items = [{ capsuleId: theirs.id, mode: "merged-v3" }];
  assert.deepEqual((await service.active(USER)).items.map((item) => item.mode), ["guest"]);

  await assert.rejects(service.activate(USER, mine.id, { mode: "merged-v3" }), { code: "capsule_payload_invalid" });
});

test("a reference capsule's facts are recalled as a reference, and never render as the researcher's own profile", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const theirs = await service.create(USER, { title: "李主任的工作方式" });
  await service.addEntry(USER, theirs.id, { factKind: "profile", layer: "profile", content: "心内科主任，二十年临床经验" });
  await service.addEntry(USER, theirs.id, { factKind: "method_preference", layer: "methods", content: "超说明书用药先查说明书修订史" });
  // Stored the old way.
  await documents.put(USER, "preferences", "active-capsules:account", { items: [{ capsuleId: theirs.id, mode: "blend" }] }, { expectedRevision: 0 });

  const recalled = await service.recall(USER, { query: "说明书" });
  assert.deepEqual(recalled.items.map((item) => item.mode), ["guest"]);
  assert.deepEqual(await service.profileFacts(USER, null, ["profile"]), [], "someone else's identity is never presented as yours");
});
