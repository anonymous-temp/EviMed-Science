// 「循证传播」's evidence chain, the citing side (flywheel F21): the lower layers cite card claims, and the platform reads each
// reference against the card revision it names — the project's own cards and a published official card, never another account's —
// labels an article whose cited claim a card's change log says moved, and renders the card layer from the card. On the real zone
// service, change log and tables.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { geoClaimReferenceMarker } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createEvidenceChangeLog } from "../src/evidenceChangeLog.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { GeoCards } from "../src/geoCards.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };

const LABEL = "【用法用量】成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。【禁忌】对本品活性成分或辅料过敏者禁用。";
const FILES = new Map([[".evimed-sources/label.txt", LABEL]]);
let readable = FILES;
const readSource = async (/** @type {{ artifactPath: string | null }} */ claim) => (claim.artifactPath ? readable.get(claim.artifactPath) ?? null : null);
const dose = { claimKey: "dose", statement: "成人推荐起始剂量为每周一次 2.5 mg。", quote: "成人推荐起始剂量为每周一次 2.5 mg", sourceRef: "信尔美说明书 2025 版",
  sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" };
const contra = { claimKey: "contra", statement: "对本品活性成分或辅料过敏者禁用。", quote: "对本品活性成分或辅料过敏者禁用", sourceRef: "信尔美说明书 2025 版",
  sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" };

/** @type {any} */ let isolated, db, store, zones, cards, changeLog;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geochain");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice Li','development'),('bob','Bob','development'),('publisher','Platform publisher','development')");
  store = new GeoStore({ database: db });
  await store.ready();
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
  changeLog = createEvidenceChangeLog({ database: db });
  cards = new GeoCards({ store, zones, database: db, now: () => new Date("2026-10-06T08:00:00Z"),
    people: async () => ({ authors: [{ name: "王编辑" }], reviewers: [{ name: "李医生" }] }) });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  readable = FILES;
  await db.query("TRUNCATE evimed_geo.projects CASCADE");
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
});

/** A project of `alice` whose label claims are in cards. @param {any[]} claims */
async function carded(claims = [dose, contra]) {
  const created = await store.createProject({ userId: "alice", projectId: `p-${Math.random().toString(36).slice(2, 8)}`, engines: ["deepseek"], coverageDays: 90,
    product: { brandName: "信尔美", genericName: "玛仕度肽注射液", holder: "某某制药有限公司" } });
  await store.updateProject("alice", created.id, { producer: { kind: "enterprise", relation: "own_product" } });
  await store.upsertClaims("alice", created.id, claims);
  const first = await cards.refresh(/** @type {any} */ (await store.getProject("alice", created.id)), { readSource });
  return { project: /** @type {any} */ (await store.getProject("alice", created.id)), first, card: first.cards[0] };
}
const ref = (/** @type {string} */ cardId, /** @type {string} */ claimId, /** @type {number} */ revision) => geoClaimReferenceMarker({ cardId, claimId, revision });
/** Register a popular article by path and return its row. @param {any} project @param {string} name */
async function article(project, name = "a") {
  const [id] = await store.registerArticles("alice", project.id, [{ path: `deliverables/geo-content/articles/${name}.md`, layer: "popular", title: name, groupId: null,
    claimIds: [], gate: "passed", safety: "clear", contentSha256: createHash("sha256").update(name).digest("hex"), deliverableId: "geo-content" }]);
  return /** @type {any} */ (store.getArticle(project.id, id));
}

test("an article that cites claims of the project's cards resolves, and the finding is kept on the article", options, async () => {
  const { project, card } = await carded();
  const text = `成人起始剂量为每周一次 2.5 mg。${ref(card.cardId, "dose", 1)}\n对活性成分过敏的人不能用。${ref(card.cardId, "contra", 1)}\n`;
  const row = await article(project);
  const checked = await cards.checkArticle(project, row, text);
  assert.equal(checked.status, "resolved");
  assert.equal(checked.graph.ok, true);
  assert.deepEqual(checked.graph.issues, []);
  assert.deepEqual(checked.references.map((reference) => [reference.claimId, reference.revision]), [["dose", 1], ["contra", 1]]);
  const stored = await store.getArticle(project.id, row.id);
  assert.equal(stored.refStatus, "resolved");
  assert.equal(stored.claimRefs.length, 2);
  assert.equal(stored.refCheckedSha, createHash("sha256").update(text).digest("hex"));
  // An article that cites nothing says none, not resolved.
  assert.equal((await cards.checkText(project, { text: "一句没有数字的话。", layer: "popular" })).status, "none");
});

test("a claim that is not in the cited revision, a card that is not the project's, and another account's card are each unresolved", options, async () => {
  const { project, card } = await carded();
  // Bob's own published card in his own zone: not citable from alice's project.
  const bobZone = (await zones.save({ id: "bob" }, { title: "Bob's", description: "", background: "" })).zone;
  await zones.save({ id: "bob" }, { expectedRevision: bobZone.revision, state: "published" }, bobZone.id);
  const bobCard = (await zones.save({ id: "bob" }, { title: "Bob 的卡", subtype: "knowledge", summary: "s", body: "b", sources: [{ title: "t", url: "https://example.org/a" }],
    producer: { kind: "user", name: "Bob", relation: "none" }, state: "published", requestId: "bob-card-0001" }, bobZone.id, null, true)).evidence;
  const text = [
    `起始剂量。${ref(card.cardId, "nope", 1)}`,
    `过敏者禁用。${ref(card.cardId, "contra", 9)}`,
    `别人的结论。${ref(bobCard.id, "x", 1)}`,
  ].join("\n");
  const result = await cards.checkText(project, { text, layer: "popular" });
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.graph.references.map((entry) => entry.status), ["claim_not_in_revision", "revision_not_found", "card_not_found"]);
});

test("a published official card can be cited by reference; an unpublished one cannot", options, async () => {
  const { project } = await carded();
  const zone = (await zones.saveEditorial({ id: "publisher" }, { title: "官方专区", description: "", background: "", kind: "official", state: "published" }, null, null, false, "programme")).zone;
  const make = async (/** @type {string} */ state, /** @type {string} */ requestId) => (await zones.saveEditorial({ id: "publisher" }, {
    title: "官方卡", subtype: "knowledge", summary: "s", body: "- 官方结论", sources: [{ title: "指南", url: "https://example.org/g", excerpt: "指南原文：每周一次 2.5 mg。", fetchedSha256: "b".repeat(64) }],
    claims: [{ claimId: "g1", claimType: "direct", claim: "指南推荐每周一次 2.5 mg。", sourceIndexes: [1], supportQuote: "每周一次 2.5 mg" }],
    state, requestId }, zone.id, null, true, "programme")).evidence;
  const published = await make("published", "official-card-0001");
  const draft = await make("draft", "official-card-0002");
  const result = await cards.checkText(project, { layer: "popular", text: `指南推荐每周一次 2.5 mg。${ref(published.id, "g1", 1)}\n另一句 2.5 mg。${ref(draft.id, "g1", 1)}` });
  assert.deepEqual(result.graph.references.map((entry) => [entry.status, entry.mark]), [["ok", "✓"], ["card_not_found", null]]);
});

test("an article that cites a revision since corrected is flagged from the zone's change log, and one that cites the current revision is not", options, async () => {
  const { project, card } = await carded([dose, contra]);
  const old = await article(project, "old");
  const fresh = await article(project, "fresh");
  await store.setArticleReferences(project.id, old.id, { refs: [{ cardId: card.cardId, claimId: "dose", revision: 1 }], status: "resolved", sha256: "a".repeat(64) });
  // The claim changes: the card's next revision, and its owner's edit is on the zone's log as a correction.
  await store.upsertClaims("alice", project.id, [{ ...dose, statement: "成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。", quote: "成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg" }]);
  const again = await cards.refresh(await store.getProject("alice", project.id), { readSource });
  assert.equal(again.cards[0].revision, 2);
  await changeLog.append({ zoneId: again.zoneId, cardId: card.cardId, category: "correction", trigger: "producer_edit", revisionBefore: 1, revisionAfter: 2, refs: { claimId: "dose" } });
  await store.setArticleReferences(project.id, fresh.id, { refs: [{ cardId: card.cardId, claimId: "dose", revision: 2 }], status: "resolved", sha256: "b".repeat(64) });
  const articles = await store.listArticles(project.id);
  const flagged = await cards.staleReferences(await store.getProject("alice", project.id), articles);
  assert.deepEqual([...flagged.keys()], [old.id]);
  assert.equal(flagged.get(old.id)?.[0].category, "correction");
  assert.match(flagged.get(old.id)?.[0].summary ?? "", /出品方更新了本卡|修正|更新/);
  // The reference to the old revision still resolves — the snapshot of revision 1 is kept — and says what it said then.
  const text = `起始剂量。${ref(card.cardId, "dose", 1)}`;
  assert.equal((await cards.checkText(await store.getProject("alice", project.id), { text, layer: "popular" })).status, "resolved");
});

test("a card taken back flags every article that cites it, whatever revision it cites", options, async () => {
  const { project, card } = await carded([dose]);
  const row = await article(project, "cites");
  await store.setArticleReferences(project.id, row.id, { refs: [{ cardId: card.cardId, claimId: "dose", revision: 1 }], status: "resolved", sha256: "a".repeat(64) });
  await changeLog.append({ zoneId: project.productZoneId, cardId: card.cardId, category: "withdrawal", trigger: "challenge", revisionBefore: 1, revisionAfter: null, refs: { claimId: "dose" } });
  const flagged = await cards.staleReferences(project, await store.listArticles(project.id));
  assert.equal(flagged.get(row.id)?.[0].category, "withdrawal");
});

test("the card layer is the card: an article made from it has no text of its own, and a corrected card is a changed article", options, async () => {
  const { project, first, card } = await carded([dose, contra]);
  assert.ok(first.cards[0].articleId, "a card with a written public view has its card-layer article");
  const [made] = (await store.listArticles(project.id)).filter((entry) => entry.layer === "card");
  assert.equal(made.cardId, card.cardId);
  assert.equal(made.cardRevision, 1);
  assert.equal(made.path, null, "no file of its own");
  assert.equal(made.gate, "passed");
  assert.equal(made.safety, "clear");
  assert.deepEqual(made.claimIds.length, 2);
  const text = await cards.cardLayerText(project, made);
  assert.ok(text);
  assert.match(text.markdown, /## 说明书怎么说\n\n对本品活性成分或辅料过敏者禁用。成人推荐起始剂量为每周一次 2\.5 mg。/);
  assert.match(text.markdown, /出品方：某某制药有限公司/);
  assert.equal(made.contentSha256, createHash("sha256").update(text.markdown).digest("hex"), "the hash is of the rendering, which is never stored");
  // The same card again: the same article, nothing new.
  const second = await cards.refresh(await store.getProject("alice", project.id), { readSource });
  assert.equal(second.cards[0].articleId, made.id);
  assert.equal((await store.listArticles(project.id)).filter((entry) => entry.layer === "card").length, 1);
  // A corrected claim: the article is the card's new revision, with the new hash.
  await store.upsertClaims("alice", project.id, [{ ...contra, statement: "对本品过敏者禁用。", quote: "对本品活性成分或辅料过敏者禁用" }]);
  await cards.refresh(await store.getProject("alice", project.id), { readSource });
  const [changed] = (await store.listArticles(project.id)).filter((entry) => entry.layer === "card");
  assert.equal(changed.id, made.id);
  assert.equal(changed.cardRevision, 2);
  assert.notEqual(changed.contentSha256, made.contentSha256);
  assert.match((await cards.cardLayerText(await store.getProject("alice", project.id), changed))?.markdown ?? "", /对本品过敏者禁用/);
});

test("a stored card-layer article from before the chain stays readable and is not touched", options, async () => {
  const { project } = await carded([dose]);
  const [id] = await store.registerArticles("alice", project.id, [{ path: "deliverables/geo-content/articles/old-card.md", layer: "card", title: "旧证据卡片", groupId: null,
    claimIds: [], gate: "passed", safety: "clear", contentSha256: "c".repeat(64), deliverableId: "geo-content" }]);
  await cards.refresh(await store.getProject("alice", project.id), { readSource });
  const old = await store.getArticle(project.id, id);
  assert.equal(old.path, "deliverables/geo-content/articles/old-card.md");
  assert.equal(old.cardId, null);
  assert.equal(old.refStatus, "unchecked", "a release-5 article reads as unchecked, not as failed");
  assert.equal(await cards.cardLayerText(project, old), null, "a stored article has no rendering; its file is its text");
});

test("a card whose claims were all held has no card-layer article, and a sentence the pharmacists' rules refuse makes its article wait for a person", options, async () => {
  const none = await carded([{ ...dose, claimKey: "x", quote: "不在原文里的引文" }]);
  assert.deepEqual(none.first.cards, []);
  assert.equal((await store.listArticles(none.project.id)).length, 0);
  const risky = "出现胸痛时可以先吃胃药，然后等待观察。";
  readable = new Map([[".evimed-sources/label.txt", `${LABEL}${risky}`]]);
  const wait = await carded([{ ...dose, claimKey: "r", statement: risky, quote: risky }]);
  const [held] = (await store.listArticles(wait.project.id)).filter((entry) => entry.layer === "card");
  assert.equal(held.safety, "open", "the same rules the gate applies to an article apply to the card's rendering");
  assert.equal(held.status, "draft", "an article with an open safety finding is not publishable");
  // A person's release stands for the text they looked at: the same rendering stays released, a changed one is looked at again.
  await db.query("UPDATE evimed_geo.articles SET safety = 'released', status = 'publishable' WHERE id = $1", [held.id]);
  await cards.refresh(await store.getProject("alice", wait.project.id), { readSource });
  const [same] = (await store.listArticles(wait.project.id)).filter((entry) => entry.layer === "card");
  assert.deepEqual([same.safety, same.status], ["released", "publishable"]);
  const changedText = "出现胸痛时可以先吃抗酸药，然后观察一会儿。";
  readable = new Map([[".evimed-sources/label.txt", `${LABEL}${risky}${changedText}`]]);
  await store.upsertClaims("alice", wait.project.id, [{ ...dose, claimKey: "r", statement: changedText, quote: changedText }]);
  await cards.refresh(await store.getProject("alice", wait.project.id), { readSource });
  const [again] = (await store.listArticles(wait.project.id)).filter((entry) => entry.layer === "card");
  assert.equal(again.safety, "open", "the text changed, and the rules still refuse it");
});
