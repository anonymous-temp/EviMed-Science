// A record with no text is read and written up, and an item that never gets a text stops being held (c2-gaps G2, G11, 2026-10-25),
// against a real PostgreSQL: a registry record, an openFDA row and a safety notice published on their own words get a reader summary
// from their entry, their 导读 and 要点 are written from it with the number check, nothing is translated; an item unreadable for
// FRONTIER_TEXT_GIVE_UP_MS leaves the claim queue, is taken back when a text arrives, and stops costing a claim every twelve hours.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FrontierEvents } from "../src/frontierEvents.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FRONTIER_TEXT_GIVE_UP_MS, FRONTIER_TEXT_HOLD_MS, FrontierPipeline } from "../src/frontierPipeline.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const DAY = 86_400_000;
const NOW = new Date("2026-10-25T04:00:00Z");
const operator = `frontier_op_${randomUUID().slice(0, 8)}`;
const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const owner = { userId: operator, projectId: "evimed-frontier" };
/** @type {any} */
let database;
let seq = 0;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateUsageLedger(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development'),($2,'Operator','development')", [reader.id, operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[reader.id, operator]]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.events");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await insertSource(database, "openfda", { name: "openFDA Drugs@FDA 审批数据库 API", lane: "regulatory", source_type: "regulator", access: "json-api", egress: "api", authority: 5, owner_entity: "U.S. Food and Drug Administration" });
  await insertSource(database, "prepare", { name: "国际实践指南注册与透明化平台 PREPARE", lane: "guideline", source_type: "evidence-body", access: "json-api", egress: "api", authority: 4, owner_entity: "PREPARE" });
  await insertSource(database, "medwatch", { name: "FDA MedWatch 安全警示", lane: "safety", source_type: "regulator", access: "rss", egress: "direct", authority: 5, safety_feed: true, owner_entity: "FDA" });
  await insertSource(database, "nejm", { access: "crossref-issn" });
});

// The record shapes the plugin delivers (knowledge_plugin/adapters/json_api.py), as the entries table holds them.
const DRUGSFDA = {
  sourceId: "openfda", title: "FDA approval: ZILBRYSQ — NDA216834 SUPPL-15 (Efficacy)", identity: "fda:NDA216834:SUPPL-15",
  summary: "Sponsor: UCB INC. Products: ZILBRYSQ INJECTABLE SUBCUTANEOUS ZILUCOPLAN SODIUM EQ 16.6MG BASE/0.416ML. Review priority: STANDARD. "
    + "Documents: Letter: https://www.accessdata.fda.gov/drugsatfda_docs/appletter/2026/216834Orig1s015ltr.pdf; Label: https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/216834s015lbl.pdf.",
  facts: { fda_application: "NDA216834", fda_supplement: "SUPPL-15", sponsor: "UCB INC" },
};
const PREPARE = {
  sourceId: "prepare", title: "毛发移植团队序贯培养模式中国专家共识", identity: "reg:prepare-836e3bb7:registered:2026-10-22", registryIds: ["PREPARE-2025CN1821"],
  summary: "中华医学会医学美学与美容学分会毛发医学学组。规范毛发移植团队的序贯培养路径，明确各阶段培训内容与考核要求。Type: guideline; stage: published; version: original; registration number PREPARE-2025CN1821.",
  facts: { sponsor: "中华医学会医学美学与美容学分会毛发医学学组" },
};

/**
 * A published item with the entry it came from, no full text, abstract or excerpt: the way a record published on its own words stands.
 * @param {typeof DRUGSFDA} record @param {Record<string, any>} [overrides]
 */
async function publishedRecord(record, overrides = {}) {
  const item = await insertItem(database, { sourceId: record.sourceId, title: record.title, titleZh: null, summaryZh: "卡片摘要。", visibleAt: "2026-10-24T02:00:00Z",
    timelineAt: "2026-10-24T02:00:00Z", sourceType: record.sourceId === "openfda" ? "regulator" : "evidence-body", ...overrides });
  await database.query(`UPDATE evimed_frontier.items SET editor_version = $2, genre = $3, genre_basis = 'code' WHERE id = $1`,
    [item.id, FRONTIER_EDITOR_VERSION, record.sourceId === "openfda" ? "approval" : "guideline"]);
  await database.query("UPDATE evimed_frontier.item_texts SET publication_types = '{}' WHERE item_id = $1", [item.id]);
  seq += 1;
  const entry = await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url,
      title_raw, summary_raw, facts, registry_ids, first_seen_at, received_at, content_sha256, state, item_id, defects)
    VALUES ($1,$2,1,$3,$4,$5,$5,$6,$7,$8::jsonb,$9,$10,$10,$11,'promoted',$12,$13) RETURNING id`,
  [`${record.sourceId}:${seq}`, 800_000 + seq, record.sourceId, record.identity, `https://example.org/${record.sourceId}/${seq}`, record.title, record.summary,
    JSON.stringify(record.facts), record.registryIds ?? [], new Date(NOW.getTime() - 2 * 3_600_000), createHash("sha256").update(`${seq}`).digest("hex"), item.id, ["link-derived"]]);
  return { ...item, entryId: String(entry.rows[0].id) };
}

/**
 * An editor that answers the 导读 call through `writeJson` (its own verify), the 要点 and the verdict through `callJson`, and records
 * what each was shown; a translation is a failure of the test.
 * @param {{ lead?: (input: string) => any, brief?: (input: string) => any }} behaviour
 */
function editorWith(behaviour = {}) {
  return {
    owner, available: true, timeZone: "Asia/Shanghai", model: "deepseek-flash",
    leadInputs: /** @type {string[]} */ ([]), briefInputs: /** @type {string[]} */ ([]), translations: 0, tidyCalls: 0,
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ input, /** @type {number} */ _max, /** @type {any} */ opts) {
      if (!instructions.includes("「AI 导读」")) return { verification: "passed", output: { insight_zh: null }, error: null };
      this.leadInputs.push(input);
      const checked = opts.verify(behaviour.lead ? behaviour.lead(input) : { lead_zh: "" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson(/** @type {any[]} */ messages) {
      const instructions = String(messages[0].content);
      if (instructions.includes("「要点」")) {
        this.briefInputs.push(String(messages[1].content));
        return behaviour.brief ? behaviour.brief(String(messages[1].content)) : { points: {} };
      }
      this.tidyCalls += 1;
      return { drop: [] };
    },
    async screen() { return { verdicts: new Map(), errors: new Map(), calls: 0 }; },
    async edit(/** @type {any} */ item) {
      const modelInput = buildModelInput(item);
      return { verification: "passed", modelInput, modelInputSha256: sha256(modelInput), attempts: 1, issues: [], numbers: null, error: null, model: "deepseek-flash",
        editorVersion: FRONTIER_EDITOR_VERSION, fieldDiagnostics: { title_zh: ["passed"], summary_zh: ["passed"] },
        output: { genre: null, titleZh: `中文：${item.titleRaw.slice(0, 20)}`, summaryZh: "导读：有摘要。", reasonZh: "值得一看。", lane: item.allowedLanes[0], specialties: [],
          evidenceType: item.evidenceFixed?.type ?? "observational", entities: { drugs: [], trials: [], orgs: [], diseases: [] },
          scores: { impact: 20, novelty: 10, relevance: 10 }, flags: [] } };
    },
    async translateBody() { this.translations += 1; return { paragraphs: [], complete: false, calls: 1, error: null }; },
  };
}

/** @param {any} editor @param {{ now?: Date, plugin?: any }} [input] */
function pipelineFor(editor, { now = NOW, plugin = { text: async () => ({ status: "pending" }) } } = {}) {
  return new FrontierPipeline({ database, editor, plugin, embedder: null, now: () => now, workerId: `test-${randomUUID()}`, glossary: new FrontierGlossary([]),
    config: { kbEmbeddingDimension: 1024, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, frontierSelectThreshold: 80 } });
}

const textsOf = async (/** @type {string} */ id) => (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [id])).rows[0];
const itemOf = async (/** @type {string} */ id) => (await database.query("SELECT * FROM evimed_frontier.items WHERE id = $1", [id])).rows[0];

test("G2: a published record with no text gets its entry's summary as reader text, and its 导读 is written from it with the number check", options, async () => {
  const zilbrysq = await publishedRecord(DRUGSFDA);
  const guideline = await publishedRecord(PREPARE, { selected: true });
  const editor = editorWith({
    // The openFDA record's 导读 states the application number (the source's) and is kept; the guideline's adds a number no text holds and is refused.
    lead: (input) => (input.includes("ZILBRYSQ")
      ? { lead_zh: "美国食品药品监督管理局批准UCB公司ZILBRYSQ的补充申请NDA216834 SUPPL-15，审评优先级为标准。" }
      : { lead_zh: "该共识规范毛发移植团队的序贯培养路径，覆盖 7 个培养阶段，明确各阶段培训内容与考核要求。" }),
    brief: () => ({ points: { subject: "毛发移植团队的序贯培养路径。" } }),
  });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();

  const record = await textsOf(zilbrysq.id);
  assert.match(record.reader_summary, /^Sponsor: UCB INC\. Products: ZILBRYSQ INJECTABLE/);
  assert.doesNotMatch(record.reader_summary, /https?:|Documents:/);
  assert.match(record.reader_summary, /\n\nFDA application: NDA216834\. Supplement: SUPPL-15\.$/);
  assert.equal(record.abstract_raw, null, "the entry's own columns are not touched");
  assert.equal(record.body_excerpt, null);
  assert.equal(record.reader_tidy.source, "summary");
  assert.equal(record.reader_tidy.sha, sha256(record.reader_summary));
  assert.equal(record.reader_tidy.model, undefined, "a summary is settled by code, never judged by the model");

  // The 导读 was asked from the summary, named as one, and written under the number check.
  assert.equal(editor.leadInputs.length, 2);
  assert.match(editor.leadInputs.find((input) => input.includes("ZILBRYSQ")) ?? "", /\n正文（来源摘要）：\nSponsor: UCB INC\./);
  const written = await itemOf(zilbrysq.id);
  assert.equal(written.lead_zh, "美国食品药品监督管理局批准UCB公司ZILBRYSQ的补充申请NDA216834 SUPPL-15，审评优先级为标准。");
  assert.equal(written.lead_basis, record.reader_tidy.sha);
  const refused = await itemOf(guideline.id);
  assert.equal(refused.lead_zh, null, "a number the source does not hold is refused, and the card's summary stays the lead");
  assert.equal((await textsOf(guideline.id)).reader_tidy.sha, refused.lead_basis, "asked once for this text, not again");

  // The 要点 of a selected record are written from it too, and the summary is never sent to translation.
  assert.equal(editor.briefInputs.length, 1);
  assert.match(editor.briefInputs[0], /正文（来源摘要）：\n中华医学会/);
  assert.equal(editor.translations, 0);
  assert.equal(editor.tidyCalls, 0, "a summary is not judged by the model");
  assert.equal(pipeline.counters.readerSummaries, 2);

  // Nothing moved: the next round asks for nothing.
  await pipelineFor(editor).processBatch();
  assert.equal(editor.leadInputs.length, 2);
  assert.equal(editor.briefInputs.length, 1);

  // The reader's page: the 导读 where one was written, the card's summary where it was refused.
  const service = new FrontierService({ database, vocabulary: frontierVocabularyView(TEST_VOCABULARY), now: () => NOW, config: { frontierEnabled: true, frontierAudience: "all",
    operatorUsers: [], frontierPreviewUsers: [], frontierDailyBudgetCny: 300, frontierTimeZone: "Asia/Shanghai", frontierSelectThreshold: 80 } });
  const page = (await service.getItem(reader, zilbrysq.publicId)).body.item;
  assert.equal(page.lead, written.lead_zh);
  assert.equal(page.body.original, null, "the summary is not the article: it is not served as its text");
  assert.equal((await service.getItem(reader, guideline.publicId)).body.item.lead, "卡片摘要。");
});

test("G2: a summary changed by a new revision makes a new text, and the 导读 is written again", options, async () => {
  const record = await publishedRecord(DRUGSFDA);
  const editor = editorWith({ lead: () => ({ lead_zh: "美国食品药品监督管理局批准UCB公司ZILBRYSQ的补充申请，审评优先级为标准。" }) });
  await pipelineFor(editor).processBatch();
  const first = await textsOf(record.id);
  assert.equal((await itemOf(record.id)).lead_basis, first.reader_tidy.sha);
  // The plugin delivers revision 2: the same record with another summary. The upsert keeps one reader text, the new one, and the old verdict goes.
  seq += 1;
  const next = "Sponsor: UCB INC. Products: ZILBRYSQ INJECTABLE SUBCUTANEOUS ZILUCOPLAN SODIUM EQ 16.6MG BASE/0.416ML. Review priority: PRIORITY.";
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url, title_raw, summary_raw, facts,
      first_seen_at, content_sha256, state, defects)
    SELECT plugin_entry_id, $2, 2, source_id, identity_key, url, canonical_url, title_raw, $3, facts, first_seen_at, $4, 'received', defects
    FROM evimed_frontier.entries WHERE id = $1`, [record.entryId, 900_000 + seq, next, createHash("sha256").update(next).digest("hex")]);
  const plugin = { text: async () => ({ status: "unavailable" }) };
  await pipelineFor(editor, { now: new Date(NOW.getTime() + 3_600_000), plugin }).processBatch();
  const second = await textsOf(record.id);
  assert.match(second.reader_summary, /Review priority: PRIORITY\./);
  assert.notEqual(second.reader_tidy?.sha ?? null, first.reader_tidy.sha, "the old verdict was for the old text");
  await pipelineFor(editor, { now: new Date(NOW.getTime() + 2 * 3_600_000), plugin }).processBatch();
  assert.equal(editor.leadInputs.length, 2, "asked again for the new text");
  assert.equal((await itemOf(record.id)).lead_basis, (await textsOf(record.id)).reader_tidy.sha);
});

test("G2: a record whose entry says too little is looked at once and left as it was; an item with a text of its own is never given a summary", options, async () => {
  const bare = await publishedRecord({ ...DRUGSFDA, summary: "Sponsor: X.", facts: {} });
  const paper = await insertItem(database, { title: "A trial with its abstract", abstract: "Background: a trial. Results: events fell by 20%.", visibleAt: "2026-10-24T02:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET editor_version = $2 WHERE id = $1", [paper.id, FRONTIER_EDITOR_VERSION]);
  seq += 1;
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url, title_raw, summary_raw, first_seen_at, content_sha256, state, item_id)
    VALUES ($1,$2,'nejm',$3,'https://example.org/p','https://example.org/p','A trial with its abstract', $4, now(), $5, 'promoted', $6)`,
  [`nejm:${seq}`, 810_000 + seq, `doi:10.1000/${seq}`, "A feed summary long enough to be usable on its own, with 120 patients and a result that fell by 20%.", createHash("sha256").update(`${seq}`).digest("hex"), paper.id]);
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  await pipelineFor(editor).processBatch();
  assert.equal((await textsOf(bare.id)).reader_summary, "", "looked at, nothing to read");
  assert.equal((await textsOf(bare.id)).reader_tidy, null, "no text, no verdict, no 导读 asked");
  assert.equal((await textsOf(paper.id)).reader_summary, null, "an abstract is the text: no fourth one beside it");
  assert.equal((await textsOf(paper.id)).reader_tidy.source, "abstract");
  assert.equal(editor.leadInputs.length, 1, "only the paper's");
});

test("G11: an item with nothing to read leaves the claim queue once its entry has waited FRONTIER_TEXT_GIVE_UP_MS, and stops being claimed", options, async () => {
  // A journal below the top tier: fourteen days (a top journal's papers are waited for twenty-one, c3-primary).
  await insertSource(database, "minor-journal", { name: "Minor Journal", authority: 3, access: "crossref-issn" });
  /** @param {string} title @param {number} waitedMs */
  async function waiting(title, waitedMs) {
    const received = new Date(NOW.getTime() - waitedMs);
    const inserted = await database.query(`INSERT INTO evimed_frontier.items (public_id, primary_source_id, canonical_url, identity_key, title_raw, lang, lane, source_type,
        first_seen_at, timeline_at, state, verification, evidence_type)
      VALUES ($1,'minor-journal',$2,$3,$4,'en','evidence','journal',$5,$5,'scored','passed','rct') RETURNING id`,
    [`t${randomUUID().replace(/-/g, "").slice(0, 15)}`, `https://example.org/${title}`, `url:${sha256(title)}`, title, received]);
    const id = String(inserted.rows[0].id);
    await database.query("INSERT INTO evimed_frontier.item_texts (item_id, model_input, model_input_sha256) VALUES ($1, $2, $3)", [id, title, sha256(title)]);
    seq += 1;
    await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url, title_raw, first_seen_at, received_at, content_sha256, state, item_id)
      VALUES ($1,$2,'minor-journal',$3,$4,$4,$5,$6,$6,$7,'held',$8)`,
    [`nejm:${seq}`, 820_000 + seq, `url:${sha256(title)}`, `https://example.org/${title}`, title, received, sha256(`${seq}`), id]);
    return id;
  }
  const young = await waiting("young", 3 * DAY);
  const old = await waiting("old", FRONTIER_TEXT_GIVE_UP_MS + DAY);
  const editor = editorWith();
  const pipeline = pipelineFor(editor);
  const batch = await pipeline.processBatch();
  assert.equal(batch.failed, 1);
  const gone = await itemOf(old);
  assert.deepEqual([gone.state, gone.lease_owner, gone.lease_until, gone.editor_diagnostics], ["failed", null, null, { giveUp: "no-text" }]);
  assert.equal((await database.query("SELECT state_reason FROM evimed_frontier.entries WHERE item_id = $1", [old])).rows[0].state_reason, "no-text-gave-up");
  const kept = await itemOf(young);
  assert.equal(kept.state, "scored", "an item that has waited three days still waits");
  assert.equal(new Date(kept.lease_until).getTime(), NOW.getTime() + FRONTIER_TEXT_HOLD_MS, "held for twelve hours, as before");
  assert.equal(pipeline.counters.textGaveUp, 1);

  // Twelve hours on the young one is claimed again, the old one is not: nothing is claimed for it, ever.
  const claimedBefore = pipeline.counters.claimedItems;
  const later = pipelineFor(editor, { now: new Date(NOW.getTime() + FRONTIER_TEXT_HOLD_MS + 60_000) });
  await later.processBatch();
  assert.equal(later.counters.claimedItems, 1, "one claim, the young item's");
  assert.equal((await itemOf(old)).state, "failed");
  assert.ok(claimedBefore >= 2);

  // A text that arrives later takes the item back: its entry's new revision with an abstract.
  seq += 1;
  const row = (await database.query("SELECT * FROM evimed_frontier.entries WHERE item_id = $1", [old])).rows[0];
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url, title_raw, first_seen_at, content_sha256, state)
    VALUES ($1,$2,2,$3,$4,$5,$5,$6,$7,$8,'received')`, [row.plugin_entry_id, 830_000 + seq, row.source_id, row.identity_key, row.url, row.title_raw, row.first_seen_at, sha256(`rev${seq}`)]);
  const plugin = { text: async () => ({ status: "available", abstract: "Background: a trial. Results: events fell by 20% in 17,604 patients.", body_excerpt: null, enrichment: {} }) };
  const revived = pipelineFor(editor, { now: new Date(NOW.getTime() + 2 * DAY), plugin });
  await revived.processBatch();
  const back = await itemOf(old);
  assert.notEqual(back.state, "failed", "a text arrived: the item is back in the queue and goes on to be edited and published");
  assert.equal(back.state, "published");
  assert.deepEqual(back.editor_diagnostics?.giveUp ?? null, null, "the give-up mark went with it");
});

test("G11: an item that failed for another reason is not taken back by a text", options, async () => {
  const inserted = await database.query(`INSERT INTO evimed_frontier.items (public_id, primary_source_id, canonical_url, identity_key, title_raw, lang, lane, source_type,
      first_seen_at, timeline_at, state, verification, evidence_type, attempts)
    VALUES ($1,'nejm','https://example.org/x',$2,'x','en','evidence','journal',$3,$3,'failed','pending','rct',3) RETURNING id`,
  [`t${randomUUID().replace(/-/g, "").slice(0, 15)}`, `url:${sha256("failed-x")}`, new Date(NOW.getTime() - DAY)]);
  const id = String(inserted.rows[0].id);
  seq += 1;
  const entry = await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url, title_raw, first_seen_at, content_sha256, state, item_id)
    VALUES ($1,$2,'nejm',$3,'https://example.org/x','https://example.org/x','x',$4,$5,'promoted',$6) RETURNING *`,
  [`nejm:${seq}`, 840_000 + seq, `url:${sha256("failed-x")}`, new Date(NOW.getTime() - DAY), sha256(`f${seq}`), id]);
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url, title_raw, first_seen_at, content_sha256, state)
    VALUES ($1,$2,2,'nejm',$3,'https://example.org/x','https://example.org/x','x',$4,$5,'received')`,
  [entry.rows[0].plugin_entry_id, 841_000 + seq, `url:${sha256("failed-x")}`, new Date(NOW.getTime() - DAY), sha256(`g${seq}`)]);
  const plugin = { text: async () => ({ status: "available", abstract: "Background: a trial. Results: events fell by 20%.", body_excerpt: null, enrichment: {} }) };
  await pipelineFor(editorWith(), { plugin }).processBatch();
  assert.equal((await itemOf(id)).state, "failed", "only the item that gave up for want of a text is taken back by one");
});

test("G10: the hot list names an event again by the first member with a Chinese title, and never by a raw link", options, async () => {
  const post = await insertItem(database, { sourceId: "nejm", title: "Breaking: FDA approves first oral GLP-1 https://t.co/AbC123xyz", titleZh: null, visibleAt: "2026-10-24T22:00:00Z", timelineAt: "2026-10-24T22:00:00Z" });
  const coverage = await insertItem(database, { sourceId: "nejm", title: "FDA clears the first oral GLP-1 for weight loss", titleZh: "FDA批准首个口服GLP-1减重药", visibleAt: "2026-10-24T23:00:00Z", timelineAt: "2026-10-24T23:00:00Z" });
  // The event was named by its first report, the post whose Chinese title was refused: a raw English title with its link.
  const event = await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at, report_count)
    VALUES ('384cf3806b8be6d1', $1, 'evidence', $2, $3, 2) RETURNING id`, ["Breaking: FDA approves first oral GLP-1 https://t.co/AbC123xyz", "2026-10-24T22:00:00Z", "2026-10-24T23:00:00Z"]);
  await database.query(`INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1, $2, 'primary', 'identifier'), ($1, $3, 'report', 'model')`,
    [event.rows[0].id, post.id, coverage.id]);
  await database.query("UPDATE evimed_frontier.items SET event_id = $1 WHERE id = ANY($2::bigint[])", [event.rows[0].id, [post.id, coverage.id]]);
  const events = new FrontierEvents({ database, editor: null, embedder: null, now: () => NOW, config: {} });
  await events.computeHot();
  assert.equal((await database.query("SELECT title_zh FROM evimed_frontier.events WHERE id = $1", [event.rows[0].id])).rows[0].title_zh, "FDA批准首个口服GLP-1减重药");
  // An overview's own title still names the event once written.
  await database.query("UPDATE evimed_frontier.events SET digest_title_zh = '口服GLP-1减重药获批' WHERE id = $1", [event.rows[0].id]);
  await events.computeHot();
  assert.equal((await database.query("SELECT title_zh FROM evimed_frontier.events WHERE id = $1", [event.rows[0].id])).rows[0].title_zh, "口服GLP-1减重药获批");
});
