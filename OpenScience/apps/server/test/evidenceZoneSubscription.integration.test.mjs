// A project subscribed to an evidence zone recalls its published cards as index-only reference context, and a memory that names a card
// or a frontier item hears when the zone or the feed takes it back (evidence-flywheel F18 and F19, 2026-10-05), against PostgreSQL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneSubscriptions, createEvidenceLinkStates, forgetEvidenceCardColumns } from "../src/evidenceZoneSubscription.mjs";
import { KnowledgeChangeService } from "../src/knowledgeChange.mjs";
import { migrateEvidenceZones } from "../src/evidenceZonePersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const tag = randomUUID().slice(0, 8);
const hex32 = () => randomUUID().replaceAll("-", "");
const owner = `zs_owner_${tag}`;
const reader = `zs_reader_${tag}`;
const stranger = `zs_stranger_${tag}`;
const QUOTE = "达比加群酯在非瓣膜性房颤中降低卒中风险";
/** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let subscriptions; /** @type {any} */ let memory;
const zones = []; let published; let draft; let card;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  await migrateEvidenceZones(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Zone Owner','development'),($2,'Zone Reader','development'),($3,'Stranger','development')", [owner, reader, stranger]);
  for (const project of ["p1", "p2"]) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Subscribed',1048576)", [reader, project]);
  documents = new ProductDocuments(database);
  subscriptions = new EvidenceZoneSubscriptions({ database, documents, enabled: true, maxPerProject: 2, maxItems: 3 });
  memory = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
  published = `ez_${hex32()}`; draft = `ez_${hex32()}`; card = `ec_${hex32()}`;
  await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES($1,$2,'房颤抗凝','published'),($3,$2,'未发布的专区','draft')", [published, owner, draft]);
  await database.query(`INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,summary,sources,state,content,claims,producer)
    VALUES($1,$2,$3,'达比加群酯与卒中','academic','房颤抗凝的证据',$4::jsonb,'published',$5::jsonb,$6::jsonb,$7::jsonb)`,
  [card, published, owner, JSON.stringify([{ title: "RE-LY 试验", url: "https://doi.org/10.1056/NEJMoa0905561", excerpt: `${QUOTE}。`, coverage: "excerpt" }]),
    JSON.stringify({ question: "房颤抗凝用达比加群酯吗？", answer: "可降低卒中风险。" }),
    JSON.stringify([{ claimId: "CLM-001", claimType: "direct", claim: "达比加群酯降低卒中风险", sourceIndexes: [1], supportQuote: QUOTE },
      { claimId: "CLM-002", claimType: "direct", claim: "出血风险更低", sourceIndexes: [1], supportQuote: "这句话不在原文里" }]),
    JSON.stringify({ kind: "platform", name: "EviMed 证据中心", relation: "none" })]);
  zones.push(published, draft);
});
after(async () => {
  if (!database) return;
  if (zones.length) await database.query("DELETE FROM evimed_frontier.evidence_zones WHERE id=ANY($1::text[])", [zones]);
  await database.query("ALTER TABLE evimed_frontier.evidence_cards DROP COLUMN IF EXISTS withdrawn");
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, reader, stranger]]);
  await database.close();
});

test("a subscribed project recalls the zone's published cards as index-only context, with ✓/⚠ and the primary sources; another project does not", options, async () => {
  const made = await subscriptions.subscribe(reader, "p1", published);
  assert.equal(made.status, "active");
  assert.equal(made.cards, 1);
  assert.equal((await subscriptions.subscribe(reader, "p1", published)).zoneId, published, "asking twice is the first subscription");
  const found = await subscriptions.recall(reader, "p1", "房颤抗凝治疗达比加群酯的证据");
  assert.equal(found.length, 1);
  const [item] = found;
  assert.equal(item.label, "来自证据专区《房颤抗凝》");
  assert.equal(item.source, "evidence_zone");
  assert.equal(item.contextOnly, true);
  assert.deepEqual(item.claims.map((claim) => claim.mark), ["✓", "⚠"], "the reader's own marks");
  assert.deepEqual(item.primarySources, [{ title: "RE-LY 试验", url: "https://doi.org/10.1056/NEJMoa0905561" }]);
  assert.match(item.content, /索引，不是来源/);
  assert.match(item.content, /不要把这张卡片当作来源/, "it says to cite the primary sources, never the card");
  assert.ok(item.identifiers.includes("doi:10.1056/nejmoa0905561"));
  assert.deepEqual(await subscriptions.recall(reader, "p2", "房颤抗凝治疗达比加群酯的证据"), [], "only the project that subscribed");
  assert.deepEqual(await subscriptions.recall(stranger, "p1", "房颤抗凝治疗达比加群酯的证据"), [], "and only for its own account");
  assert.deepEqual(await subscriptions.recall(reader, "p1", "完全无关的话题啊"), [], "no card matches an unrelated question");

  await subscriptions.unsubscribe(reader, "p1", published);
  assert.deepEqual(await subscriptions.recall(reader, "p1", "房颤抗凝治疗达比加群酯的证据"), [], "unsubscribing removes it at once");
  assert.equal((await subscriptions.list(reader, "p1")).length, 0);
  assert.equal((await subscriptions.subscribe(reader, "p1", published)).status, "active", "and it can be taken again");
});

test("an unpublished zone cannot be subscribed to, and a zone that is unpublished or deleted later yields nothing and says so", options, async () => {
  await assert.rejects(subscriptions.subscribe(reader, "p1", draft), { code: "evidence_zone_subscription_not_found" }, "someone else's draft");
  await assert.rejects(subscriptions.subscribe(owner, "p1", draft), { code: "evidence_zone_subscription_not_found" }, "even its owner's: a subscription is to what others can read");
  await assert.rejects(subscriptions.subscribe(reader, "p1", `ez_${hex32()}`), { code: "evidence_zone_subscription_not_found" });
  await assert.rejects(subscriptions.subscribe(reader, "p1", "not-a-zone"), { code: "evidence_zone_subscription_not_found" });
  const own = `ez_${hex32()}`; zones.push(own);
  await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES($1,$2,'会被撤下的专区','published')", [own, owner]);
  await database.query(`INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,summary,state,content)
    VALUES($1,$2,$3,'撤下前的卡','knowledge','撤下前能被找到的内容','published','{"question":"撤下前能被找到的内容"}')`, [`ec_${hex32()}`, own, owner]);
  await subscriptions.subscribe(reader, "p2", own);
  assert.equal((await subscriptions.recall(reader, "p2", "撤下前能被找到的内容")).length, 1);
  await database.query("UPDATE evimed_frontier.evidence_zones SET state='draft' WHERE id=$1", [own]);
  assert.deepEqual(await subscriptions.recall(reader, "p2", "撤下前能被找到的内容"), []);
  const unpublished = (await subscriptions.list(reader, "p2"))[0];
  assert.deepEqual([unpublished.status, unpublished.reason, unpublished.cards], ["unavailable", "unpublished", 0]);
  assert.match(unpublished.message, /取消发布/);
  await database.query("DELETE FROM evimed_frontier.evidence_zones WHERE id=$1", [own]);
  const gone = (await subscriptions.status(reader, "p2", own)).subscription;
  assert.deepEqual([gone.status, gone.reason], ["unavailable", "deleted"]);
  assert.match(gone.message, /已经删除/);
  // A project follows at most its ceiling.
  await subscriptions.subscribe(reader, "p2", published);
  const extra = `ez_${hex32()}`; zones.push(extra);
  await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES($1,$2,'第三个','published')", [extra, owner]);
  await assert.rejects(subscriptions.subscribe(reader, "p2", extra), { code: "evidence_zone_subscription_limit" });
});

test("with the switch off nothing is read and subscribing is the module's own not-enabled answer", options, async () => {
  const off = new EvidenceZoneSubscriptions({ database, documents, enabled: false });
  await assert.rejects(off.subscribe(reader, "p1", published), { code: "evidence_zone_subscription_not_enabled", status: 404 });
  await assert.rejects(off.list(reader, "p1"), { code: "evidence_zone_subscription_not_enabled" });
  assert.deepEqual(await off.recall(reader, "p1", "房颤抗凝治疗达比加群酯的证据"), []);
});

test("a card the zone withdraws leaves the recall, and labels the memory that names it; a frontier item taken back does the same", options, async () => {
  await subscriptions.subscribe(reader, "p1", published).catch(() => null);
  const fact = (key, links) => memory.upsertRecord(reader, { scope: "user", scopeId: null, kind: "preference", key, value: `${key} 的内容`, summary: key,
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false }, null, { sourceLinks: links });
  const item = "w4k8s2n6v1qa";
  const itemStates = new Map();
  const knowledge = new KnowledgeChangeService({ memory, evidence: { cardStates: createEvidenceLinkStates(database).cardStates, itemStates: async (ids) => new Map(ids.filter((id) => itemStates.has(id)).map((id) => [id, itemStates.get(id)])) } });
  const resting = await fact("preference.rests_on_card", [{ type: "evidence_card", id: card }]);
  const onItem = await fact("preference.rests_on_item", [{ type: "frontier_item", id: item }]);
  const independent = await fact("preference.independent", [{ type: "frontier_item", id: "n7m2x9c4b1ze" }]);
  const states = async (record) => (await memory.sourceLinks(reader, record.id)).map((link) => [link.type, link.state, link.stateReason]);
  assert.deepEqual(await knowledge.sweepEvidenceLinks({ ownerId: reader }), { checked: 3, labelled: 0 }, "a current card and an item with no row say nothing");
  assert.deepEqual(await states(resting), [["evidence_card", "current", ""]]);

  // The column belongs to the zone's upkeep and may not exist on this database: it was read as `current` until now.
  await database.query("ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS withdrawn jsonb");
  forgetEvidenceCardColumns(database);
  await database.query("UPDATE evimed_frontier.evidence_cards SET withdrawn='{\"reason\":\"撤回\"}'::jsonb WHERE id=$1", [card]);
  itemStates.set(item, { state: "published", flags: ["retracted"] });
  assert.deepEqual(await subscriptions.recall(reader, "p1", "房颤抗凝治疗达比加群酯的证据"), [], "a withdrawn card is no longer recalled");
  const swept = await knowledge.sweepEvidenceLinks({ ownerId: reader });
  assert.equal(swept.labelled, 2);
  assert.deepEqual(await states(resting), [["evidence_card", "retracted", "card_withdrawn"]], "the label a retracted DOI gives");
  assert.deepEqual(await states(onItem), [["frontier_item", "retracted", "item_retracted"]]);
  assert.deepEqual(await states(independent), [["frontier_item", "current", ""]], "found by the recorded link and by nothing else");
  assert.equal((await knowledge.sweepEvidenceLinks({ ownerId: reader })).labelled, 0, "idempotent");
  // A superseded card is a change, never a retraction; a card of another account's memory is not touched by this account's sweep.
  await database.query("UPDATE evimed_frontier.evidence_cards SET withdrawn=NULL WHERE id=$1", [card]);
  assert.equal((await knowledge.sweepEvidenceLinks({ ownerId: stranger })).labelled, 0);
});
