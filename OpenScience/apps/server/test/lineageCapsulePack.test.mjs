/**
 * A lineage card (流派卡) packed as a memory capsule: what it holds, that it is
 * signed and encrypted the way an export is, and what it refuses to carry.
 * `lineageCapsulePack.integration.test.mjs` imports one and recalls from it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { newPackIdentity, packLineageCard } from "../../../scripts/ops/pack-lineage-capsule.mjs";
import { openCapsule, verifyCapsule } from "../src/capsuleContainer.mjs";
import { classicalFormulaCard } from "./helpers/lineageCards.mjs";

const password = "test-only-lineage-passphrase";
const identity = newPackIdentity();

test("one method per stage the card speaks to, its standards and the card itself, in the layout an import accepts", async () => {
  const packed = await packLineageCard(classicalFormulaCard(), { identity, password });
  assert.deepEqual(packed.stages, ["M02", "M03", "M04"]);
  const envelope = JSON.parse(packed.archive);
  assert.equal(envelope.format, "evimedcap");
  assert.deepEqual(envelope.manifest.scope, ["workstyle", "+profile"]);
  assert.match(envelope.manifest.attribution, /中医 CDSS 内容治理组：经方思路（卡片 1\.0\.0）/);

  const container = { manifest: envelope.manifest, payload: Object.fromEntries(Object.entries(envelope.payload).map(([file, value]) => [file, Buffer.from(value, "base64")])) };
  assert.equal(verifyCapsule(container, { signingPublicKey: identity.signing.publicKey }).ok, true, "signed by the governance identity");
  const opened = await openCapsule(container, { issuer: { signingPublicKey: identity.signing.publicKey }, password, passwordWrap: Buffer.from(envelope.passwordWrap, "base64") });
  assert.ok(!("issues" in opened), "and it opens with the password");
  const provenance = JSON.parse(opened.entries["provenance.json"]);
  const methods = provenance.entries.filter((entry) => entry.factKind === "method_preference");
  assert.deepEqual(methods.map((entry) => entry.content.split("\n")[0]), [
    "# 经方思路 · 追问（M02）", "# 经方思路 · 辨病辨证（M03）", "# 经方思路 · 候选方药与加减（M04）",
  ]);
  for (const method of methods) assert.equal(method.path, `methods/${method.id}/SKILL.md`, "each method under its own id, as the importer requires");
  assert.match(methods[0].content, /追问焦点：寒热、汗出、口渴/);
  assert.match(methods[1].content, /辨证重点：方证对应、寒热虚实、表里传变/);
  assert.match(methods[2].content, /代表方示例：桂枝汤、小柴胡汤、半夏泻心汤、苓桂术甘汤/);
  assert.ok(methods.every((method) => method.content.includes("药事审方和执业医师复核始终优先")), "every stage carries the safety deference");
  assert.equal(provenance.entries.filter((entry) => entry.path === "standards.jsonl").length, 2);
  const card = provenance.entries.find((entry) => entry.factKind === "expertise");
  assert.match(card.content, /治理：结构版本 1\.0\.0；卡片版本 1\.0\.0；状态 生效；作者 中医 CDSS 内容治理组/);
  assert.ok(provenance.entries.every((entry) => entry.origin === "explicit"));
});

test("the same card packs to the same ids every time, and a card with no question strategy has no M02", async () => {
  const one = await packLineageCard(classicalFormulaCard(), { identity, password });
  const two = await packLineageCard(classicalFormulaCard(), { identity, password });
  assert.equal(one.snapshotId, two.snapshotId);
  assert.notEqual(one.archiveSha256, two.archiveSha256, "fresh keys each time; the same content");
  const digest = (packed) => createHash("sha256").update(JSON.stringify(JSON.parse(packed.archive).manifest.entries.map((entry) => [entry.path, entry.sha256]))).digest("hex");
  assert.equal(digest(one), digest(two));
  const bare = await packLineageCard(classicalFormulaCard().card, { identity, password });
  assert.deepEqual(bare.stages, ["M03", "M04"]);
  const next = await packLineageCard(classicalFormulaCard(), { identity, password, packVersion: 2 });
  assert.notEqual(next.snapshotId, one.snapshotId, "a new version is a new snapshot");
});

test("a dose, an identifier, a retired card and an unreviewed one are refused before anything is packed", async () => {
  await assert.rejects(
    () => packLineageCard(classicalFormulaCard({ herbTendency: "附子常用 30g 以上。" }), { identity, password }),
    (error) => error.code === "lineage_card_dose" && /card\.herbTendency/.test(error.message),
  );
  await assert.rejects(
    () => packLineageCard(classicalFormulaCard({ cautions: ["桂枝 9 克为宜"] }), { identity, password }),
    (error) => error.code === "lineage_card_dose" && /card\.cautions\[0\]/.test(error.message),
  );
  await assert.rejects(
    () => packLineageCard(classicalFormulaCard({ applicability: "按病历号追溯原案后适用。" }), { identity, password }),
    (error) => error.code === "lineage_card_sensitive" && /card\.applicability/.test(error.message),
  );
  const retired = classicalFormulaCard();
  retired.card.governance.status = "retired";
  await assert.rejects(() => packLineageCard(retired, { identity, password }), (error) => error.code === "lineage_card_retired");
  const draft = classicalFormulaCard();
  draft.card.governance.status = "in_review";
  await assert.rejects(() => packLineageCard(draft, { identity, password }), (error) => error.code === "lineage_card_unreviewed");
  assert.match((await packLineageCard(draft, { identity, password, allowUnreviewed: true })).archive, /evimedcap/, "a draft for review, when said so");
  const mismatched = classicalFormulaCard();
  mismatched.questionStrategy.lineageCode = "warm-disease";
  await assert.rejects(() => packLineageCard(mismatched, { identity, password }), (error) => error.code === "lineage_card_invalid");
  await assert.rejects(() => packLineageCard(classicalFormulaCard(), { identity, password: "" }), (error) => error.code === "lineage_card_password");
});
