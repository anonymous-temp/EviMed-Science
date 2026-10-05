// 「与你相关」 reads two more inputs (flywheel F11), against a real PostgreSQL: the entity keys of the zones the reader
// follows and of their own knowledge-base documents join the profile beside the memory, the questions and the items
// they opened. A reader with only these is a profile at last, with no model call; the library is the reader's own
// rows and leaves a paused or internal project out; and a vocabulary that cannot tag costs the signal, not the profile.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createEntityVocabulary } from "../src/entityVocabulary.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FRONTIER_PROFILE_ENTITY_PHRASES, FrontierProfiles, frontierReasonText, frontierRecurringEntityKeys } from "../src/frontierProfiles.mjs";
import { FRONTIER_PROJECT_ID } from "../src/internalProjects.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem, testEmbedder, vectorAt } from "./helpers/frontierComposeFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const NOW = new Date("2026-09-22T04:00:00Z");
const CONFIG = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierAudience: "all", kbEmbeddingDimension: 1024 };
const GLOSSARY = [
  { kind: "drug", term_en: "semaglutide", term_zh: "司美格鲁肽", keep_original: false, origin: "hand" },
  { kind: "drug", term_en: "metformin", term_zh: "二甲双胍", keep_original: false, origin: "hand" },
  { kind: "drug", term_en: "apixaban", term_zh: "阿哌沙班", keep_original: false, origin: "hand" },
  { kind: "disease", term_en: "heart failure", term_zh: "心力衰竭", keep_original: false, origin: "hand" },
  { kind: "disease", term_en: "atrial fibrillation", term_zh: "房颤", keep_original: false, origin: "hand" },
  { kind: "org", term_en: "FDA", term_zh: "美国食品药品监督管理局", keep_original: false, origin: "hand" },
];

let isolated, database, memory, vocabulary, zones, editorCalls;
const alice = { id: "alice" };
const users = ["alice", "reader", "other", "bare"];

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "profileent");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateProductStore(database);
  for (const id of users) await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $1, 'development')", [id]);
  for (const [userId, id] of [["reader", "kb"], ["reader", "paused"], ["reader", FRONTIER_PROJECT_ID], ["other", "kb"]]) {
    await database.query("INSERT INTO evimed_control.projects(user_id, id, name, quota_bytes) VALUES ($1, $2, $2, 1000000)", [userId, id]);
  }
  memory = new ResearchMemoryStore({}, { database });
  // The shared vocabulary over a glossary scripted into a database double: the real tagger and the real labels.
  vocabulary = createEntityVocabulary({ database: { async query() { return { rows: GLOSSARY }; } }, enabled: true });
  zones = new EvidenceZoneService({ database, entityKeysFor: vocabulary.entityKeysFor });
});
after(async () => {
  await database?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!database) return;
  await database.query("TRUNCATE evimed_frontier.evidence_zones, evimed_frontier.items, evimed_frontier.sources, evimed_frontier.user_profiles, evimed_frontier.user_prefs CASCADE");
  await database.query("DELETE FROM evimed_product.documents");
  await insertSource(database, "nejm", { authority: 5 });
  for (const id of users) await database.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2)", [id, NOW]);
  editorCalls = [];
});

const cardInput = (title, extra = {}) => ({
  title, subtype: "academic", summary: "摘要", body: "正文", state: "published", limitations: "局限", provenance: "p",
  sources: [{ title: "Trial", url: "https://example.org/trial", excerpt: "x" }], ...extra,
});
async function followedZone(userId, title, cardTitles) {
  const { zone } = await zones.save(alice, { title, description: "d", background: "b" });
  const published = (await zones.save(alice, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  for (const cardTitle of cardTitles) await zones.save(alice, cardInput(cardTitle), published.id, null, true);
  await zones.act({ id: userId }, published.id, "follow", { expectedRevision: published.revision });
  return published;
}
/** A knowledge-base source and the understanding run that read it, as the ledger holds them. */
async function document(userId, projectId, id, { title, summary, status = "complete" }) {
  await database.query("INSERT INTO evimed_product.documents(user_id, project_id, kind, id, payload) VALUES ($1, $2, 'source', $3, $4::jsonb)",
    [userId, projectId, id, JSON.stringify({ status, paths: [`knowledge-base/${id}.pdf`], ...(title ? { metadata: { title } } : {}) })]);
  if (summary) {
    await database.query("INSERT INTO evimed_product.documents(user_id, project_id, kind, id, payload) VALUES ($1, $2, 'knowledge', $3, $4::jsonb)",
      [userId, projectId, `understanding:${id}:g1`, JSON.stringify({ recordType: "source-understanding", sourceId: id, generation: 1, output: { summary } })]);
  }
}
function profiles({ entityVocabulary = vocabulary, embed = async (text) => ({ 司美格鲁肽: vectorAt(1), 二甲双胍: vectorAt(0, 2), 心力衰竭: vectorAt(0.6, 3) })[text] ?? vectorAt(0, 9) } = {}) {
  const editor = { available: true, extractProfile: async (input) => { editorCalls.push(input); return { specialties: [], dropped: [], error: null, phrases: [] }; } };
  return new FrontierProfiles({ database, researchMemory: memory, editor, embedder: { ...testEmbedder, embedQuery: embed }, config: CONFIG,
    budget: async () => ({ state: "ok" }), now: () => NOW, entityVocabulary });
}
const stored = async (userId) => (await database.query("SELECT phrases, for_you FROM evimed_frontier.user_profiles WHERE user_id = $1", [userId])).rows[0];

test("the keys that recur most are the phrases: drugs, diseases and trials, most first, ties by the key", () => {
  assert.deepEqual(frontierRecurringEntityKeys([
    ["drug:b", "disease:x", "org:fda", "doi:10.1/x"], ["drug:b", "drug:a"], ["drug:a", "drug:b"], ["disease:x"], ["drug:c", "drug:b"],
  ], 3), ["drug:b", "disease:x", "drug:a"]);
  assert.deepEqual(frontierRecurringEntityKeys([["org:fda", "doi:10.1/x", "reg:NCT1", "nonsense"]], 3), [], "who said it, and which work, are no phrase");
  assert.deepEqual(frontierRecurringEntityKeys([["drug:a", "drug:a"]], 3), ["drug:a"], "a record counts a key once");
  assert.equal(frontierReasonText({ text: "司美格鲁肽", kind: "zone" }), "因为你关注的专区涉及：司美格鲁肽");
  assert.equal(frontierReasonText({ text: "二甲双胍", kind: "library" }), "因为你的知识库里有：二甲双胍");
  assert.ok(FRONTIER_PROFILE_ENTITY_PHRASES.zone > 0 && FRONTIER_PROFILE_ENTITY_PHRASES.library > 0);
});

test("a followed zone's keys are the reader's profile inputs, with no model call, and the zone is the reason shown", options, async () => {
  await followedZone("reader", "糖尿病用药", ["司美格鲁肽与心力衰竭", "司美格鲁肽的安全性", "二甲双胍的肾功能"]);
  const item = await insertComposedItem(database, { sourceId: "nejm", title: "Semaglutide in HF", visibleAt: NOW.toISOString(), timelineAt: NOW.toISOString(), scoreTotal: 60, vector: vectorAt(1) });
  const runner = profiles();
  const outcome = await runner.refreshUser("reader");
  assert.deepEqual(outcome, { state: "available", phrases: 3 });
  assert.equal(editorCalls.length, 0, "keys are glossary lookups: nothing language was read, no model was asked");
  const { phrases } = await stored("reader");
  assert.deepEqual(phrases.map((phrase) => [phrase.text, phrase.source, phrase.kind]).sort(), [
    ["二甲双胍", "zone", "zone"], ["司美格鲁肽", "zone", "zone"], ["心力衰竭", "zone", "zone"],
  ].sort());
  assert.ok(phrases.every((phrase) => phrase.vector), "each phrase is embedded like every other");
  const block = await runner.forYou({ id: "reader" }, async (_user, publicIds) => new Map(publicIds.map((id) => [id, { id, state: { hidden: false } }])));
  assert.equal(block.state, "available");
  assert.equal(block.items.length, 1);
  assert.equal(block.items[0].item.id, item.publicId);
  assert.equal(block.items[0].reason.text, "因为你关注的专区涉及：司美格鲁肽");
  assert.equal(block.items[0].reason.source, "zone");
  assert.equal(block.items[0].reason.memoryId, null);
  // The same reader before they followed anything is the same off block as ever.
  const bare = await profiles().refreshUser("bare");
  assert.deepEqual(bare, { state: "off", reason: "no-signal" });
  assert.equal(editorCalls.length, 0);
});

test("the library's titles and stored understanding summaries are inputs too, the reader's own rows only, paused and internal projects left out", options, async () => {
  await document("reader", "kb", "src_a", { title: "二甲双胍在老年人群中的应用", summary: "综述 房颤 患者的抗凝与阿哌沙班" });
  await document("reader", "kb", "src_b", { title: undefined, summary: "二甲双胍与肾功能" });
  await document("reader", "kb", "src_unread", { title: "司美格鲁肽（尚未读取）", summary: "司美格鲁肽", status: "queued" });
  await document("reader", "paused", "src_paused", { title: "司美格鲁肽心力衰竭", summary: "司美格鲁肽 司美格鲁肽" });
  await document("reader", FRONTIER_PROJECT_ID, "src_internal", { title: "司美格鲁肽心力衰竭", summary: "司美格鲁肽 司美格鲁肽" });
  await document("other", "kb", "src_other", { title: "司美格鲁肽心力衰竭", summary: "司美格鲁肽 司美格鲁肽 心力衰竭" });
  const runner = profiles();
  // The memory store settings are the reader's: a paused project is theirs to name.
  await memory.updateSettings("reader", { pausedProjects: ["paused"] });
  await runner.refreshUser("reader");
  const { phrases } = await stored("reader");
  assert.deepEqual(phrases.map((phrase) => [phrase.text, phrase.source]).sort(), [["二甲双胍", "library"], ["房颤", "library"], ["阿哌沙班", "library"]].sort(),
    "only what the reader's own readable library in an unpaused, ordinary project says");
  assert.equal(editorCalls.length, 0);
  assert.equal(await profiles().refreshUser("other").then((outcome) => outcome.phrases), 2, "another reader's library is theirs");
});

test("a key the zones already gave is not given twice, and the two signals fail apart", options, async () => {
  await followedZone("reader", "糖尿病用药", ["司美格鲁肽与心力衰竭"]);
  await document("reader", "kb", "src_a", { title: "司美格鲁肽的综述", summary: "二甲双胍" });
  await profiles().refreshUser("reader");
  const bySource = Object.fromEntries((await stored("reader")).phrases.map((phrase) => [phrase.text, phrase.source]));
  assert.equal(bySource["司美格鲁肽"], "zone", "the zone named it first");
  assert.equal(bySource["二甲双胍"], "library");
  // A vocabulary that fails for the library's texts only: the zones' phrases stand, the failure is counted.
  const flaky = { enabled: true, describe: vocabulary.describe, keysForText: async (input) => {
    if (input.texts.some((text) => text.includes("综述"))) throw new Error("glossary down");
    return vocabulary.keysForText(input);
  } };
  const runner = profiles({ entityVocabulary: flaky });
  await database.query("DELETE FROM evimed_frontier.user_profiles");
  await runner.refreshUser("reader");
  assert.ok(runner.status().counters.entityFailures >= 1);
  assert.ok((await stored("reader")).phrases.some((phrase) => phrase.source === "zone"));
});

test("without the vocabulary the two signals are not read, and a reader who has nothing else is off as before", options, async () => {
  await followedZone("reader", "糖尿病用药", ["司美格鲁肽与心力衰竭"]);
  const outcome = await profiles({ entityVocabulary: null }).refreshUser("reader");
  assert.deepEqual(outcome, { state: "off", reason: "no-signal" });
  const off = new FrontierProfiles({ database, researchMemory: memory, editor: { available: true, extractProfile: async () => ({ phrases: [], specialties: [] }) },
    embedder: { ...testEmbedder, embedQuery: async () => vectorAt(1) }, config: CONFIG, now: () => NOW, entityVocabulary: { enabled: false, keysForText: async () => [], describe: async () => [] } });
  assert.deepEqual(await off.refreshUser("reader"), { state: "off", reason: "no-signal" }, "a vocabulary that is off reads nothing");
});
