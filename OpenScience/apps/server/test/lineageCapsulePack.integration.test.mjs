/**
 * The P0 path of the TCM CDSS plan, end to end on a real database: a lineage
 * card is packed, the institution imports the pack through the platform's own
 * importer, and a doctor's recall that names it is handed the card's stages as
 * methods. The importer is not a double — a pack it refused would be a pack no
 * deployment could open.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { after, before, test } from "node:test";

import { newPackIdentity, packLineageCard } from "../../../scripts/ops/pack-lineage-capsule.mjs";
import { AgentApiKeyStore } from "../src/agentApiKeys.mjs";
import { recallForAgent } from "../src/agentMemoryRecall.mjs";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { classicalFormulaCard } from "./helpers/lineageCards.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const hospital = `lineage_hospital_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {string} */ let root;
/** @type {CapsuleService} */ let capsules;
/** @type {CapsuleTransferService} */ let transfers;
/** @type {string} */ let doctorId;

// The model half of the scan is the deployment's; here every entry passes, so
// what is tested is the layout, the crypto and the path to recall.
const scanner = {
  async scan(_owner, entries) {
    return { kept: entries.map((entry) => entry.id), dropped: [], unchecked: [], model: "ok", checkedAt: new Date().toISOString() };
  },
};

before(async () => {
  if (!url) return;
  root = await fs.realpath(await fs.mkdtemp("/tmp/evimed-lineage-pack-"));
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Hospital','development')", [hospital]);
  const documents = new ProductDocuments(database);
  capsules = new CapsuleService(documents, { scanner });
  transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(root), dataDir: root, scanner });
  doctorId = (await new AgentApiKeyStore(database).subjectAccount(hospital, "doc-7")).userId;
});
after(async () => {
  if (database) {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[hospital, doctorId].filter(Boolean)]);
    await database.close();
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("a packed card imports through the platform's own importer, and a doctor naming it recalls its stages", options, async () => {
  const password = "test-only-lineage-passphrase";
  const packed = await packLineageCard(classicalFormulaCard(), { identity: newPackIdentity(), password });

  const preview = await transfers.preview(hospital, { archive: packed.archive, password }, { projectId: "default" });
  assert.equal(preview.canImport, true);
  assert.equal(preview.issuerTrust, "unverified", "a governance key this deployment has not been told about says so");
  assert.equal(preview.entries.length, packed.entries);
  assert.deepEqual([preview.card?.title, preview.card?.author], ["经方思路", "中医 CDSS 内容治理组"], "the pack says what it is and who wrote it");
  const imported = await transfers.import(hospital, {
    archive: packed.archive, password, confirmed: true, expectedDigest: preview.archiveSha256,
  });
  assert.equal(imported.payload.title, "经方思路", "named by its card, not by whoever imported it");

  const result = await recallForAgent({ capsules, memorySubstrate: null, learning: null },
    { user: { id: doctorId }, institution: { id: hospital } }, { query: "桂枝汤", capsuleIds: [imported.id] });
  assert.deepEqual(result.capsules, [{ id: imported.id, title: "经方思路", owner: "institution" }]);
  // The three stages, and the standards a pack's work style carries beside
  // them (the mount's own rule: preferences travel with methods).
  const headings = result.methods.map((method) => method.content.split("\n")[0]);
  for (const stage of ["# 经方思路 · 追问（M02）", "# 经方思路 · 辨病辨证（M03）", "# 经方思路 · 候选方药与加减（M04）"]) {
    assert.ok(headings.includes(stage), stage);
  }
  assert.equal(result.methods.length, 5);
  assert.ok(result.methods.every((method) => method.source === "capsule" && method.capsuleId === imported.id));
  assert.ok(result.items.some((item) => /桂枝汤/.test(item.content)), "the card's text answers the query");
});
