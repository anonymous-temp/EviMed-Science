// The frontier pipeline's state machine against a real PostgreSQL (plan
// §10.3.1): a fake plugin, a fake editor and a fake embedder, everything else
// real — the claims, the leases, the keys, the links, the selection, the
// content version.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const DIMENSION = 16;
const HOUR = 3_600_000;
const operator = `frontier_op_${randomUUID()}`;
const owner = { userId: operator, projectId: "evimed-frontier" };
/** @type {any} */
let database;
/** @type {{ vector: boolean, trigram: boolean }} */
let capabilities;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Frontier operator','development')", [operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
  await migrateUsageLedger(database);
  capabilities = await migrateFrontier(database, { dimension: DIMENSION });
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [operator]);
  await database.close();
});

const SOURCES = [
  { id: "j-nejm", name: "NEJM", lane: "evidence", source_type: "journal", access: "crossref-issn", egress: "api", authority: 5, safety_feed: false, owner_entity: "MMS", region: "US" },
  { id: "j-small", name: "Journal of Small Things", lane: "evidence", source_type: "journal", access: "crossref-issn", egress: "api", authority: 3, safety_feed: false, owner_entity: "Small", region: "US" },
  { id: "q-pubmed", name: "PubMed 查询流", lane: "evidence", source_type: "journal", access: "eutils-query", egress: "api", authority: 3, safety_feed: false, owner_entity: "NLM", region: "US" },
  { id: "m-stat", name: "STAT", lane: "mixed", source_type: "media", access: "rss", egress: "direct", authority: 2, safety_feed: false, owner_entity: "STAT", region: "US" },
  { id: "m-fierce", name: "Fierce", lane: "mixed", source_type: "media", access: "rss", egress: "direct", authority: 2, safety_feed: false, owner_entity: "Fierce", region: "US" },
  { id: "m-cn", name: "医学界", lane: "mixed", source_type: "media", access: "rss", egress: "direct", authority: 2, safety_feed: false, owner_entity: "医学界", region: "CN" },
  { id: "r-medwatch", name: "FDA MedWatch", lane: "safety", source_type: "regulator", access: "rss", egress: "direct", authority: 5, safety_feed: true, owner_entity: "FDA", region: "US" },
  { id: "r-ema", name: "EMA news", lane: "regulatory", source_type: "regulator", access: "rss", egress: "direct", authority: 5, safety_feed: false, owner_entity: "EMA", region: "EU" },
  { id: "c-novo", name: "Novo Nordisk newsroom", lane: "pipeline", source_type: "company", access: "rss", egress: "direct", authority: 2, safety_feed: false, owner_entity: "Novo", region: "DK" },
  { id: "t-ctgov", name: "ClinicalTrials.gov", lane: "pipeline", source_type: "evidence-body", access: "json-api", egress: "api", authority: 4, safety_feed: false, owner_entity: "NLM", region: "US" },
];

async function reset() {
  await database.query(`TRUNCATE evimed_frontier.item_vectors, evimed_frontier.item_texts, evimed_frontier.item_keys, evimed_frontier.item_mentions,
    evimed_frontier.item_links, evimed_frontier.item_changes, evimed_frontier.user_state, evimed_frontier.event_items, evimed_frontier.items,
    evimed_frontier.entries, evimed_frontier.sources, evimed_frontier.glossary RESTART IDENTITY CASCADE`);
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key IN ('content_version','hot_version','daily_version')");
  await database.query("DELETE FROM evimed_usage.model_requests WHERE user_id=$1", [operator]);
  for (const source of SOURCES) {
    await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'P0',$10)`, [source.id, source.name, source.lane, source.source_type, source.access, source.egress,
      source.authority, source.safety_feed, source.owner_entity, source.region]);
  }
}

let seq = 0;
/**
 * One delivered entry.
 * @param {Record<string, any>} values
 */
async function deliver(values) {
  seq += 1;
  const doi = values.doi ?? null;
  const canonical = values.canonical_url ?? values.url ?? `https://example.org/${values.source_id}/${seq}`;
  const identity = values.identity_key ?? (doi ? `doi:${doi.toLowerCase()}` : values.pmid ? `pmid:${values.pmid}` : `url:${createHash("sha256").update(canonical).digest("hex")}`);
  const row = {
    plugin_entry_id: values.plugin_entry_id ?? `${values.source_id}:${createHash("sha256").update(`${identity}:${seq}`).digest("hex").slice(0, 32)}`,
    revision: values.revision ?? 1,
    title_raw: values.title,
    summary_raw: values.summary ?? null,
    facts: values.facts ?? {},
    published_at: values.published_at ?? null,
    date_precision: values.date_precision ?? "instant",
    first_seen_at: values.first_seen_at ?? new Date("2026-09-22T10:00:00Z"),
    defects: values.defects ?? [],
    state: values.backfill ? "backfill" : "received",
  };
  const result = await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url,
      doi, pmid, registry_ids, title_raw, summary_raw, facts, lang, published_at, date_precision, first_seen_at, content_sha256, backfill, defects, state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'en',$14,$15,$16,$17,$18,$19,$20) RETURNING id, plugin_entry_id`,
  [row.plugin_entry_id, seq, row.revision, values.source_id, identity, values.url ?? canonical, canonical, doi, values.pmid ?? null,
    values.registry_ids ?? [], row.title_raw, row.summary_raw, JSON.stringify(row.facts), row.published_at, row.date_precision, row.first_seen_at,
    createHash("sha256").update(`${seq}`).digest("hex"), Boolean(values.backfill), row.defects, row.state]);
  return { id: Number(result.rows[0].id), pluginEntryId: result.rows[0].plugin_entry_id };
}

/** The plugin's `/text`: what each entry answers, `pending` by default. */
function fakePlugin() {
  /** @type {Map<string, any>} */
  const texts = new Map();
  /** @type {string[]} */
  const asked = [];
  return {
    texts, asked,
    async text(/** @type {string} */ entryId) {
      asked.push(entryId);
      const answer = texts.get(entryId);
      if (answer instanceof Error) throw answer;
      return answer ?? { entry_id: entryId, revision: 1, status: "pending", abstract: null, body_excerpt: null, enrichment: {} };
    },
  };
}

/** @param {string} title */
const marker = (title, name) => new RegExp(`\\[${name}:([a-z0-9-]+)\\]`).exec(title)?.[1] ?? null;

/**
 * An editor whose judgement is written into the titles: [offtopic], [notnews],
 * [lane:x], [score:n] (the model's share of the total), [pending],
 * [edit-throws], [screen-error].
 */
function fakeEditor() {
  /** @type {{ screen: string[][], edit: string[] }} */
  const calls = { screen: [], edit: [] };
  return {
    owner, available: true, calls,
    /** @param {any[]} batch */
    async screen(batch) {
      calls.screen.push(batch.map((input) => input.key));
      const verdicts = new Map();
      const errors = new Map();
      for (const input of batch) {
        if (input.title.includes("[screen-error]")) { errors.set(input.key, "frontier_screen_invalid"); continue; }
        const wanted = marker(input.title, "lane");
        verdicts.set(input.key, {
          medical: !input.title.includes("[offtopic]"), news: !input.title.includes("[notnews]"),
          lane: wanted && input.allowedLanes.includes(wanted) ? wanted : input.allowedLanes[0],
          specialties: ["cardiology"], language: "en",
        });
      }
      return { verdicts, errors, calls: 1 };
    },
    /** @param {any} item */
    async edit(item) {
      calls.edit.push(item.titleRaw);
      if (item.titleRaw.includes("[edit-throws]")) throw Object.assign(new Error("boom"), { code: "frontier_test_boom" });
      const modelInput = buildModelInput(item);
      const base = { modelInput, modelInputSha256: sha256(modelInput), attempts: 1, issues: [], numbers: null, error: null,
        model: "deepseek-flash", editorVersion: FRONTIER_EDITOR_VERSION };
      if (item.titleRaw.includes("[pending]")) return { ...base, verification: "pending", output: null, error: "model_gateway_timeout" };
      const share = Number(marker(item.titleRaw, "score") ?? 30);
      const impact = Math.min(30, share);
      const novelty = Math.min(20, share - impact);
      const relevance = Math.min(20, share - impact - novelty);
      const lane = marker(item.titleRaw, "lane");
      return { ...base, verification: "passed", output: {
        titleZh: item.isChinese ? item.titleRaw : `中文：${item.titleRaw.slice(0, 20)}`,
        summaryZh: `导读：${item.abstract ? "有摘要" : "无摘要"}。`, reasonZh: "值得一看。",
        lane: lane && item.allowedLanes.includes(lane) ? lane : item.allowedLanes[0],
        specialties: ["cardiology"], evidenceType: item.evidenceFixed?.type ?? "observational",
        entities: { drugs: ["司美格鲁肽"], trials: [], orgs: [], diseases: [] },
        scores: { impact, novelty, relevance }, flags: [],
      } };
    },
  };
}

function fakeEmbedder({ fail = 0 } = {}) {
  let failures = fail;
  return {
    configured: true, modelKey: `fake@${DIMENSION}`, dimension: DIMENSION, calls: 0,
    /** @param {string[]} texts */
    async embedDocuments(texts) {
      this.calls += 1;
      if (failures > 0) { failures -= 1; throw Object.assign(new Error("down"), { code: "kb_embedding_unavailable" }); }
      return texts.map((text, index) => Array.from({ length: DIMENSION }, (_, at) => ((text.length + index + at) % 7) + 1));
    },
  };
}

/** @param {{ now: () => Date, editor?: any, plugin?: any, embedder?: any, config?: Record<string, any> }} input */
function pipelineWith({ now, editor = fakeEditor(), plugin = fakePlugin(), embedder = fakeEmbedder(), config = {} }) {
  const pipeline = new FrontierPipeline({
    database, editor, plugin, embedder, now, workerId: `test-${randomUUID()}`,
    glossary: new FrontierGlossary([{ kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false }]),
    config: { kbEmbeddingDimension: DIMENSION, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 10, frontierSelectThreshold: 70, ...config },
  });
  return { pipeline, editor, plugin, embedder };
}

/** @param {number} id */
async function entry(id) {
  return (await database.query("SELECT * FROM evimed_frontier.entries WHERE id=$1", [id])).rows[0];
}
/** @param {number} itemId */
async function item(itemId) {
  return (await database.query("SELECT * FROM evimed_frontier.items WHERE id=$1", [itemId])).rows[0];
}
async function contentVersion() {
  return Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key='content_version'")).rows[0].value);
}
/** @param {number} itemId */
async function changes(itemId) {
  return (await database.query("SELECT reason FROM evimed_frontier.item_changes WHERE item_id=$1 ORDER BY seq", [itemId])).rows.map((row) => row.reason);
}

test("the state machine end to end: drop, notice, dedupe, screen, hold, promote, edit, publish, merge, re-edit", options, async () => {
  await reset();
  // Tuesday 20:00 in Beijing: off-peak.
  let clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline, editor, plugin } = pipelineWith({ now: () => clock });
  const nejm = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMoa2307563", pmid: "37952131", title: "Semaglutide and Cardiovascular Outcomes [score:60]",
    summary: "Short.", defects: ["short-summary"], published_at: new Date("2026-09-21T21:00:00Z"), registry_ids: ["NCT03574597"] });
  const stream = await deliver({ source_id: "q-pubmed", doi: "10.1056/nejmoa2307563", pmid: "37952131", title: "Semaglutide and cardiovascular outcomes." });
  const masthead = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx1", title: "Editorial Board" });
  const notice = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx2", title: "Correction: Semaglutide and Cardiovascular Outcomes",
    facts: { is_correction_notice: true, update_to: [{ type: "correction", doi: "10.1056/NEJMoa2307563", date: "2026-09-22" }] } });
  const offtopic = await deliver({ source_id: "m-stat", title: "Stock markets rally [offtopic]" });
  const safety = await deliver({ source_id: "r-medwatch", title: "Drug Safety Communication: new boxed warning [score:5]", summary: "A".repeat(120) });
  const registered = await deliver({ source_id: "t-ctgov", identity_key: "reg:NCT07000001:registered:2026-09-21", canonical_url: "https://clinicaltrials.gov/study/NCT07000001",
    registry_ids: ["NCT07000001"], title: "A Trial of Something New", facts: { trial_event: "registered" } });
  const results = await deliver({ source_id: "t-ctgov", identity_key: "reg:NCT07000001:results-posted:2026-09-22", canonical_url: "https://clinicaltrials.gov/study/NCT07000001",
    registry_ids: ["NCT07000001"], title: "A Trial of Something New: results", facts: { trial_event: "results-posted" } });
  const backfill = await deliver({ source_id: "m-stat", title: "An old story", backfill: true });
  const chinese = await deliver({ source_id: "m-cn", title: "国家药监局批准一款新药上市", summary: "国".repeat(100) });
  const company = await deliver({ source_id: "c-novo", title: "Novo Nordisk announces topline results", summary: "N".repeat(100) });
  for (const id of [safety, registered, results, chinese, company]) {
    plugin.texts.set(id.pluginEntryId, { entry_id: id.pluginEntryId, revision: 1, status: "unavailable", abstract: null, body_excerpt: null, enrichment: {} });
  }

  const first = await pipeline.processBatch();
  assert.equal(first.claimed, 10, "the backfill entry is never claimed");
  assert.equal((await entry(backfill.id)).state, "backfill");
  assert.deepEqual([(await entry(masthead.id)).state, (await entry(masthead.id)).state_reason], ["dropped", "masthead"]);
  assert.deepEqual([(await entry(offtopic.id)).state, (await entry(offtopic.id)).state_reason], ["screened-out", "not-medical"]);
  assert.deepEqual([(await entry(notice.id)).state, (await entry(notice.id)).state_reason], ["dropped", "correction-notice"]);
  // The PubMed sighting of the same paper waits for the NEJM one, in flight in the same batch.
  const waiting = await entry(stream.id);
  assert.deepEqual([waiting.state, waiting.state_reason, waiting.item_id], ["received", "in-flight-duplicate", null]);
  assert.ok(new Date(waiting.hold_until) > clock);
  // NEJM never waits for its abstract: published now, and asked again in twelve hours.
  const nejmEntry = await entry(nejm.id);
  assert.equal(nejmEntry.state, "held");
  assert.equal(new Date(nejmEntry.hold_until).getTime(), clock.getTime() + 12 * HOUR);
  const paper = await item(Number(nejmEntry.item_id));
  assert.equal(paper.state, "published");
  assert.equal(paper.verification, "passed");
  assert.deepEqual([paper.evidence_type, paper.evidence_basis, paper.score_authority], ["observational", "model", 24],
    "the model's evidence type until PubMed's types arrive: 30 × 5/5 × 0.8");
  assert.deepEqual([paper.selected, paper.selected_rule], [true, "threshold"]);
  assert.deepEqual(paper.flags, ["no-abstract", "corrected"], "the notice that came first is attached at publication");
  assert.equal(paper.timeline_at.toISOString(), clock.toISOString(), "published 15 hours after its date: today");
  assert.deepEqual(await changes(Number(paper.id)), ["published"]);
  const link = (await database.query("SELECT * FROM evimed_frontier.item_links")).rows[0];
  assert.deepEqual([link.kind, link.from_doi, link.to_doi, Number(link.to_item_id), link.asserted_by], ["correction", "10.1056/nejmx2", "10.1056/nejmoa2307563", Number(paper.id), "crossref"]);
  const keys = (await database.query("SELECT key FROM evimed_frontier.item_keys WHERE item_id=$1 ORDER BY key", [paper.id])).rows.map((row) => row.key);
  assert.ok(keys.includes("doi:10.1056/nejmoa2307563") && keys.includes("pmid:37952131") && keys.includes("reg:NCT03574597"));
  const texts = (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id=$1", [paper.id])).rows[0];
  assert.equal(texts.model_input_sha256, createHash("sha256").update(texts.model_input).digest("hex"));
  assert.match(texts.model_input, /- semaglutide → 司美格鲁肽/, "only the glossary entries the text names");
  // The safety feed is selected whatever its score; the registry's two events are two items.
  const safetyItem = await item(Number((await entry(safety.id)).item_id));
  assert.deepEqual([safetyItem.state, safetyItem.selected, safetyItem.selected_rule, safetyItem.safety_alert, safetyItem.evidence_type],
    ["published", true, "safety-bypass", true, "safety-notice"]);
  const registeredItem = await item(Number((await entry(registered.id)).item_id));
  const resultsItem = await item(Number((await entry(results.id)).item_id));
  assert.notEqual(registeredItem.id, resultsItem.id, "results posted is news of its own, not another road to the registration");
  assert.deepEqual([registeredItem.evidence_type, registeredItem.evidence_basis], ["other", "registry"]);
  assert.ok(registeredItem.flags.includes("registry-unpublished"));
  assert.ok(!resultsItem.flags.includes("registry-unpublished"));
  const chineseItem = await item(Number((await entry(chinese.id)).item_id));
  assert.equal(chineseItem.title_zh, "国家药监局批准一款新药上市", "a Chinese source's title is not translated");
  assert.ok(chineseItem.flags.includes("china"));
  const companyItem = await item(Number((await entry(company.id)).item_id));
  assert.deepEqual([companyItem.evidence_type, companyItem.flags.includes("press-release")], ["press-release", true]);
  const version = await contentVersion();
  assert.ok(version >= 6, `content version ${version}`);
  assert.equal(editor.calls.screen.length, 1, "one screening call for the batch");

  // Eleven minutes later the PubMed sighting finds the published paper: another road.
  clock = new Date(clock.getTime() + 11 * 60_000);
  const second = await pipeline.processBatch();
  assert.equal(second.merged, 1);
  const merged = await entry(stream.id);
  assert.deepEqual([merged.state, Number(merged.item_id)], ["merged", Number(paper.id)]);
  const mentions = (await database.query("SELECT source_id FROM evimed_frontier.item_mentions WHERE item_id=$1", [paper.id])).rows;
  assert.deepEqual(mentions.map((row) => row.source_id), ["q-pubmed"]);
  assert.ok(await contentVersion() > version, "「还有谁在说」 is a change a reader sees");

  // Twelve hours on, the abstract and PubMed's types arrive: the evidence type is
  // corrected by code, the no-abstract flag goes, and the item is edited again once.
  clock = new Date(clock.getTime() + 12 * HOUR);
  plugin.texts.set(nejm.pluginEntryId, { entry_id: nejm.pluginEntryId, revision: 1, status: "available", abstract: "In 17,604 patients, events fell by 20%.",
    body_excerpt: null, enrichment: { publication_types: ["Randomized Controlled Trial", "Journal Article"], journal: "N Engl J Med" } });
  const editsBefore = editor.calls.edit.length;
  const third = await pipeline.processBatch();
  assert.equal(third.rescored, 1);
  assert.equal((await entry(nejm.id)).state, "promoted");
  const edited = await item(Number(paper.id));
  assert.deepEqual([edited.evidence_type, edited.evidence_basis, edited.score_authority], ["rct", "pubmed-types", 30]);
  assert.deepEqual(edited.flags, ["corrected"]);
  assert.ok(edited.rescored_at, "re-scored once");
  assert.equal(edited.editor_version, FRONTIER_EDITOR_VERSION);
  assert.equal(edited.summary_zh, "导读：有摘要。");
  assert.equal(editor.calls.edit.length, editsBefore + 1);
  assert.deepEqual(await changes(Number(paper.id)), ["published", "rescored"]);
  assert.equal(edited.timeline_at.toISOString(), paper.timeline_at.toISOString(), "timeline_at never moves after publication");
  // The item text the re-edit used is the one stored.
  const retexts = (await database.query("SELECT model_input FROM evimed_frontier.item_texts WHERE item_id=$1", [paper.id])).rows[0];
  assert.match(retexts.model_input, /摘要：In 17,604 patients/);
});

test("peak hours and the budget: non-urgent items are published title-only and edited later; a spent budget collects only", options, async () => {
  await reset();
  // Tuesday 10:00 in Beijing: the provider's peak.
  let clock = new Date("2026-09-22T02:00:00Z");
  const { pipeline, editor, plugin } = pipelineWith({ now: () => clock });
  const media = await deliver({ source_id: "m-stat", title: "Semaglutide study in adolescents [score:60]", summary: "S".repeat(200) });
  const regulator = await deliver({ source_id: "r-ema", title: "EMA recommends approval of a new medicine [score:50]", summary: "E".repeat(200) });
  for (const id of [media, regulator]) plugin.texts.set(id.pluginEntryId, { entry_id: id.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  const peak = await pipeline.processBatch();
  assert.equal(peak.published, 2);
  assert.equal(peak.deferred, 1);
  const titleOnly = await item(Number((await entry(media.id)).item_id));
  assert.deepEqual([titleOnly.verification, titleOnly.editor_version, titleOnly.title_zh, titleOnly.selected], ["pending", null, null, false]);
  const urgent = await item(Number((await entry(regulator.id)).item_id));
  assert.equal(urgent.verification, "passed", "a regulator is edited at peak");
  assert.deepEqual(editor.calls.edit, ["EMA recommends approval of a new medicine [score:50]"]);

  // 19:00: the edit owed is made, and the item may now be selected.
  clock = new Date("2026-09-22T11:00:00Z");
  const evening = await pipeline.processBatch();
  assert.equal(evening.rescored, 1);
  const done = await item(Number(titleOnly.id));
  assert.deepEqual([done.verification, done.selected, done.selected_rule], ["passed", true, "threshold"]);
  assert.ok(done.rescored_at);
  assert.deepEqual(await changes(Number(done.id)), ["published", "rescored", "selected"]);
  assert.equal(done.timeline_at.toISOString(), titleOnly.timeline_at.toISOString());

  // 8.5 of 10 spent today: throttled — only urgent items are edited.
  await database.query(`INSERT INTO evimed_usage.model_requests (id,user_id,project_id,model,price_version,currency,request_fingerprint,status,
      reserved_cost,actual_cost,priced,reservation_expires_at,created_at,settled_at,purpose)
    VALUES ($1,$2,'evimed-frontier','deepseek-flash','v','CNY',$3,'settled',8.5,8.5,true,$4,$4,$4,'frontier')`,
  [randomUUID(), operator, "a".repeat(64), new Date("2026-09-22T10:00:00Z")]);
  const quiet = await deliver({ source_id: "m-fierce", title: "Biotech raises a round [score:60]", summary: "F".repeat(200) });
  plugin.texts.set(quiet.pluginEntryId, { entry_id: quiet.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  const throttled = await pipeline.processBatch();
  assert.equal((await pipeline.budget(clock)).state, "throttled");
  assert.equal(throttled.published, 1);
  assert.equal((await item(Number((await entry(quiet.id)).item_id))).verification, "pending");

  // 10.5 spent: nothing more is screened; the entry waits for tomorrow.
  await database.query(`INSERT INTO evimed_usage.model_requests (id,user_id,project_id,model,price_version,currency,request_fingerprint,status,
      reserved_cost,reservation_expires_at,created_at,purpose)
    VALUES ($1,$2,'evimed-frontier','deepseek-flash','v','CNY',$3,'reserved',2,$4,$5,'frontier')`,
  [randomUUID(), operator, "b".repeat(64), new Date("2026-09-22T12:00:00Z"), new Date("2026-09-22T10:30:00Z")]);
  const late = await deliver({ source_id: "m-stat", title: "Another story [score:60]" });
  const screensBefore = editor.calls.screen.length;
  const exhausted = await pipeline.processBatch();
  assert.equal(exhausted.deferred, 1);
  assert.equal(editor.calls.screen.length, screensBefore, "no model call at all");
  const collected = await entry(late.id);
  assert.deepEqual([collected.state, collected.state_reason], ["received", "budget-exhausted"]);
  assert.equal(new Date(collected.hold_until).toISOString(), "2026-09-22T16:00:00.000Z", "tomorrow in Beijing");
});

test("selection: three a day per source, the lane floor for a lane with nothing selected", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline, plugin } = pipelineWith({ now: () => clock });
  const papers = [];
  for (let index = 0; index < 4; index += 1) {
    papers.push(await deliver({ source_id: "j-small", doi: `10.1000/small.${index}`, title: `Small journal paper ${index} [score:60]`, summary: "P".repeat(200) }));
  }
  const floor = await deliver({ source_id: "m-stat", title: "Measles cases rise in two provinces [lane:public-health] [score:55]", summary: "M".repeat(200) });
  const lower = await deliver({ source_id: "m-fierce", title: "Vaccination campaign expands [lane:public-health] [score:45]", summary: "V".repeat(200) });
  for (const id of [...papers, floor, lower]) plugin.texts.set(id.pluginEntryId, { entry_id: id.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  await pipeline.processBatch();
  const selected = (await database.query(`SELECT i.title_raw, i.selected, i.selected_rule, i.score_total, i.lane FROM evimed_frontier.items i ORDER BY i.id`)).rows;
  const small = selected.filter((row) => row.title_raw.startsWith("Small journal"));
  assert.deepEqual(small.map((row) => row.score_total), [74, 74, 74, 74], "authority 3 × 0.8 = 14, plus the model's 60");
  assert.equal(small.filter((row) => row.selected).length, 3, "the fourth is over the source's cap");
  const health = selected.filter((row) => row.lane === "public-health");
  assert.deepEqual(health.map((row) => [row.score_total, row.selected, row.selected_rule]), [[65, true, "lane-floor"], [55, false, null]],
    "below the threshold, but the lane's best at or above 60");
});

test("a title near duplicate among a lane's published items is merged; a revision replaces the earlier one", options, async () => {
  await reset();
  let clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline, editor, plugin } = pipelineWith({ now: () => clock });
  const first = await deliver({ source_id: "m-stat", title: "Semaglutide Cuts Heart Attacks in Adults With Obesity", summary: "S".repeat(200) });
  plugin.texts.set(first.pluginEntryId, { entry_id: first.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  await pipeline.processBatch();
  const published = await item(Number((await entry(first.id)).item_id));
  assert.equal(published.state, "published");

  clock = new Date(clock.getTime() + HOUR);
  const copy = await deliver({ source_id: "m-fierce", title: "Semaglutide cuts heart attacks in adults with obesity!", summary: "F".repeat(200) });
  await pipeline.processBatch();
  const merged = await entry(copy.id);
  assert.deepEqual([merged.state, merged.state_reason, Number(merged.item_id)], ["merged", "title-duplicate", Number(published.id)]);
  assert.equal(capabilities.trigram, false, "this database has no pg_trgm: the normalised-title fallback decided");

  // The source corrects its title: a new revision of the same entry.
  clock = new Date(clock.getTime() + HOUR);
  const revised = await deliver({ source_id: "m-stat", plugin_entry_id: first.pluginEntryId, revision: 2,
    title: "Semaglutide cuts heart attacks in adults with obesity, trial finds", summary: "S".repeat(200) });
  plugin.texts.set(first.pluginEntryId, { entry_id: first.pluginEntryId, revision: 2, status: "unavailable", enrichment: {} });
  const edits = editor.calls.edit.length;
  const round = await pipeline.processBatch();
  assert.equal(round.rescored, 1, "the changed title is edited again");
  assert.equal(editor.calls.edit.length, edits + 1);
  const replaced = await item(Number(published.id));
  assert.equal(replaced.title_raw, "Semaglutide cuts heart attacks in adults with obesity, trial finds");
  assert.deepEqual([(await entry(first.id)).state, (await entry(first.id)).state_reason], ["merged", "superseded"]);
  assert.deepEqual([(await entry(revised.id)).state, Number((await entry(revised.id)).item_id)], ["promoted", Number(published.id)]);
});

test("failures are attempts: a third one fails the entry or the item with its reason", options, async () => {
  await reset();
  let clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline, plugin } = pipelineWith({ now: () => clock });
  const bad = await deliver({ source_id: "m-stat", title: "Cannot be screened [screen-error]" });
  const boom = await deliver({ source_id: "m-stat", doi: "10.1000/boom", title: "Edits explode [edit-throws]", summary: "B".repeat(200) });
  plugin.texts.set(boom.pluginEntryId, { entry_id: boom.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  for (let round = 0; round < 3; round += 1) {
    await pipeline.processBatch();
    clock = new Date(clock.getTime() + 60_000);
  }
  const failed = await entry(bad.id);
  assert.deepEqual([failed.state, failed.state_reason, failed.attempts], ["failed", "frontier_screen_invalid", 3]);
  const exploded = await item(Number((await entry(boom.id)).item_id));
  assert.deepEqual([exploded.state, exploded.attempts], ["failed", 3]);
  const status = pipeline.status();
  assert.equal(status.lastError, null, "a failed row is the row's, not the batch's");
  assert.ok(status.counters.failed >= 2);

  // Seen again from another source, the failed work is adopted, not merged into
  // an invisible item and not blocked behind it.
  const again = await deliver({ source_id: "m-fierce", doi: "10.1000/boom", title: "Edits explode, again", summary: "C".repeat(200) });
  plugin.texts.set(again.pluginEntryId, { entry_id: again.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  await pipeline.processBatch();
  const adopted = await entry(again.id);
  assert.deepEqual([adopted.state, Number(adopted.item_id)], ["promoted", Number(exploded.id)]);
  const revived = await item(Number(exploded.id));
  assert.equal(revived.state, "screened", "back in its queue (and the editor that throws failed it once more)");
  assert.equal(revived.attempts, 1);
});

test("vectors come after publication and never block it; two concurrent batches never claim one entry twice", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  const embedder = fakeEmbedder({ fail: 1 });
  const editor = fakeEditor();
  const plugin = fakePlugin();
  const a = pipelineWith({ now: () => clock, editor, plugin, embedder }).pipeline;
  const b = pipelineWith({ now: () => clock, editor, plugin, embedder }).pipeline;
  const delivered = [];
  for (let index = 0; index < 30; index += 1) {
    const id = await deliver({ source_id: index % 2 ? "m-stat" : "m-fierce", title: `Story number ${index} about semaglutide [score:40]`, summary: "X".repeat(200) });
    plugin.texts.set(id.pluginEntryId, { entry_id: id.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
    delivered.push(id);
  }
  const [left, right] = await Promise.all([a.processBatch(), b.processBatch()]);
  assert.equal(left.claimed + right.claimed, 30, "twenty and ten, or any split — never an entry twice");
  const screened = editor.calls.screen.flat();
  assert.equal(new Set(screened).size, screened.length);
  const published = Number((await database.query("SELECT count(*) FROM evimed_frontier.items WHERE state='published'")).rows[0].count);
  assert.equal(published, 30, "every item published although the first embedding failed");
  if (capabilities.vector) {
    const vectors = Number((await database.query("SELECT count(*) FROM evimed_frontier.item_vectors")).rows[0].count);
    assert.ok(vectors < 30, "the failed embedding waits for the next round");
    await a.processBatch();
    await a.processBatch();
    const after = (await database.query("SELECT count(*)::integer AS count, min(model_key) AS model FROM evimed_frontier.item_vectors")).rows[0];
    assert.equal(after.count, 30);
    assert.equal(after.model, `fake@${DIMENSION}`);
  }
});
