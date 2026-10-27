// A top journal's research paper with no text is read through the reports of it (c3-primary, 2026-10-25), against a real PostgreSQL:
// the NEJM tarlatamab-durvalumab trial of the held list — its reports published, its abstract in no index — is published with a text
// made of those reports and a 导读 that says whose they are; when its abstract arrives the text, the 导读 and the 要点 are made from
// the abstract; a paper the model reads as not research, one with no reports, a lower-tier journal and a switched-off step take none;
// an item given up on at fourteen days and an entry dropped for want of a text come back.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { FRONTIER_REPORTS_BASIS } from "../src/frontierPrimaryReports.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-25T13:00:00Z");
const operator = `frontier_op_${randomUUID().slice(0, 8)}`;
const owner = { userId: operator, projectId: "evimed-frontier" };
/** @type {any} */
let database;
let seq = 0;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateUsageLedger(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Operator','development')", [operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_control.users WHERE id = $1", [operator]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.events");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await insertSource(database, "nejm", { name: "新英格兰医学杂志 NEJM", authority: 5, access: "crossref-issn" });
  await insertSource(database, "lancet", { name: "柳叶刀 The Lancet", authority: 5, access: "crossref-issn" });
  await insertSource(database, "small-journal", { name: "Small Journal", authority: 3, access: "crossref-issn" });
  await insertSource(database, "endpoints", { name: "Endpoints News", lane: "pipeline", source_type: "media", access: "rss", egress: "direct", authority: 3, owner_entity: "Endpoints" });
  await insertSource(database, "yixuejie", { name: "医学界", lane: "evidence", source_type: "media", access: "rss", egress: "direct", authority: 3, owner_entity: "医学界" });
  await insertSource(database, "x-myesmo", { name: "ESMO on X", lane: "evidence", source_type: "media", access: "socialdata", egress: "api", authority: 2, owner_entity: "ESMO" });
});

const TRIAL = { doi: "10.1056/nejmoa2609482", title: "Tarlatamab–Durvalumab Maintenance for Extensive-Stage Small-Cell Lung Cancer" };
const ABSTRACT = "BackgroundPatients with extensive-stage small-cell lung cancer have poor outcomes, with a median overall survival of approximately 12 to 13 months. "
  + "ResultsThe median overall survival was 25.3 months with tarlatamab plus durvalumab and 13.9 months with durvalumab (hazard ratio for death, 0.42).";

/**
 * A published report: its card summary and 导读 are the Chinese the pipeline wrote; the raw title is what the source gave.
 * @param {string} sourceId @param {string} titleRaw @param {string} titleZh @param {string} summaryZh @param {string | null} leadZh
 */
async function report(sourceId, titleRaw, titleZh, summaryZh, leadZh = null, near = null) {
  const item = await insertItem(database, { sourceId, sourceType: "media", title: titleRaw, titleZh, summaryZh, evidenceType: "other",
    visibleAt: "2026-10-24T15:30:00Z", timelineAt: "2026-10-24T15:30:00Z", scores: { authority: 12, impact: 12, novelty: 5, relevance: null } });
  if (leadZh) await database.query("UPDATE evimed_frontier.items SET lead_zh = $2 WHERE id = $1", [item.id, leadZh]);
  if (near !== null) {
    await database.query("INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding, embedded_at) VALUES ($1, $2, $3::vector, clock_timestamp())",
      [item.id, EMBEDDER.modelKey, `[${direction(near).join(",")}]`]);
  }
  return item;
}

/** A unit vector at `angle` radians from the paper's own (the first axis): the cosine to the paper is cos(angle). @param {number} angle */
function direction(angle) {
  const vector = new Array(1024).fill(0);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  return vector;
}

/** The embedder of the deployment: it puts every paper on the first axis; the reports above were put at their angles. */
const EMBEDDER = { configured: true, modelKey: "test-embedder", dimension: 1024, embedDocuments: async (/** @type {string[]} */ texts) => texts.map(() => direction(0)) };

/**
 * A paper the way a top journal's research paper stands while no index has its abstract: an item that is not published, its entry held,
 * and no text row at all.
 * @param {Record<string, any>} [overrides]
 */
async function heldPaper({ sourceId = "nejm", doi = TRIAL.doi, title = TRIAL.title, state = "screened", firstSeen = "2026-10-24T09:00:00Z", entryState = "held", reason = "text-pending", diagnostics = {} } = {}) {
  const item = await insertItem(database, { sourceId, doi, title, state, visibleAt: firstSeen, timelineAt: firstSeen, scores: { authority: 28, impact: null, novelty: null, relevance: null } });
  await database.query("DELETE FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id]);
  await database.query("UPDATE evimed_frontier.items SET visible_at = NULL, first_seen_at = $2, editor_diagnostics = $3::jsonb, verification = 'pending' WHERE id = $1", [item.id, firstSeen, JSON.stringify(diagnostics)]);
  seq += 1;
  const entry = await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url,
      title_raw, doi, summary_raw, facts, first_seen_at, received_at, content_sha256, state, state_reason, hold_until, item_id, defects)
    VALUES ($1,$2,1,$3,$4,$5,$5,$6,$7,NULL,'{"journal":"New England Journal of Medicine"}'::jsonb,$8,$8,$9,$10,$11,$12,$13,'{}') RETURNING id`,
  [`${sourceId}:${seq}`, 700_000 + seq, sourceId, `doi:${doi}`, `https://doi.org/${doi}`, title, doi, firstSeen, createHash("sha256").update(`${seq}`).digest("hex"),
    entryState, reason, new Date(NOW.getTime() + 12 * HOUR), item.id]);
  return { ...item, entryId: String(entry.rows[0].id) };
}

/** A paper-and-reports scenario: the three reports of the trial and one of another disease. */
async function trialReports() {
  return {
    x: await report("x-myesmo", "#ESMO26: Significant improvements in overall survival in the DeLLphi-305 #ClinicalTrial with the bispecific T-cell engager tarlatamab",
      "DeLLphi-305：tarlatamab联合度伐利尤单抗改善广泛期小细胞肺癌总生存", "DeLLphi-305试验中，tarlatamab联合度伐利尤单抗显著改善广泛期小细胞肺癌患者的总生存。", null, 0.5),
    endpoints: await report("endpoints", "#ESMO26: Amgen's Imdelltra regimen more than halves risk of death in Phase 3 lung cancer trial",
      "Imdelltra联合方案在3期小细胞肺癌试验中降低死亡风险58%", "安进的Imdelltra联合方案在3期试验中使死亡风险降低58%。",
      "安进的Imdelltra与阿斯利康的度伐利尤单抗联合用于广泛期小细胞肺癌一线维持治疗，在3期试验中使死亡风险降低58%。", 0.7),
    yixuejie: await report("yixuejie", "医学界：塔拉妥单抗联合度伐利尤单抗维持治疗广泛期小细胞肺癌", "塔拉妥单抗联合度伐利尤单抗一线维持治疗广泛期小细胞肺癌",
      "DeLLphi-305研究显示联合维持治疗组中位总生存25.3个月，对照组13.9个月。", null, 0.6),
    other: await report("endpoints", "Roche's giredestrant trial reads out in breast cancer", "罗氏giredestrant在乳腺癌试验中读出结果", "罗氏的giredestrant在乳腺癌3期试验中读出结果。", null, 1.45),
  };
}

/**
 * An editor that answers the reports call (`writeJson` with the judging instructions, its answer verified by the real checks), the 导读
 * and records what each was shown. `judge` decides from the call's input.
 * @param {{ judge?: (input: any) => any, lead?: (input: string) => any }} behaviour
 */
function editorWith(behaviour = {}) {
  return {
    owner, available: true, timeZone: "Asia/Shanghai", model: "deepseek-flash",
    judgeInputs: /** @type {any[]} */ ([]), leadInputs: /** @type {string[]} */ ([]), leadInstructions: /** @type {string[]} */ ([]), briefInputs: /** @type {string[]} */ ([]),
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ input, /** @type {number} */ _max, /** @type {any} */ opts) {
      if (instructions.includes("判断两件事")) {
        const parsed = JSON.parse(input);
        this.judgeInputs.push(parsed);
        const checked = opts.verify(behaviour.judge ? behaviour.judge(parsed) : { paper: "research", reports: [] });
        return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
      }
      if (!instructions.includes("「AI 导读」")) return { verification: "passed", output: {}, error: null };
      this.leadInputs.push(input);
      this.leadInstructions.push(instructions);
      const checked = opts.verify(behaviour.lead ? behaviour.lead(input) : { lead_zh: "" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson(/** @type {any[]} */ messages) {
      if (String(messages[0].content).includes("「要点」")) { this.briefInputs.push(String(messages[1].content)); return { points: {} }; }
      return { drop: [] };
    },
    async screen() { return { verdicts: new Map(), errors: new Map(), calls: 0 }; },
    async edit(/** @type {any} */ item) {
      const modelInput = buildModelInput(item);
      return { verification: "passed", modelInput, modelInputSha256: sha256(modelInput), attempts: 1, issues: [], numbers: null, error: null, model: "deepseek-flash",
        editorVersion: FRONTIER_EDITOR_VERSION, fieldDiagnostics: { title_zh: ["passed"], summary_zh: ["passed"] },
        output: { genre: null, titleZh: `中文：${item.titleRaw.slice(0, 20)}`, summaryZh: null, reasonZh: null, lane: item.allowedLanes[0], specialties: [],
          evidenceType: item.evidenceFixed?.type ?? "rct", entities: { drugs: [], trials: [], orgs: [], diseases: [] },
          scores: { impact: 20, novelty: 10, relevance: 10 }, flags: [] } };
    },
    async translateBody() { return { paragraphs: [], complete: false, calls: 1, error: null }; },
  };
}

/** The judge that takes the reports of the trial (by the words they carry) and says the paper is research. */
const judgesTheTrial = (/** @type {any} */ input) => ({ paper: "research", reports: input.reports
  .filter((/** @type {any} */ r) => /DeLLphi|Imdelltra|塔拉妥/.test(`${r.title} ${r.summary}`))
  .map((/** @type {any} */ r) => ({ id: r.id, anchor: (/DeLLphi-305|Imdelltra|塔拉妥单抗/.exec(`${r.title} ${r.summary}`) ?? [""])[0] })) });

/** @param {any} editor @param {{ now?: Date, plugin?: any, config?: Record<string, any> }} [input] */
function pipelineFor(editor, { now = NOW, plugin = { text: async () => ({ status: "pending" }) }, config = {}, embedder = EMBEDDER } = {}) {
  return new FrontierPipeline({ database, editor, plugin, embedder, now: () => now, workerId: `test-${randomUUID()}`, glossary: new FrontierGlossary([]),
    config: { kbEmbeddingDimension: 1024, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, frontierSelectThreshold: 80, ...config } });
}

const textsOf = async (/** @type {string} */ id) => (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [id])).rows[0];
const itemOf = async (/** @type {string} */ id) => (await database.query("SELECT * FROM evimed_frontier.items WHERE id = $1", [id])).rows[0];
const entryOf = async (/** @type {string} */ id) => (await database.query("SELECT * FROM evimed_frontier.entries WHERE id = $1", [id])).rows[0];

test("the tarlatamab-durvalumab trial is published on its reports, its 导读 says whose they are, and its abstract replaces them", options, async () => {
  const reports = await trialReports();
  const paper = await heldPaper();
  const editor = editorWith({
    judge: judgesTheTrial,
    lead: (input) => (input.includes("媒体报道摘编")
      ? { lead_zh: "据 Endpoints News、医学界报道，tarlatamab联合度伐利尤单抗用于广泛期小细胞肺癌一线维持治疗，使死亡风险降低58%。" }
      : { lead_zh: "tarlatamab联合度伐利尤单抗维持治疗的试验中，中位总生存25.3个月，对照组13.9个月，死亡风险比0.42。" }),
  });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();

  // The judge was shown the paper and the reports of the day, not the paper itself as a report, and the trial's reports were taken.
  assert.equal(editor.judgeInputs.length, 1);
  assert.equal(editor.judgeInputs[0].paper.doi, TRIAL.doi);
  assert.ok(editor.judgeInputs[0].reports.length >= 3);
  const texts = await textsOf(paper.id);
  assert.match(texts.reader_reports, /^(ESMO on X|Endpoints News|医学界)：/);
  assert.match(texts.reader_reports, /Endpoints News：安进的Imdelltra与阿斯利康的度伐利尤单抗联合用于广泛期小细胞肺癌一线维持治疗/);
  assert.match(texts.reader_reports, /医学界：DeLLphi-305研究显示/);
  assert.doesNotMatch(texts.reader_reports, /giredestrant/, "a report of another trial is not taken");
  assert.deepEqual(texts.reader_reports_refs.map((/** @type {any} */ r) => r.item_id).sort(), [reports.x.id, reports.endpoints.id, reports.yixuejie.id].sort());
  assert.equal(texts.abstract_raw, null);

  // The paper keeps its title and link; it is published, flagged as a journal item without an abstract, with the reports as its reader text.
  const published = await itemOf(paper.id);
  assert.equal(published.state, "published");
  assert.equal(published.title_raw, TRIAL.title);
  assert.equal(published.doi, TRIAL.doi);
  assert.ok(published.flags.includes("no-abstract"));
  assert.equal(texts.reader_tidy.source, "reports");
  assert.ok(texts.reader_tidy.sha.startsWith(FRONTIER_REPORTS_BASIS));
  assert.equal(texts.reader_tidy.model, undefined, "reports are settled by code");

  // The 导读 was written from the reports, named as such, with the attribution line, and its basis says so.
  const leadAsked = editor.leadInputs.find((input) => input.includes("媒体报道摘编")) ?? "";
  assert.match(leadAsked, /\n正文（媒体报道摘编）：\n/);
  assert.ok(editor.leadInstructions.some((text) => text.includes("据 {来源名")), "the attribution line is for this basis");
  assert.match(published.lead_zh, /^据 Endpoints News、医学界报道，/);
  assert.equal(published.lead_basis, texts.reader_tidy.sha);
  assert.ok(published.lead_basis.startsWith(FRONTIER_REPORTS_BASIS));
  assert.equal(editor.briefInputs.length, 0, "no 要点 is written from reports");
  assert.equal(pipeline.counters.primaryReports, 1);
  assert.notEqual(published.primary_checked_at, null);

  // The next round, an hour on, does not ask again.
  await pipelineFor(editor, { now: new Date(NOW.getTime() + HOUR) }).processBatch();
  assert.equal(editor.judgeInputs.length, 1);

  // Its abstract arrives: the held entry is asked of the plugin, the text replaces the reports, the 导读 is written from the abstract.
  await database.query("UPDATE evimed_frontier.entries SET hold_until = $2 WHERE id = $1", [paper.entryId, new Date(NOW.getTime() - HOUR)]);
  const arrival = new Date(NOW.getTime() + 13 * HOUR);
  const plugin = { text: async () => ({ status: "available", text_kind: "abstract", abstract: ABSTRACT, enrichment: { publication_types: ["Journal Article"] } }) };
  await pipelineFor(editor, { now: arrival, plugin }).processBatch();
  await pipelineFor(editor, { now: arrival, plugin }).processBatch();
  const after = await textsOf(paper.id);
  assert.equal(after.abstract_raw, ABSTRACT);
  assert.equal(after.reader_tidy.source, "abstract");
  assert.equal(after.reader_tidy.sha, sha256(ABSTRACT));
  const rewritten = await itemOf(paper.id);
  assert.equal(rewritten.lead_basis, sha256(ABSTRACT), "the 导读 rests on the abstract now");
  assert.match(rewritten.lead_zh, /^tarlatamab联合度伐利尤单抗维持治疗的试验中/);
  assert.ok(editor.leadInputs.some((input) => input.includes("\n正文（摘要）：\nBackground")));
  assert.ok(!rewritten.flags.includes("no-abstract"), "the item has its abstract");
});

test("a paper the model reads as not research takes no reports, and is looked at again only after six hours", options, async () => {
  await trialReports();
  const letter = await heldPaper({ doi: "10.1056/nejmc2609433", title: "IVUS-Guided PCI in Left Main Coronary Disease" });
  const editor = editorWith({ judge: () => ({ paper: "other", reports: [{ id: "r1", anchor: "DeLLphi-305" }] }) });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();
  assert.equal(editor.judgeInputs.length, 1);
  assert.equal(await textsOf(letter.id), undefined, "no text row, no reports");
  assert.equal(pipeline.counters.primaryNotResearch, 1);
  await pipelineFor(editor, { now: new Date(NOW.getTime() + 2 * HOUR) }).processBatch();
  assert.equal(editor.judgeInputs.length, 1);
  await pipelineFor(editor, { now: new Date(NOW.getTime() + 7 * HOUR) }).processBatch();
  assert.equal(editor.judgeInputs.length, 2, "asked again after six hours");
});

test("an answer whose anchor is not in the report it names is refused after one rewrite, and nothing is taken", options, async () => {
  await trialReports();
  const paper = await heldPaper();
  const editor = editorWith({ judge: (input) => ({ paper: "research", reports: [{ id: input.reports[0].id, anchor: "a phrase no report holds" }] }) });
  await pipelineFor(editor).processBatch();
  assert.equal(await textsOf(paper.id), undefined);
  assert.equal((await itemOf(paper.id)).state, "screened");
});

test("no report near the paper, no call", options, async () => {
  await report("endpoints", "Roche's giredestrant trial reads out in breast cancer", "罗氏giredestrant在乳腺癌试验中读出结果", "罗氏的giredestrant在乳腺癌3期试验中读出结果。", null, 1.45);
  const paper = await heldPaper();
  const editor = editorWith({ judge: judgesTheTrial });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.judgeInputs.length, 0);
  assert.equal(await textsOf(paper.id), undefined);
  assert.notEqual((await itemOf(paper.id)).primary_checked_at, null);
});

test("a lower-tier journal's paper, a switched-off step and a paper older than twenty-one days take no reports", options, async () => {
  await trialReports();
  const small = await heldPaper({ sourceId: "small-journal", doi: "10.1234/small.1" });
  const stale = await heldPaper({ doi: "10.1056/nejmoa0000000", firstSeen: new Date(NOW.getTime() - 22 * DAY).toISOString(), entryState: "dropped", reason: "no-text" });
  const editor = editorWith({ judge: judgesTheTrial });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.judgeInputs.length, 0);
  assert.equal(await textsOf(small.id), undefined);
  assert.equal(await textsOf(stale.id), undefined);
  const off = await heldPaper({ doi: "10.1056/nejmoa0000001" });
  const quiet = editorWith({ judge: judgesTheTrial });
  await pipelineFor(quiet, { config: { frontierPrimaryReportsEnabled: false } }).processBatch();
  assert.equal(quiet.judgeInputs.length, 0);
  assert.equal(await textsOf(off.id), undefined);
});

test("an item the fourteen-day rule gave up on comes back with its reports, and a dropped entry is held again when the plugin has its text", options, async () => {
  await trialReports();
  const gone = await heldPaper({ state: "failed", firstSeen: new Date(NOW.getTime() - 16 * DAY).toISOString(), entryState: "held", diagnostics: { giveUp: "no-text" } });
  const editor = editorWith({ judge: judgesTheTrial, lead: () => ({ lead_zh: "据 Endpoints News、医学界报道，该联合方案使死亡风险降低58%。" }) });
  await pipelineFor(editor).processBatch();
  assert.equal((await itemOf(gone.id)).state === "failed", false, "it is back in the queue");
  assert.match((await textsOf(gone.id)).reader_reports, /Endpoints News：/);

  const dropped = await heldPaper({ doi: "10.1056/nejmoa2610345", title: "Anbenitamab plus HB1801 for HER2-Positive Advanced Breast Cancer", firstSeen: new Date(NOW.getTime() - 15 * DAY).toISOString(),
    entryState: "dropped", reason: "no-text" });
  await database.query("UPDATE evimed_frontier.entries SET hold_until = NULL WHERE id = $1", [dropped.entryId]);
  let asked = 0;
  const plugin = { text: async () => { asked += 1; return { status: "pending", next_attempt_at: new Date(NOW.getTime() + HOUR).toISOString() }; } };
  const pipeline = pipelineFor(editor, { plugin });
  await pipeline.processBatch();
  assert.ok(asked >= 1);
  const entry = await entryOf(dropped.entryId);
  assert.ok(["held", "promoted"].includes(entry.state), `the entry is back on the path (${entry.state})`);
  assert.equal(pipeline.counters.primaryRevived, 1);

  // An entry the plugin has given up on is asked again only after six hours, and an old one not at all.
  const lost = await heldPaper({ doi: "10.1056/nejmoa2610346", firstSeen: new Date(NOW.getTime() - 15 * DAY).toISOString(), entryState: "dropped", reason: "no-text" });
  await database.query("UPDATE evimed_frontier.entries SET hold_until = NULL WHERE id = $1", [lost.entryId]);
  const unavailable = pipelineFor(editor, { plugin: { text: async () => ({ status: "unavailable" }) } });
  await unavailable.processBatch();
  const parked = await entryOf(lost.entryId);
  assert.equal(parked.state, "dropped");
  assert.ok(new Date(parked.hold_until).getTime() >= NOW.getTime() + 5 * HOUR, "parked for six hours");
});

test("without an embedder the reports are the recent items that share the paper's words, a drug's name enough to be shown to the model", options, async () => {
  await report("x-myesmo", "#ESMO26: Significant improvements in overall survival in the DeLLphi-305 #ClinicalTrial with the bispecific T-cell engager tarlatamab",
    "DeLLphi-305：tarlatamab联合度伐利尤单抗改善广泛期小细胞肺癌总生存", "DeLLphi-305试验中，tarlatamab联合度伐利尤单抗显著改善广泛期小细胞肺癌患者的总生存。");
  await report("endpoints", "Roche's giredestrant trial reads out in breast cancer", "罗氏giredestrant在乳腺癌试验中读出结果", "罗氏的giredestrant在乳腺癌3期试验中读出结果。");
  const paper = await heldPaper();
  const editor = editorWith({ judge: judgesTheTrial, lead: () => ({ lead_zh: "据 ESMO on X报道，tarlatamab联合度伐利尤单抗改善广泛期小细胞肺癌总生存。" }) });
  await pipelineFor(editor, { embedder: null }).processBatch();
  assert.equal(editor.judgeInputs.length, 1);
  assert.equal(editor.judgeInputs[0].reports.length, 1, "the other disease's report shares no word with the paper");
  assert.match((await textsOf(paper.id)).reader_reports, /^ESMO on X：DeLLphi-305试验中/);
});

test("the other two held items of the review: NEJM's IVUS letter and The Lancet's RISE UP comment get no reports, and the trial's reports are not theirs", options, async () => {
  await trialReports();
  await report("x-myesmo", "Mitapivat reduces sickle cell crises in the phase 3 RISE UP trial", "mitapivat在RISE UP 3期试验中减少镰状细胞危象", "RISE UP试验显示mitapivat降低镰状细胞病患者的疼痛危象。", null, 0.55);
  const letter = await heldPaper({ doi: "10.1056/nejmc2609433", title: "IVUS-Guided PCI in Left Main Coronary Disease" });
  const comment = await heldPaper({ sourceId: "lancet", doi: "10.1016/s0140-6736(26)02046-5", title: "Mitapivat in the RISE UP trial: a new therapy for sickle cell disease" });
  const editor = editorWith({
    // The model reads a letter as not research; it reads the comment's title as the trial's and finds no report that is the comment's own.
    judge: (input) => (input.paper.doi.includes("nejmc") ? { paper: "other", reports: [] } : { paper: "research", reports: [] }),
  });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.judgeInputs.length, 2);
  const comments = editor.judgeInputs.find((input) => input.paper.doi.includes("s0140"));
  assert.ok(comments.reports.some((/** @type {any} */ r) => /RISE UP/.test(r.title)), "the sickle cell report was shown for it");
  for (const paper of [letter, comment]) {
    assert.equal(await textsOf(paper.id), undefined);
    assert.equal((await itemOf(paper.id)).state, "screened");
  }
  assert.equal(editor.leadInputs.length, 0);
});
