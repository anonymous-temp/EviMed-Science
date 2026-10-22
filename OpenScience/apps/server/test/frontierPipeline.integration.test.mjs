// The frontier pipeline's state machine against a real PostgreSQL (plan
// §10.3.1): a fake plugin, a fake editor and a fake embedder, everything else
// real — the claims, the leases, the keys, the links, the selection, the
// content version.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { FrontierDaily } from "../src/frontierDaily.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FRONTIER_TEXT_AFTER_ATTEMPT_MS, FrontierPipeline } from "../src/frontierPipeline.mjs";
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
/** Thirty titles far apart in wording, for tests that must not merge. */
const DISTINCT_TOPICS = [
  "Aspirin in elderly primary prevention",
  "Statin intolerance and muscle pain",
  "Warfarin genotype dosing",
  "Metformin in pregnancy outcomes",
  "Insulin pump adherence in teenagers",
  "Antibiotic stewardship in nursing homes",
  "Vaccine uptake among health workers",
  "Opioid tapering after surgery",
  "Hypertension apps in rural clinics",
  "Kidney function after contrast imaging",
  "Asthma biologics cost review",
  "Hepatitis C cure in prisons",
  "Migraine prevention with antibodies",
  "Sepsis bundles in emergency rooms",
  "Stroke thrombectomy transfer times",
  "Dementia screening in primary care",
  "Osteoporosis drug holidays",
  "Psoriasis biosimilar switching",
  "Tuberculosis shorter regimens",
  "Anemia iron infusion safety",
  "Gout flare prophylaxis",
  "Depression ketamine clinics",
  "Childhood obesity school meals",
  "Heart failure telemonitoring",
  "Atrial fibrillation smartwatch alerts",
  "Lung cancer screening uptake",
  "Malaria bed net durability",
  "Neonatal jaundice phototherapy at home",
  "Rheumatoid arthritis tapering",
  "Glaucoma drop adherence",
];

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
  { id: "p-medrxiv", name: "medRxiv", lane: "evidence", source_type: "preprint", access: "rss", egress: "direct", authority: 2, safety_feed: false, owner_entity: "medRxiv", region: "US" },
  { id: "p-biorxiv", name: "bioRxiv", lane: "evidence", source_type: "preprint", access: "rss", egress: "direct", authority: 2, safety_feed: false, owner_entity: "bioRxiv", region: "US" },
  { id: "t-ctgov", name: "ClinicalTrials.gov", lane: "pipeline", source_type: "evidence-body", access: "json-api", egress: "api", authority: 4, safety_feed: false, owner_entity: "NLM", region: "US" },
];

async function reset() {
  await database.query(`TRUNCATE ${capabilities.vector ? "evimed_frontier.item_vectors, " : ""}evimed_frontier.item_texts, evimed_frontier.item_keys, evimed_frontier.item_mentions,
    evimed_frontier.item_links, evimed_frontier.item_changes, evimed_frontier.user_state, evimed_frontier.event_items, evimed_frontier.items,
    evimed_frontier.entries, evimed_frontier.sources, evimed_frontier.glossary, evimed_frontier.dailies RESTART IDENTITY CASCADE`);
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

/**
 * The plugin's `/text`: what each entry answers, `pending` by default — and,
 * like the plugin, a pending answer names its next try: the moment it was
 * first asked (given a clock).
 * @param {(() => Date) | null} [now]
 */
function fakePlugin(now = null) {
  /** @type {Map<string, any>} */
  const texts = new Map();
  /** @type {string[]} */
  const asked = [];
  /** @type {Map<string, string>} */
  const scheduled = new Map();
  return {
    texts, asked,
    async text(/** @type {string} */ entryId) {
      asked.push(entryId);
      const answer = texts.get(entryId);
      if (answer instanceof Error) throw answer;
      if (answer) return answer;
      if (now && !scheduled.has(entryId)) scheduled.set(entryId, now().toISOString());
      return { entry_id: entryId, revision: 1, status: "pending", abstract: null, body_excerpt: null, next_attempt_at: scheduled.get(entryId) ?? null, enrichment: {} };
    },
  };
}

/** @param {string} title */
const marker = (title, name) => new RegExp(`\\[${name}:([a-z0-9-]+)\\]`).exec(title)?.[1] ?? null;

/**
 * An editor whose judgement is written into the titles: [offtopic], [notnews],
 * [lane:x], [score:n] (the model's share of the total), [flag:x] (a flag it
 * proposes), [pending], [edit-throws], [screen-error], [digest] (a piece
 * covering several stories).
 */
function fakeEditor(provider = { balanceSpent: false }) {
  /** @type {{ screen: string[][], edit: string[] }} */
  const calls = { screen: [], edit: [] };
  return {
    owner, available: true, calls, provider,
    /** @param {any[]} batch */
    async screen(batch) {
      calls.screen.push(batch.map((input) => input.key));
      const verdicts = new Map();
      const errors = new Map();
      for (const input of batch) {
        // The provider's answer for a spent balance, as the editor reports it.
        if (provider.balanceSpent) { errors.set(input.key, "model_gateway_payment_required"); continue; }
        if (input.title.includes("[screen-error]")) { errors.set(input.key, "frontier_screen_invalid"); continue; }
        const wanted = marker(input.title, "lane");
        verdicts.set(input.key, {
          medical: !input.title.includes("[offtopic]"), news: !input.title.includes("[notnews]"),
          lane: wanted && input.allowedLanes.includes(wanted) ? wanted : input.allowedLanes[0],
          specialties: ["cardiology"], language: "en", digest: input.title.includes("[digest]"),
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
        model: "deepseek-flash", editorVersion: FRONTIER_EDITOR_VERSION, fieldDiagnostics: { title_zh: ["passed"], summary_zh: ["passed"] } };
      if (item.titleRaw.includes("[pending]")) return { ...base, verification: "pending", output: null, error: "model_gateway_timeout" };
      if (provider.balanceSpent) return { ...base, verification: "pending", output: null, error: "model_gateway_payment_required" };
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
        scores: { impact, novelty, relevance }, flags: marker(item.titleRaw, "flag") ? [marker(item.titleRaw, "flag")] : [],
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
function pipelineWith({ now, editor = fakeEditor(), plugin = fakePlugin(now), embedder = fakeEmbedder(), config = {} }) {
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
  const column = await deliver({ source_id: "m-stat", title: "Pharmalittle: two read-outs, a recall, and more [digest]", summary: "P".repeat(200),
    registry_ids: ["NCT07000001", "NCT03574597"] });
  for (const id of [safety, registered, results, chinese, company]) {
    plugin.texts.set(id.pluginEntryId, { entry_id: id.pluginEntryId, revision: 1, status: "unavailable", abstract: null, body_excerpt: null, enrichment: {} });
  }

  const first = await pipeline.processBatch();
  assert.equal(first.claimed, 11, "the backfill entry is never claimed");
  // A piece covering several stories is marked by screening, and the trials it
  // names are mentions: no cluster key of its own is written for them.
  const columnItem = await item(Number((await entry(column.id)).item_id));
  assert.ok(columnItem.flags.includes("digest"));
  assert.deepEqual((await database.query("SELECT key FROM evimed_frontier.item_keys WHERE item_id=$1 AND key LIKE 'reg:%'", [columnItem.id])).rows, [],
    "a story that names two trials states mentions, not identity");
  assert.equal((await entry(backfill.id)).state, "backfill");
  assert.deepEqual([(await entry(masthead.id)).state, (await entry(masthead.id)).state_reason], ["dropped", "masthead"]);
  assert.deepEqual([(await entry(offtopic.id)).state, (await entry(offtopic.id)).state_reason], ["screened-out", "not-medical"]);
  assert.deepEqual([(await entry(notice.id)).state, (await entry(notice.id)).state_reason], ["dropped", "correction-notice"]);
  // The PubMed sighting of the same paper waits for the NEJM one, in flight in the same batch.
  const waiting = await entry(stream.id);
  assert.deepEqual([waiting.state, waiting.state_reason, waiting.item_id], ["received", "in-flight-duplicate", null]);
  assert.ok(new Date(waiting.hold_until) > clock);
  // NEJM never waits for its abstract: published now, and asked again just
  // after the plugin's own try — which it schedules the moment it is asked.
  const nejmEntry = await entry(nejm.id);
  assert.equal(nejmEntry.state, "held");
  assert.equal(new Date(nejmEntry.hold_until).getTime(), clock.getTime() + FRONTIER_TEXT_AFTER_ATTEMPT_MS);
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
  editor.available = false;
  await pipeline.processBatch();
  assert.deepEqual((await item(Number(paper.id))).editor_diagnostics, {}, "late source text invalidates previous field diagnoses");
  editor.available = true;
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

test("a relation is classified by its type: each notice is its own state, and a new version is an item, never a 更正", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline } = pipelineWith({ now: () => clock });
  const notices = {
    correction: await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx21", title: "Erratum: A trial of something", facts: { is_correction_notice: true, update_to: [{ type: "erratum", doi: "10.1056/NEJMoa1000002" }] } }),
    retraction: await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx22", title: "Retraction: Another trial", facts: { is_correction_notice: true, update_to: [{ type: "retraction", doi: "10.1056/NEJMoa1000003" }] } }),
    "expression-of-concern": await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx23", title: "Expression of concern: A third trial", facts: { update_to: [{ type: "expression_of_concern", doi: "10.1056/NEJMoa1000004" }] } }),
    withdrawal: await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx24", title: "Notice of withdrawal: A fourth trial", facts: { update_to: [{ type: "withdrawal", doi: "10.1056/NEJMoa1000005" }] } }),
  };
  // The plugin's old build flagged every relation a correction notice; the type decides, not the flag's presence.
  const version = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMoa1000010v2", title: "Colchicine in pericarditis: second version",
    summary: "S".repeat(120), facts: { update_to: [{ type: "new_version", doi: "10.1056/NEJMoa1000010" }] } });
  const addendum = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMx25", title: "Dapagliflozin in kidney disease: further analysis",
    summary: "A".repeat(120), facts: { update_to: [{ type: "addendum", doi: "10.1056/NEJMoa1000011" }] } });
  await pipeline.processBatch();
  for (const [kind, delivered] of Object.entries(notices)) {
    assert.deepEqual([(await entry(delivered.id)).state, (await entry(delivered.id)).state_reason], ["dropped", `${kind}-notice`], kind);
  }
  for (const delivered of [version, addendum]) {
    const row = await entry(delivered.id);
    assert.ok(!/-notice/.test(String(row.state_reason ?? "")), `an update is not dropped as a notice: ${row.state} / ${row.state_reason}`);
  }
  // What each relation says is kept as its own kind of link; only the new version's names no flag.
  const links = (await database.query("SELECT kind, from_doi, to_doi FROM evimed_frontier.item_links ORDER BY kind, to_doi")).rows
    .map((row) => [row.kind, row.from_doi, row.to_doi]);
  assert.deepEqual(links, [
    ["correction", "10.1056/nejmx21", "10.1056/nejmoa1000002"],
    ["expression-of-concern", "10.1056/nejmx23", "10.1056/nejmoa1000004"],
    ["new-version", "10.1056/nejmoa1000010v2", "10.1056/nejmoa1000010"],
    ["retraction", "10.1056/nejmx22", "10.1056/nejmoa1000003"],
    ["withdrawal", "10.1056/nejmx24", "10.1056/nejmoa1000005"],
  ]);
});

test("an entry of the AI-discovery channel is dropped before any screening, whichever of the plugin's discovery rows carried it; a lab feed beside it is screened as before", options, async () => {
  await reset();
  for (const [id, name] of [["ai-discovery-arxiv-agents-memory", "arXiv agents and memory"], ["ai-discovery-gh-langchain-ai-langgraph", "langgraph releases"],
    ["ai-discovery-req-0123456789ab", "A source the platform asked for"], ["arxiv-agent-self-improvement", "The single query it replaced"], ["openai-news", "OpenAI news"]]) {
    await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
      VALUES ($1,$2,'ai','company','rss','direct',2,false,$2,'P0','US')`, [id, name]);
  }
  const clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline, editor } = pipelineWith({ now: () => clock });
  const channel = [];
  for (const source_id of ["ai-discovery-arxiv-agents-memory", "ai-discovery-gh-langchain-ai-langgraph", "ai-discovery-req-0123456789ab", "arxiv-agent-self-improvement"]) {
    channel.push(await deliver({ source_id, title: `A paper about agent memory [${source_id}]`, summary: "S".repeat(200) }));
  }
  const lab = await deliver({ source_id: "openai-news", title: "A lab post about a model", summary: "L".repeat(200) });
  const medical = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMdiscovery1", title: "A trial of something", summary: "T".repeat(200) });
  await pipeline.processBatch();
  for (const delivered of channel) {
    assert.deepEqual([(await entry(delivered.id)).state, (await entry(delivered.id)).state_reason], ["dropped", "evolution-discovery-only"]);
  }
  const screened = editor.calls.screen.flat();
  assert.equal(screened.length, 2, "only the lab post and the trial reach screening");
  assert.notEqual((await entry(lab.id)).state_reason, "evolution-discovery-only");
  assert.notEqual((await entry(medical.id)).state_reason, "evolution-discovery-only");
});

test("recently generated dailies keep old referenced items eligible for an owed edit without opening all history", options, async () => {
  await reset();
  let clock = new Date("2026-09-22T02:00:00Z");
  const { pipeline, editor, plugin } = pipelineWith({ config: { frontierOffpeak: true }, now: () => clock });
  const deliveries = [];
  for (const title of DISTINCT_TOPICS.slice(0, 4)) {
    const delivered = await deliver({ source_id: "m-stat", title: `${title} [score:60]`, summary: "S".repeat(200) });
    plugin.texts.set(delivered.pluginEntryId, { entry_id: delivered.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
    deliveries.push(delivered);
  }
  await pipeline.processBatch();
  const ids = [];
  for (const delivered of deliveries) ids.push(Number((await entry(delivered.id)).item_id));
  assert.equal(new Set(ids).size, 4);
  await database.query("UPDATE evimed_frontier.items SET timeline_at=$2,visible_at=$2 WHERE id=ANY($1::bigint[])",
    [ids, new Date("2026-09-01T00:00:00Z")]);
  clock = new Date("2026-09-22T11:00:00Z");
  // item_ids holds internal bigint IDs. Only the first daily was actually
  // generated in the current seven-day window; an old or future receipt is not eligible.
  for (const [index, generatedAt] of ["2026-09-21T23:30:00Z", "2026-09-14T23:30:00Z", "2026-09-23T23:30:00Z"].entries()) {
    await database.query(`INSERT INTO evimed_frontier.dailies
      (day,window_start,window_end,lead,sections,markdown,item_ids,model,generated_at)
      VALUES ($1,$2,$2,'{}'::jsonb,'[]'::jsonb,'Daily',$3::bigint[],'fixture',$2)`,
    [generatedAt.slice(0, 10), new Date(generatedAt), [ids[index]]]);
  }
  const editsBefore = editor.calls.edit.length;
  const result = await pipeline.processBatch();
  assert.equal(result.edited, 1);
  assert.equal(editor.calls.edit.length, editsBefore + 1);
  assert.equal((await item(ids[0])).editor_version, FRONTIER_EDITOR_VERSION);
  for (const id of ids.slice(1)) {
    const untouched = await item(id);
    assert.deepEqual([untouched.state, untouched.editor_version, untouched.attempts], ["published", null, 0]);
  }
  for (const id of ids) assert.equal((await item(id)).timeline_at.toISOString(), "2026-09-01T00:00:00.000Z");
});

test("old source dates remain eligible for owed edits when recently published here, without scanning old unreferenced history",options,async()=>{
  await reset();
  let clock=new Date("2026-09-22T02:00:00Z");
  const {pipeline,editor,plugin}=pipelineWith({config:{frontierOffpeak:true},now:()=>clock});
  const sourceDate=new Date("2026-09-01T00:00:00Z"),ids=[];
  for(const title of DISTINCT_TOPICS.slice(0,2)) {
    const delivered=await deliver({source_id:"m-stat",title:`${title} [score:60]`,summary:"S".repeat(200),published_at:sourceDate});
    plugin.texts.set(delivered.pluginEntryId,{entry_id:delivered.pluginEntryId,revision:1,status:"unavailable",enrichment:{}});
    ids.push(delivered.id);
  }
  await pipeline.processBatch();
  const items=[];for(const id of ids)items.push(await item(Number((await entry(id)).item_id)));
  for(const published of items) {
    assert.equal(published.timeline_at.toISOString(),sourceDate.toISOString());
    assert.equal(published.visible_at.toISOString(),clock.toISOString(),"visible_at records publication in this module, not the source date");
    assert.equal(published.editor_version,null);
  }
  await database.query("UPDATE evimed_frontier.items SET visible_at=$2 WHERE id=$1",[items[1].id,sourceDate]);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.dailies")).rows[0].n,0);
  const calls=editor.calls.edit.length;
  clock=new Date("2026-09-22T11:00:00Z");
  const result=await pipeline.processBatch();
  assert.equal(result.edited,1);
  assert.equal(editor.calls.edit.length,calls+1);
  assert.equal((await item(Number(items[0].id))).editor_version,FRONTIER_EDITOR_VERSION);
  const old=await item(Number(items[1].id));
  assert.deepEqual([old.state,old.editor_version,old.attempts],["published",null,0]);
  for(const published of items)assert.equal((await item(Number(published.id))).timeline_at.toISOString(),sourceDate.toISOString());
});

test("peak hours and the budget: non-urgent items are published title-only and edited later; a spent budget collects only", options, async () => {
  await reset();
  // Tuesday 10:00 in Beijing: the provider's peak.
  let clock = new Date("2026-09-22T02:00:00Z");
  const { pipeline, editor, plugin } = pipelineWith({ config: { frontierOffpeak: true }, now: () => clock });
  const media = await deliver({ source_id: "m-stat", title: "Semaglutide study in adolescents [score:60]", summary: "S".repeat(200) });
  const regulator = await deliver({ source_id: "r-ema", title: "EMA recommends approval of a new medicine [score:50]", summary: "E".repeat(200) });
  for (const id of [media, regulator]) plugin.texts.set(id.pluginEntryId, { entry_id: id.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  const peak = await pipeline.processBatch();
  assert.equal(peak.published, 2);
  assert.equal(peak.deferred, 1);
  const titleOnly = await item(Number((await entry(media.id)).item_id));
  assert.deepEqual([titleOnly.verification, titleOnly.editor_version, titleOnly.title_zh, titleOnly.selected], ["pending", null, null, false]);
  assert.equal(titleOnly.editor_diagnostics.outcome, "deferred");
  assert.equal(titleOnly.editor_diagnostics.reason, "peak");
  assert.equal(titleOnly.editor_diagnostics.attempts, 0);
  assert.equal(titleOnly.editor_diagnostics.editorVersion, null);
  assert.match(titleOnly.editor_diagnostics.inputSha256, /^[a-f0-9]{64}$/);
  const urgent = await item(Number((await entry(regulator.id)).item_id));
  assert.equal(urgent.verification, "passed", "a regulator is edited at peak");
  assert.deepEqual(editor.calls.edit, ["EMA recommends approval of a new medicine [score:50]"]);

  // 19:00: the edit owed is made, and the item may now be selected.
  clock = new Date("2026-09-22T11:00:00Z");
  const evening = await pipeline.processBatch();
  assert.equal(evening.rescored, 1);
  const done = await item(Number(titleOnly.id));
  assert.deepEqual([done.verification, done.selected, done.selected_rule], ["passed", true, "threshold"]);
  assert.equal(done.editor_diagnostics.outcome, "passed");
  assert.equal(done.editor_diagnostics.reason, null);
  assert.equal(done.editor_diagnostics.attempts, 1);
  assert.equal(done.editor_diagnostics.editorVersion, FRONTIER_EDITOR_VERSION);
  assert.deepEqual(done.editor_diagnostics.fields, { title_zh: ["passed"], summary_zh: ["passed"] });
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

/**
 * Deliver named entries whose text the plugin has none of, so each proceeds with its feed summary; the name is for reading the
 * verdicts back.
 * @param {any} plugin @param {Record<string, Record<string, any>>} entries
 */
async function deliverNamed(plugin, entries) {
  /** @type {Record<string, { id: number, pluginEntryId: string }>} */
  const named = {};
  for (const [name, values] of Object.entries(entries)) {
    named[name] = await deliver({ summary: "S".repeat(200), ...values });
    plugin.texts.set(named[name].pluginEntryId, { entry_id: named[name].pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  }
  return named;
}

/** Each named entry's item: its selection and the rule that selected it. @param {Record<string, { id: number }>} named */
async function selections(named) {
  /** @type {Record<string, [boolean, string | null]>} */
  const verdicts = {};
  for (const [name, delivered] of Object.entries(named)) {
    const row = await item(Number((await entry(delivered.id)).item_id));
    verdicts[name] = [row.selected, row.selected_rule];
  }
  return verdicts;
}

/**
 * The preprint lane's first day (2026-09-22): the lanes of the journal and the registry result have a selected item already, so the
 * lane floor leaves them alone and what is measured is the preprint lane. A preprint's total is the editor's share plus 6 (authority 2,
 * discounted), and so is a newsroom's (a press release): the line is 82, and none of them can reach it.
 * @param {Record<string, any>} [config]
 */
async function laneDay(config = {}) {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline, plugin } = pipelineWith({ now: () => clock, config: { frontierSelectThreshold: 82, ...config } });
  const named = await deliverNamed(plugin, {
    journal: { source_id: "j-nejm", doi: "10.1000/lane.journal", title: `${DISTINCT_TOPICS[0]} [score:60]` }, // 24 + 60 = 84
    trial: { source_id: "t-ctgov", title: `${DISTINCT_TOPICS[1]} [score:70]` }, // 19 + 70 = 89
    a: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[2]} [score:62]` }, // 68
    b: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[3]} [score:58]` }, // 64
    c: { source_id: "p-biorxiv", title: `${DISTINCT_TOPICS[4]} [score:52]` }, // 58: under the floor
    d: { source_id: "p-biorxiv", title: `${DISTINCT_TOPICS[5]} [score:66]` }, // 72
    e: { source_id: "c-novo", title: `${DISTINCT_TOPICS[6]} [score:60]` }, // 66, a newsroom
  });
  const summary = await pipeline.processBatch();
  return { pipeline, plugin, named, summary, clock };
}

test("F12b: the preprint lane selects the day's best two preprints and company items above the floor, by its own rule, and the daily carries them", options, async () => {
  const { pipeline, plugin, named, summary } = await laneDay();
  assert.deepEqual(await selections(named), {
    journal: [true, "threshold"], trial: [true, "threshold"],
    d: [true, "preprint-lane"], a: [true, "preprint-lane"], // the two highest totals (72, 68)
    e: [false, null], b: [false, null], // 66 and 64 clear the floor and find the places taken
    c: [false, null], // 58 is under it
  });
  assert.equal(summary.preprintLane, 2, "counted in the round's summary...");
  assert.equal(pipeline.counters.preprintLane, 2, "...and in the pipeline's counters");
  // Selected, and still what they are: a preprint with its source class and its unreviewed flag, never an upgraded one.
  const taken = (await database.query(`SELECT source_type, flags, evidence_type, verification, lane, state, score_total FROM evimed_frontier.items
    WHERE selected_rule = 'preprint-lane' ORDER BY score_total DESC`)).rows;
  assert.deepEqual(taken.map((row) => [row.source_type, row.flags.includes("preprint"), row.state, row.verification, row.score_total]),
    [["preprint", true, "published", "passed", 72], ["preprint", true, "published", "passed", 68]]);
  const lanePick = await item(Number((await entry(named.d.id)).item_id));
  assert.deepEqual(await changes(Number(lanePick.id)), ["published", "selected"]);
  assert.equal(lanePick.selected_at.toISOString(), "2026-09-22T12:00:00.000Z");

  // The daily of the next morning carries the lane's two with the other two: 精选 and the daily are one selection.
  const daily = await new FrontierDaily({ database, config: { frontierTimeZone: "Asia/Shanghai", frontierDailyTime: "07:30" } }).compose("2026-09-23");
  const issued = new Set([daily.lead?.itemId, ...daily.sections.flatMap((section) => section.itemIds)]);
  const publicIds = async (/** @type {string[]} */ names) => Promise.all(names.map(async (name) => (await item(Number((await entry(named[name].id)).item_id))).public_id));
  assert.deepEqual([...issued].sort(), (await publicIds(["journal", "trial", "a", "d"])).sort());

  // The same day, a better preprint arrives: the places are taken, and selection is sticky.
  const later = await deliverNamed(plugin, { f: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[7]} [score:68]` } }); // 74
  await pipeline.processBatch();
  assert.deepEqual(await selections(later), { f: [false, null] });
  assert.equal((await selections(named)).d[1], "preprint-lane");
});

test("F12b: a new day has its own places, and what the lane floor took of the lane's classes counts against them", options, async () => {
  const { plugin, named } = await laneDay();
  assert.equal(Object.values(await selections(named)).filter(([, rule]) => rule === "preprint-lane").length, 2);
  // 2026-09-23: nothing is selected in the evidence lane yet, so the lane floor takes its best (a preprint, 66) first; that is one of the
  // day's two places, and the lane fills the other with the next best above the floor (61), leaving 60 out.
  const { pipeline: next } = pipelineWith({ now: () => new Date("2026-09-23T12:00:00Z"), plugin, config: { frontierSelectThreshold: 82 } });
  const day = await deliverNamed(plugin, {
    g: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[8]} [score:54]` }, // 60
    i: { source_id: "p-biorxiv", title: `${DISTINCT_TOPICS[9]} [score:60]` }, // 66
    j: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[10]} [score:55]` }, // 61
  });
  const summary = await next.processBatch();
  assert.deepEqual(await selections(day), { g: [false, null], i: [true, "lane-floor"], j: [true, "preprint-lane"] });
  assert.equal(summary.preprintLane, 1);
  // Yesterday's two stand: a new day takes nothing back.
  assert.equal(Object.values(await selections(named)).filter(([, rule]) => rule === "preprint-lane").length, 2);
});

test("F12b: the floor and the number are the operator's: a floor of 70 takes the one that reaches it, 0 a day is no lane, 3 a day is three", options, async () => {
  for (const [config, expected] of /** @type {Array<[Record<string, number>, string[]]>} */ ([
    [{ frontierPreprintLaneMinScore: 70 }, ["d"]],
    [{ frontierPreprintLanePerDay: 0 }, []],
    [{ frontierPreprintLanePerDay: 3 }, ["a", "d", "e"]],
  ])) {
    const { named, pipeline } = await laneDay(config);
    const taken = Object.entries(await selections(named)).filter(([, [, rule]]) => rule === "preprint-lane").map(([name]) => name).sort();
    assert.deepEqual(taken, expected, JSON.stringify(config));
    assert.equal(pipeline.counters.preprintLane, expected.length, JSON.stringify(config));
  }
});

test("F12b: only a verified, unretracted, summarised article of an enabled source that is not correspondence is taken", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  // First with the lane off, so the items are published and none is taken...
  const off = pipelineWith({ now: () => clock, config: { frontierSelectThreshold: 82, frontierPreprintLanePerDay: 0 } });
  const named = await deliverNamed(off.plugin, {
    journal: { source_id: "j-nejm", doi: "10.1000/lane.journal", title: `${DISTINCT_TOPICS[0]} [score:60]` }, // 84: the evidence lane has its selection
    trial: { source_id: "t-ctgov", title: `${DISTINCT_TOPICS[1]} [score:70]` }, // 89: and so has the pipeline lane
    retracted: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[11]} [score:70]` }, // 76
    letter: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[12]} [score:68]` }, // 74
    hidden: { source_id: "p-biorxiv", title: `${DISTINCT_TOPICS[13]} [score:66]` }, // 72
    silent: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[14]} [score:64]` }, // 70
    waiting: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[15]} [pending] [score:62]` }, // published as it came, edit still owed
    good1: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[16]} [score:60]` }, // 66
    good2: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[17]} [score:59]` }, // 65
    good3: { source_id: "p-medrxiv", title: `${DISTINCT_TOPICS[18]} [score:58]` }, // 64
    newsroom: { source_id: "c-novo", title: `${DISTINCT_TOPICS[19]} [score:57]` }, // 63
  });
  await off.pipeline.processBatch();
  assert.deepEqual(Object.entries(await selections(named)).filter(([, [selected]]) => selected).map(([name]) => name), ["journal", "trial"], "no lane, no place");
  const row = async (/** @type {string} */ name) => Number((await entry(named[name].id)).item_id);
  await database.query("UPDATE evimed_frontier.items SET flags = array_append(flags, 'retracted') WHERE id = $1", [await row("retracted")]);
  await database.query("UPDATE evimed_frontier.item_texts SET publication_types = ARRAY['Letter', 'Comment'] WHERE item_id = $1", [await row("letter")]);
  await database.query("UPDATE evimed_frontier.sources SET enabled = false WHERE id = 'p-biorxiv'");
  await database.query("UPDATE evimed_frontier.items SET summary_zh = NULL WHERE id = $1", [await row("silent")]);
  // ...then with it on, and something published to start a round.
  const on = pipelineWith({ now: () => clock, plugin: off.plugin, config: { frontierSelectThreshold: 82 } });
  await deliverNamed(off.plugin, { starter: { source_id: "m-stat", title: `${DISTINCT_TOPICS[20]} [score:20]` } });
  await on.pipeline.processBatch();
  const verdicts = await selections(named);
  assert.deepEqual(Object.entries(verdicts).filter(([, [, rule]]) => rule === "preprint-lane").map(([name]) => name),
    ["good1", "good2"], "the best two that are eligible: 66 and 65, then the lane is full");
  assert.deepEqual(verdicts.waiting, [false, null], "a title-only item has no total to be taken by");
});

test("F12c: a published Class I recall carries class-i-recall, a safety notice the editor found to add a boxed warning carries boxed-warning, and nothing else does", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline, plugin } = pipelineWith({ now: () => clock });
  const named = await deliverNamed(plugin, {
    classOne: { source_id: "r-medwatch", title: `${DISTINCT_TOPICS[0]} [score:50]`, facts: { recall_class: "Class I" } },
    classTwo: { source_id: "r-medwatch", title: `${DISTINCT_TOPICS[1]} [score:50]`, facts: { recall_class: "Class II" } },
    boxed: { source_id: "r-medwatch", title: `${DISTINCT_TOPICS[2]} [flag:boxed-warning] [score:50]` },
    plain: { source_id: "r-medwatch", title: `${DISTINCT_TOPICS[3]} [score:50]` },
    classOneBoxed: { source_id: "r-medwatch", title: `${DISTINCT_TOPICS[4]} [flag:boxed-warning] [score:50]`, facts: { recall_class: "Class I" } },
    paper: { source_id: "j-nejm", doi: "10.1000/boxed.paper", title: `${DISTINCT_TOPICS[5]} [flag:boxed-warning] [score:50]` },
    news: { source_id: "m-stat", title: `${DISTINCT_TOPICS[6]} [flag:class-i-recall] [score:50]`, facts: { recall_class: "Class I" } },
  });
  await pipeline.processBatch();
  /** @type {Record<string, [boolean, string[]]>} */
  const marks = {};
  for (const [name, delivered] of Object.entries(named)) {
    const row = await item(Number((await entry(delivered.id)).item_id));
    marks[name] = [row.safety_alert, row.flags.filter((/** @type {string} */ flag) => ["class-i-recall", "boxed-warning"].includes(flag))];
  }
  assert.deepEqual(marks, {
    classOne: [true, ["class-i-recall"]], // the record's own class
    classTwo: [false, []], // Class II is scored like any decision, and carries nothing
    boxed: [true, ["boxed-warning"]], // the editor proposed it on a safety feed's notice
    plain: [true, []], // an alert that adds no boxed warning keeps the follow-based reach
    classOneBoxed: [true, ["class-i-recall", "boxed-warning"]],
    paper: [false, []], // a journal article that talks of boxed warnings is no alert
    news: [false, []], // a medium's story is no alert, and a recall's class is never the editor's to say
  });
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
  // Decided by pg_trgm where the database has it (CI's pgvector image does)
  // and by the normalised-title fallback where it does not (a bare local
  // server): the merge is the same either way, so the test holds on both.

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
  assert.equal(exploded.editor_diagnostics.reason, "call_failed");
  assert.equal(exploded.editor_diagnostics.attempts, null, "throwing adapter has no proven call count");
  assert.equal(exploded.editor_diagnostics.editorVersion, null);
  assert.ok(!JSON.stringify(exploded.editor_diagnostics).includes("boom"));
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

test("a spent provider balance is a wait, never an attempt: no entry or item is failed by the outage", options, async () => {
  // 2026-09-23: DeepSeek answered every call 402 for two hours; each screening
  // was a used attempt, and a third failed the entry for good.
  await reset();
  let clock = new Date("2026-09-22T12:00:00Z");
  const provider = { balanceSpent: false };
  const { pipeline, editor, plugin } = pipelineWith({ config: { frontierOffpeak: true }, now: () => clock, editor: fakeEditor(provider) });
  // One item already published title-only and owed an edit (published at peak).
  clock = new Date("2026-09-22T02:00:00Z");
  const owed = await deliver({ source_id: "m-stat", title: "Semaglutide study in adolescents [score:60]", summary: "S".repeat(200) });
  plugin.texts.set(owed.pluginEntryId, { entry_id: owed.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  await pipeline.processBatch();
  const owedItem = Number((await entry(owed.id)).item_id);
  assert.deepEqual([(await item(owedItem)).state, (await item(owedItem)).editor_version], ["published", null]);

  // The balance runs out; a new entry arrives. Five hours of batches, every minute.
  provider.balanceSpent = true;
  clock = new Date("2026-09-22T11:00:00Z");
  const fresh = await deliver({ source_id: "m-stat", title: "Heart failure trial reads out [score:60]", summary: "H".repeat(200) });
  plugin.texts.set(fresh.pluginEntryId, { entry_id: fresh.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  const refusedAt = clock;
  await pipeline.processBatch();
  const waiting = await entry(fresh.id);
  assert.deepEqual([waiting.state, waiting.state_reason, waiting.attempts], ["received", "provider-refused", 0]);
  assert.equal(new Date(waiting.hold_until).getTime(), refusedAt.getTime() + 30 * 60_000, "asked again in half an hour");
  assert.ok(pipeline.status().providerPausedUntil, "the pause is in the status");
  const screens = editor.calls.screen.length;
  const edits = editor.calls.edit.length;
  for (let minute = 1; minute < 300; minute += 1) {
    clock = new Date(refusedAt.getTime() + minute * 60_000);
    await pipeline.processBatch();
  }
  assert.ok(editor.calls.screen.length - screens <= 10, `the model is asked about twice an hour, not every minute (${editor.calls.screen.length - screens})`);
  assert.ok(editor.calls.edit.length - edits <= 10, `and the owed edit likewise (${editor.calls.edit.length - edits})`);
  const still = await entry(fresh.id);
  assert.deepEqual([still.state, still.attempts], ["received", 0], "no attempt was spent on our account's outage");
  const stillOwed = await item(owedItem);
  assert.deepEqual([stillOwed.attempts, stillOwed.editor_version, stillOwed.verification], [0, null, "pending"], "the owed edit is not given up");
  assert.ok(pipeline.status().counters.providerRefusedWaits >= 2);

  // Topped up: the next ask after the pause goes through.
  provider.balanceSpent = false;
  clock = new Date(clock.getTime() + 31 * 60_000);
  await pipeline.processBatch();
  assert.equal((await entry(fresh.id)).state, "promoted");
  assert.equal((await item(owedItem)).verification, "passed");
});

test("the day's budget counts an uncertain call at its recorded bound, not its reservation", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  const { pipeline } = pipelineWith({ now: () => clock });
  const uncertain = async (/** @type {number} */ reserved, /** @type {number | null} */ estimated, /** @type {string} */ fingerprint) => {
    await database.query(`INSERT INTO evimed_usage.model_requests (id,user_id,project_id,model,price_version,currency,request_fingerprint,status,
        reserved_cost,estimated_cost,reservation_expires_at,created_at,settled_at,error_code,purpose)
      VALUES ($1,$2,'evimed-frontier','deepseek-flash','v','CNY',$3,'uncertain',$4,$5,$6,$6,$6,'provider_response_incomplete','frontier')`,
    [randomUUID(), operator, fingerprint.repeat(64), reserved, estimated, new Date("2026-09-22T11:00:00Z")]);
  };
  // 9.5 reserved at the cache-miss ceiling; the call can have cost 0.25.
  await uncertain(9.5, 0.25, "c");
  assert.deepEqual([(await pipeline.budget(clock)).spentCny, (await pipeline.budget(clock)).state], [0.25, "ok"]);
  // With no bound recorded (an answer lost before it arrived) the reservation stands.
  await uncertain(0.5, null, "d");
  assert.equal((await pipeline.budget(clock)).spentCny, 0.75);
});

test("transient owed edits preserve attempts and existing prose across restart; schema failures still exhaust", options, async () => {
  await reset();
  let clock = new Date("2026-09-22T02:00:00Z");
  const setup = pipelineWith({config:{frontierOffpeak:true},now:()=>clock});
  const delivered = await deliver({source_id:"m-stat",title:"Kidney therapy trial [score:60]",summary:"S".repeat(200)});
  setup.plugin.texts.set(delivered.pluginEntryId,{entry_id:delivered.pluginEntryId,revision:1,status:"unavailable",enrichment:{}});
  await setup.pipeline.processBatch();
  const id = Number((await entry(delivered.id)).item_id);
  await database.query("UPDATE evimed_frontier.items SET title_zh='Existing title',summary_zh='Existing valid prose',attempts=2 WHERE id=$1",[id]);
  const edit = setup.editor.edit.bind(setup.editor);
  clock = new Date("2026-09-22T12:00:00Z");
  for (const failure of [
    {error:"frontier_model_timeout"},
    {error:"frontier_model_timeout",throws:true},
    {error:"model_gateway_upstream_error",upstreamStatus:429},
    {error:"model_gateway_upstream_error",upstreamStatus:503,verification:"title-only"},
    {error:"frontier_model_failed",networkCode:"ECONNRESET"},
    {error:"model_gateway_payment_required",verification:"title-only",waitMinutes:30},
  ]) {
    let calls=0;
    setup.editor.edit=async()=>{calls++;clock=new Date(clock.getTime()+120_000);
      if(failure.throws)throw Object.assign(new Error("private provider response"),{code:failure.error});
      return {verification:"pending",...failure};};
    const {pipeline}=pipelineWith({config:{frontierOffpeak:true},now:()=>clock,editor:setup.editor,plugin:setup.plugin});
    await pipeline.processBatch();
    const waiting=await item(id);
    assert.equal(waiting.editor_diagnostics.reason,"provider_unavailable");
    assert.equal(waiting.editor_diagnostics.checkedAt,clock.toISOString());
    assert.equal(waiting.editor_diagnostics.attempts,null,"adapter did not report its actual call count");
    assert.deepEqual([waiting.attempts,waiting.editor_version,waiting.summary_zh,waiting.lease_owner],[2,null,"Existing valid prose",null]);
    const waitMs=(failure.waitMinutes??5)*60_000;
    assert.equal(new Date(waiting.lease_until).getTime(),clock.getTime()+waitMs);
    assert.equal((await entry(delivered.id)).state_reason,failure.error);
    // A fresh process must respect the ownerless durable cooldown too.
    await pipelineWith({config:{frontierOffpeak:true},now:()=>clock,editor:setup.editor,plugin:setup.plugin}).pipeline.processBatch();
    assert.equal(calls,1);
    clock=new Date(clock.getTime()+waitMs+1);
  }
  setup.editor.edit=edit;
  await pipelineWith({config:{frontierOffpeak:true},now:()=>clock,editor:setup.editor,plugin:setup.plugin}).pipeline.processBatch();
  assert.equal((await item(id)).verification,"passed");
  assert.equal((await item(id)).attempts,0);
  // A promoted update whose content repair lost the provider keeps its old
  // valid prose too, without reporting that partial response as an edit.
  await database.query("UPDATE evimed_frontier.items SET state='screened',editor_version=NULL,attempts=2 WHERE id=$1",[id]);
  const validProse=(await item(id)).summary_zh;
  setup.editor.edit=async()=>({verification:"title-only",error:"frontier_model_timeout",output:{titleZh:"Partial repair",summaryZh:null}});
  const deferred=await pipelineWith({config:{frontierOffpeak:true},now:()=>clock,editor:setup.editor,plugin:setup.plugin}).pipeline.processBatch();
  const promotedWait=await item(id);
  assert.deepEqual([promotedWait.state,promotedWait.attempts,promotedWait.summary_zh,promotedWait.lease_owner],["screened",2,validProse,null]);
  assert.equal(deferred.edited,0);
  clock=new Date(clock.getTime()+5*60_000+1);
  setup.editor.edit=edit;
  await pipelineWith({config:{frontierOffpeak:true},now:()=>clock,editor:setup.editor,plugin:setup.plugin}).pipeline.processBatch();
  assert.equal((await item(id)).state,"published");
  // Invalid content and an explicit HTTP 400 are not provider waits.
  for (const failure of [{error:"frontier_edit_invalid"},{error:"model_gateway_upstream_error",upstreamStatus:400}]) {
    await database.query("UPDATE evimed_frontier.items SET editor_version=NULL,attempts=2 WHERE id=$1",[id]);
    setup.editor.edit=async()=>({verification:"pending",...failure});
    await pipelineWith({config:{frontierOffpeak:true},now:()=>clock,editor:setup.editor,plugin:setup.plugin}).pipeline.processBatch();
    const exhausted=await item(id);
    assert.equal(exhausted.attempts,3);
    assert.equal(exhausted.editor_version,FRONTIER_EDITOR_VERSION);
    assert.equal(exhausted.lease_until,null);
    assert.equal(exhausted.editor_diagnostics.outcome,"title-only");
    assert.equal(exhausted.editor_diagnostics.reason,"retry_exhausted");
  }
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
    // Thirty titles no near-duplicate rule could join: with pg_trgm, "Story
    // number 1 …" and "Story number 12 …" are ≥ 0.85 alike and merge.
    const id = await deliver({ source_id: index % 2 ? "m-stat" : "m-fierce", title: `${DISTINCT_TOPICS[index]} [score:40]`, summary: "X".repeat(200) });
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

test("ordinary daytime articles are edited by default and preserve their original source snapshot", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T02:00:00Z");
  const { pipeline, plugin, editor } = pipelineWith({ now: () => clock });
  const rawSummary = "Preserved source summary for the daytime editorial regression. ".repeat(4);
  const delivered = await deliver({ source_id: "m-stat", title: "Clinical trial reports a measured outcome [score:60]", summary: rawSummary });
  plugin.texts.set(delivered.pluginEntryId, { entry_id: delivered.pluginEntryId, revision: 1, status: "pending", next_attempt_at: clock.toISOString() });
  await pipeline.processBatch();
  const stored = await entry(delivered.id);
  const published = await item(Number(stored.item_id));
  assert.equal(published.state, "published");
  assert.equal(published.verification, "passed");
  assert.ok(published.title_zh && published.summary_zh);
  assert.equal(editor.calls.edit.length, 1);
  const snapshot = (await database.query("SELECT model_input, abstract_raw FROM evimed_frontier.item_texts WHERE item_id=$1", [published.id])).rows[0];
  assert.ok(snapshot.model_input.includes(rawSummary.trim()));
  assert.equal(snapshot.abstract_raw, null, "the feed summary is not relabeled as a fetched abstract");
  assert.equal(stored.state, "held", "the original text request still completes later");
});


test("a source revision invalidates previous field diagnoses before a later successful edit", options, async () => {
  await reset();
  let clock = new Date("2026-09-22T12:00:00Z");
  const setup = pipelineWith({ now: () => clock });
  const first = await deliver({ source_id: "m-stat", doi: "10.1000/diagnostics", title: "Original kidney trial", summary: "S".repeat(200) });
  setup.plugin.texts.set(first.pluginEntryId, { entry_id: first.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  await setup.pipeline.processBatch();
  const id = Number((await entry(first.id)).item_id);
  const initial = await item(id);
  assert.equal(initial.editor_diagnostics.outcome,"passed");
  clock = new Date(clock.getTime() + HOUR);
  setup.editor.available = false;
  await deliver({ source_id: "m-stat", plugin_entry_id: first.pluginEntryId, revision: 2, doi: "10.1000/diagnostics",
    title: "Corrected kidney trial", summary: "S".repeat(200) });
  setup.plugin.texts.set(first.pluginEntryId, { entry_id: first.pluginEntryId, revision: 2, status: "unavailable", enrichment: {} });
  await setup.pipeline.processBatch();
  assert.deepEqual((await item(id)).editor_diagnostics,{},"old hash and field failures cannot describe revised input");
  setup.editor.available = true;
  await setup.pipeline.processBatch();
  const final = await item(id);
  assert.equal(final.editor_diagnostics.outcome,"passed");
  assert.notEqual(final.editor_diagnostics.inputSha256,initial.editor_diagnostics.inputSha256);
  assert.equal(final.published_at?.toISOString(),initial.published_at?.toISOString());
});


/** A paused adapter lets another transaction change the source/claim before settlement. */
function pausedEdit(editor, outcome = "passed") {
  const original = editor.edit.bind(editor);
  let begin, finish;
  const started = new Promise((resolve) => { begin = resolve; });
  const released = new Promise((resolve) => { finish = resolve; });
  editor.edit = async (input) => {
    const result = await original(input);
    begin();
    await released;
    if (outcome === "throw") throw Object.assign(new Error("private provider failure"), { code: "frontier_model_timeout" });
    if (outcome === "pending") return { ...result, verification: "pending", output: null, error: "frontier_model_timeout" };
    return result;
  };
  return { started, release: () => finish() };
}

test("a source revision arriving during an edit cannot restore stale prose, input or diagnostics", options, async () => {
  await reset();
  const clock = new Date("2026-09-22T12:00:00Z");
  const first = pipelineWith({ now: () => clock });
  const delivered = await deliver({ source_id: "m-stat", doi: "10.1000/edit-race", title: "Original kidney source", summary: "S".repeat(200) });
  first.plugin.texts.set(delivered.pluginEntryId, { entry_id: delivered.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
  await first.pipeline.processBatch();
  const id = Number((await entry(delivered.id)).item_id);
  await database.query("UPDATE evimed_frontier.items SET editor_version=NULL WHERE id=$1", [id]);
  const paused = pausedEdit(first.editor);
  const running = first.pipeline.processBatch();
  await paused.started;
  const second = pipelineWith({ now: () => clock, plugin: first.plugin });
  second.editor.available = false;
  await deliver({ source_id: "m-stat", doi: "10.1000/edit-race", plugin_entry_id: delivered.pluginEntryId, revision: 2,
    title: "Corrected kidney source", summary: "New source text ".repeat(20) });
  first.plugin.texts.set(delivered.pluginEntryId, { entry_id: delivered.pluginEntryId, revision: 2, status: "available", abstract: "Corrected source abstract", enrichment: {} });
  await second.pipeline.processBatch();
  const fresh = await item(id);
  const freshText = (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id=$1", [id])).rows[0];
  paused.release();
  await running;
  const settled = await item(id);
  const settledText = (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id=$1", [id])).rows[0];
  assert.equal(settled.title_raw, fresh.title_raw);
  assert.equal(settled.title_zh, fresh.title_zh);
  assert.equal(settled.summary_zh, fresh.summary_zh);
  assert.deepEqual(settled.editor_diagnostics, fresh.editor_diagnostics);
  assert.equal(settledText.model_input_sha256, freshText.model_input_sha256);
  assert.equal(settled.lease_owner, null, "only the obsolete owned claim is released for a fresh edit");
});

test("expired and replaced claims fence every old editor completion, including same-worker ABA", options, async () => {
  for (const mode of ["expired", "reassigned", "same-worker"]) for (const outcome of ["passed", "pending", "throw"]) {
    await reset();
    let clock = new Date("2026-09-22T12:00:00Z");
    const setup = pipelineWith({ now: () => clock });
    const delivered = await deliver({ source_id: "m-stat", title: `Kidney claim ${mode} ${outcome}`, summary: "S".repeat(200) });
    setup.plugin.texts.set(delivered.pluginEntryId, { entry_id: delivered.pluginEntryId, revision: 1, status: "unavailable", enrichment: {} });
    await setup.pipeline.processBatch();
    const id = Number((await entry(delivered.id)).item_id);
    await database.query("UPDATE evimed_frontier.items SET editor_version=NULL,attempts=2 WHERE id=$1", [id]);
    const paused = pausedEdit(setup.editor, outcome);
    const running = setup.pipeline.processBatch();
    await paused.started;
    const claimed = await item(id);
    clock = new Date(claimed.lease_until.getTime() + 1_000);
    if (mode !== "expired") await database.query("UPDATE evimed_frontier.items SET lease_owner=$2,lease_until=$3 WHERE id=$1",
      [id, mode === "same-worker" ? claimed.lease_owner : "replacement-worker", new Date(clock.getTime() + HOUR)]);
    const fresh = await item(id);
    const freshText = (await database.query("SELECT model_input_sha256 FROM evimed_frontier.item_texts WHERE item_id=$1", [id])).rows[0];
    paused.release();
    await running;
    const settled = await item(id);
    assert.deepEqual([settled.title_zh,settled.summary_zh,settled.editor_diagnostics,settled.attempts,settled.lease_owner,settled.lease_until],
      [fresh.title_zh,fresh.summary_zh,fresh.editor_diagnostics,fresh.attempts,fresh.lease_owner,fresh.lease_until], `${mode}/${outcome}`);
    assert.equal((await database.query("SELECT model_input_sha256 FROM evimed_frontier.item_texts WHERE item_id=$1", [id])).rows[0].model_input_sha256,freshText.model_input_sha256);
  }
});


test("corrected existing abstract, body and trial facts invalidate diagnostics without unbounded re-edits", options, async () => {
  await reset();
  let clock = new Date("2026-09-22T12:00:00Z");
  const setup = pipelineWith({ now: () => clock });
  const delivered = await deliver({ source_id: "m-stat", doi: "10.1000/existing-input", title: "Kidney source correction", summary: "S".repeat(200) });
  setup.plugin.texts.set(delivered.pluginEntryId, { entry_id: delivered.pluginEntryId, revision: 1, status: "available",
    abstract: "Existing abstract one", body_excerpt: "Existing body one", enrichment: {trial_facts:{enrollment:100}} });
  await setup.pipeline.processBatch();
  const id = Number((await entry(delivered.id)).item_id);
  for (const revision of [2,3]) {
    clock = new Date(clock.getTime() + HOUR);
    setup.editor.available = false;
    await deliver({ source_id: "m-stat", doi: "10.1000/existing-input", plugin_entry_id: delivered.pluginEntryId, revision,
      title: "Kidney source correction", summary: "S".repeat(200) });
    setup.plugin.texts.set(delivered.pluginEntryId, { entry_id: delivered.pluginEntryId, revision, status: "available",
      abstract: "Corrected abstract two", body_excerpt: `Corrected body ${revision}`,
      enrichment: {trial_facts:{enrollment:100*revision}} });
    const calls = setup.editor.calls.edit.length;
    await setup.pipeline.processBatch();
    const fresh = await item(id);
    assert.deepEqual(fresh.editor_diagnostics,{},`revision ${revision} invalidates old input diagnostics`);
    assert.equal(setup.editor.calls.edit.length,calls,"intake does not add an editing call");
    setup.editor.available = true;
    await setup.pipeline.processBatch();
    assert.equal(setup.editor.calls.edit.length,calls + Number(revision === 2),"only the existing one-rescore allowance is used");
  }
});


test("a same-revision late abstract arriving during an edit fences its old source snapshot", options, async () => {
  await reset();
  let clock = new Date("2026-09-22T12:00:00Z");
  const first = pipelineWith({ now: () => clock });
  const delivered = await deliver({ source_id: "j-nejm", title: "Kidney paper awaiting abstract", summary: "Short.", defects: ["short-summary"] });
  await first.pipeline.processBatch();
  const storedEntry = await entry(delivered.id);
  assert.equal(storedEntry.state,"held");
  const id = Number(storedEntry.item_id);
  clock = new Date(clock.getTime() + 24 * HOUR);
  await database.query("UPDATE evimed_frontier.items SET editor_version=NULL WHERE id=$1",[id]);
  const paused = pausedEdit(first.editor);
  const running = first.pipeline.processBatch();
  await paused.started;
  first.plugin.texts.set(delivered.pluginEntryId,{ entry_id:delivered.pluginEntryId,revision:1,status:"available",
    abstract:"Newly available original abstract",body_excerpt:"Newly available original body",enrichment:{} });
  // The plugin now has the text; make this test's pending poll explicitly due without advancing the item's active claim.
  await database.query("UPDATE evimed_frontier.entries SET state='held',hold_until=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1",
    [delivered.id,new Date(clock.getTime()-1_000)]);
  const second = pipelineWith({ now: () => clock, plugin:first.plugin });
  second.editor.available=false;
  await second.pipeline.processBatch();
  const fresh = await item(id);
  const text = (await database.query("SELECT model_input_sha256,abstract_raw FROM evimed_frontier.item_texts WHERE item_id=$1",[id])).rows[0];
  assert.equal(text.abstract_raw,"Newly available original abstract");
  paused.release();
  await running;
  const settled=await item(id);
  assert.deepEqual(settled.editor_diagnostics,fresh.editor_diagnostics);
  assert.equal(settled.summary_zh,fresh.summary_zh);
  assert.equal((await database.query("SELECT model_input_sha256 FROM evimed_frontier.item_texts WHERE item_id=$1",[id])).rows[0].model_input_sha256,text.model_input_sha256);
  assert.equal(settled.lease_owner,null);
});

// fr-social 2026-10-22: contract 1.5.0 — a post through the same screen → item → text path, nothing social-only.
test("a social post is screened with its author, counts and quote, and its item carries what the post carries and its full text", options, async () => {
  await reset();
  await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
    VALUES ('x-us_fda', 'U.S. FDA（X @US_FDA）', 'mixed', 'regulator', 'socialdata', 'api', 5, false, 'FDA', 'P1', 'US')`);
  const clock = new Date("2026-10-22T12:00:00Z");
  const editor = fakeEditor();
  /** @type {any[]} */
  const screened = [];
  const screen = editor.screen.bind(editor);
  editor.screen = async (/** @type {any[]} */ batch) => { screened.push(...batch); return screen(batch); };
  const { pipeline, plugin } = pipelineWith({ now: () => clock, editor });
  const photo = { id: "b".repeat(64), kind: "image", width: 800, height: 600, alt: "Approval letter", original_url: "https://pbs.twimg.com/media/a.jpg" };
  const post = await deliver({ source_id: "x-us_fda", url: "https://x.com/US_FDA/status/1849", title: "FDA approves the first oral GLP-1 for obesity",
    summary: "FDA approves the first oral GLP-1 for obesity in adults.", published_at: new Date("2026-10-22T10:00:00Z") });
  const social = { channel: "x", platform: "x", author: { name: "U.S. FDA", handle: "US_FDA", url: "https://x.com/US_FDA", role: "organisation" },
    media: [photo], quoted: { author: { name: "FDA Drug Info", handle: "FDA_Drug_Info" }, text: "Label and REMS details.", url: "https://x.com/FDA_Drug_Info/status/1" },
    metrics: { likes: 12345, reposts: 300, replies: 20, views: null, observed_at: "2026-10-22T11:00:00.000Z" } };
  await database.query("UPDATE evimed_frontier.entries SET channel=$2, platform=$3, author=$4::jsonb, media=$5::jsonb, quoted=$6::jsonb, metrics=$7::jsonb WHERE id=$1",
    [post.id, social.channel, social.platform, JSON.stringify(social.author), JSON.stringify(social.media), JSON.stringify(social.quoted), JSON.stringify(social.metrics)]);
  const body = "FDA approves the first oral GLP-1 for obesity in adults.\n\nThe approval follows two phase 3 trials.";
  plugin.texts.set(post.pluginEntryId, { entry_id: post.pluginEntryId, revision: 1, status: "available", text_kind: "full", abstract: null,
    body_excerpt: body, body_text: body, fetched_from: "x", enrichment: {} });
  await pipeline.processBatch();
  const input = screened.find((row) => row.key === String(post.id));
  assert.equal(input.sourceName, "U.S. FDA（X @US_FDA）｜X｜U.S. FDA @US_FDA（机构账号）", "the screen knows an organisation's account wrote it");
  assert.match(input.excerpt, /^【互动】赞 1\.2万 · 转发 300 · 回复 20 FDA approves/);
  assert.match(input.excerpt, /【引用 @FDA_Drug_Info】Label and REMS details\.$/);
  assert.ok(input.excerpt.length <= 300);
  const made = await item(Number((await entry(post.id)).item_id));
  assert.equal(made.channel, "x");
  assert.equal(made.platform, "x");
  assert.deepEqual(made.author, social.author);
  assert.deepEqual(made.media, [photo]);
  assert.equal(made.quoted.author.handle, "FDA_Drug_Info");
  assert.equal(made.metrics.likes, 12345);
  const texts = (await database.query("SELECT body_text, body_complete, body_excerpt FROM evimed_frontier.item_texts WHERE item_id=$1", [made.id])).rows[0];
  assert.equal(texts.body_text, body);
  assert.equal(texts.body_complete, true, "the plugin delivered the post whole");
  const journal = await deliver({ source_id: "j-nejm", doi: "10.1056/NEJMoa9999999", title: "A journal article [score:10]", summary: "An abstract of a trial." });
  plugin.texts.set(journal.pluginEntryId, { entry_id: journal.pluginEntryId, revision: 1, status: "available", text_kind: "abstract",
    abstract: "A".repeat(300), body_excerpt: null, enrichment: {} });
  await pipeline.processBatch();
  const plain = screened.find((row) => row.key === String(journal.id));
  assert.deepEqual([plain.sourceName, plain.excerpt], ["NEJM", "An abstract of a trial."], "an entry that is not a post is screened exactly as before");
  const journalItem = await item(Number((await entry(journal.id)).item_id));
  assert.deepEqual([journalItem.channel, journalItem.author, journalItem.media], [null, null, []]);
  assert.equal((await database.query("SELECT body_complete FROM evimed_frontier.item_texts WHERE item_id=$1", [journalItem.id])).rows[0].body_complete, null);
});
