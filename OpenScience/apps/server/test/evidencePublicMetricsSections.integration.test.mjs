// The monthly page's two optional sections and the author fields (flywheel review 2026-10-06), against a real PostgreSQL and over HTTP:
// the question bank's month (per-class accuracy and the share of cited answers that cited an EviMed page) and the prediction registry's
// calibration appear under the three figures only where their readers are composed and have something to say; absent, failing or empty
// readers leave the page as it was; and a doctor's or a company's people appear on the author pages, nothing for an account that set none.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { authorHandlesFor } from "../src/evidenceAuthorHandles.mjs";
import { EvidenceAuthors } from "../src/evidenceAuthors.mjs";
import { createEvidencePublicMetrics } from "../src/evidencePublicMetrics.mjs";
import { createEvidencePublicRoutes } from "../src/evidencePublicRoutes.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { sendError } from "../src/security.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
const NOW = new Date("2026-10-15T00:00:00Z");

/** One month of the bank as `questionBankSummary` answers it. */
const bankMonth = (/** @type {string} */ month, /** @type {any} */ extra = {}) => ({
  month, available: true, bankVersion: 1, publicHost: "www.evimed.test",
  coverage: { doubao: { state: "done", rounds: 1 }, kimi: { state: "skipped", rounds: 0, reason: "engine_down" } },
  classes: [
    { class: "dose", label: "用法用量", answers: 10, judged: 10, refusals: 0, unjudged: 0, correct: 6, wrong: 2, decided: 8, otherDecided: 0, cited: 4, citedEviMed: 1, rate: 0.75, eviMedCitedShare: 0.25 },
    { class: "interaction", label: "相互作用", answers: 5, judged: 5, refusals: 0, unjudged: 0, correct: 0, wrong: 0, decided: 0, otherDecided: 0, cited: 0, citedEviMed: 0, rate: null, eviMedCitedShare: null },
  ],
  overall: { answers: 15, judged: 15, refusals: 0, unjudged: 0, correct: 6, wrong: 2, decided: 8, otherDecided: 0, cited: 4, citedEviMed: 1, rate: 0.75, eviMedCitedShare: 0.25 },
  engines: {}, ...extra,
});
const EMPTY_MONTH = (/** @type {string} */ month) => ({ month, available: false, classes: [], overall: { answers: 0 } });
const CALIBRATION_WAITING = { available: false, scored: 7 };
const CALIBRATION = {
  available: true, scored: 41,
  probability: { n: 30, brierMean: 0.181, bins: [{ from: 0.6, to: 0.7, n: 12, meanPredicted: 0.65, observedRate: 0.5833333 }, { from: 0.7, to: 0.8, n: 18, meanPredicted: 0.74, observedRate: 0.7222222 }] },
  estimate: { n: 11, meanAbsoluteError: 0.126, coverage: { n: 11, rate: 0.8181818 } },
};

/** @type {any} */ let isolated, db, zones;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "metricsections");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('doctor','李医生','development'),('plain','王芳','development')");
  zones = new EvidenceZoneService({ database: db });
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => { if (db) await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE"); });

/** The router in front of a real HTTP server. @param {import("node:test").TestContext} t @param {Record<string, any>} [settings] */
async function serve(t, settings = {}) {
  const reports = /** @type {string[]} */ ([]);
  const routes = createEvidencePublicRoutes({ config: { evidencePublicWebEnabled: true, publicUrl: "https://www.evimed.test" }, database: db, now: () => NOW, report: (code) => reports.push(code), ...settings });
  const server = createServer((req, res) => { routes(req, res).then((handled) => { if (!handled) { res.writeHead(418); res.end(); } }, (error) => sendError(res, error)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = /** @type {any} */ (server.address()).port;
  const text = async (/** @type {string} */ path) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "user-agent": BROWSER } }); return { status: response.status, body: await response.text() }; };
  return { text, reports, routes };
}

test("the question bank's month and the calibration table appear under the three figures, with the numbers the readers gave", options, async (t) => {
  const { text } = await serve(t, { questionBank: async ({ month }) => (month === "2026-10" ? bankMonth(month) : EMPTY_MONTH(month)), predictionCalibration: async () => CALIBRATION });
  const page = await text("/evidence/metrics");
  assert.equal(page.status, 200);
  assert.ok(page.body.indexOf("核验通过率") < page.body.indexOf("AI 助手回答常见用药问题：2026-10"), "under the three figures");
  assert.ok(page.body.indexOf("AI 助手回答常见用药问题") < page.body.indexOf("预测的校准"));
  // The per-class accuracy: counts, a rate where something was decided, and the plain words where nothing was.
  assert.match(page.body, /<tr><td>用法用量<\/td><td class="num">10<\/td><td class="num">8<\/td><td class="num">6<\/td><td class="num">75%<\/td><\/tr>/);
  assert.match(page.body, /<tr><td>相互作用<\/td><td class="num">5<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">没有可判定的陈述<\/td><\/tr>/, "never 0 for nothing decided");
  assert.match(page.body, /<tr><td>合计<\/td><td class="num">15<\/td>/);
  assert.ok(page.body.includes("<strong>25%</strong> 引用了 EviMed 的页面（4 条中的 1 条）"), "the share of cited answers that cited an EviMed page");
  assert.ok(page.body.includes("本月问到的助手：豆包。") && page.body.includes("本月还没有问到：Kimi"), "which assistants the rates cover");
  // The calibration: the bins, the Brier score and the estimates.
  assert.match(page.body, /<td>60%–70%<\/td><td class="num">12<\/td><td class="num">65%<\/td><td class="num">58.3%<\/td>/);
  assert.ok(page.body.includes("Brier 分数平均为 0.181（30 条") && page.body.includes("平均绝对误差为 0.126（11 条）") && page.body.includes("占 81.8%（11 条）"));
  assert.equal(page.body.includes("满 30 条后公开整体校准"), false, "no waiting sentence once the calibration is available");
  // The API carries the same, additively.
  const api = JSON.parse((await text("/evidence/api/v1/metrics")).body).data;
  assert.equal(api.questionBank.month, "2026-10");
  assert.equal(api.questionBank.overall.eviMedCitedShare, 0.25);
  assert.deepEqual(api.questionBank.coverage, { doubao: { state: "done" }, kimi: { state: "skipped" } });
  assert.equal(api.predictionCalibration.available, true);
  assert.equal(api.predictionCalibration.probability.bins.length, 2);
  assert.ok(Array.isArray(api.months));
});

test("before enough predictions are scored the page says how many and when the calibration is published, and draws no curve", options, async (t) => {
  const { text } = await serve(t, { predictionCalibration: async () => CALIBRATION_WAITING });
  const page = await text("/evidence/metrics");
  assert.ok(page.body.includes("已评分 7 条，满 30 条后公开整体校准。"));
  assert.equal(page.body.includes("<th>预测的成功概率</th>"), false);
  assert.equal(page.body.includes("AI 助手回答常见用药问题"), false, "no question bank reader, no bank section");
  assert.deepEqual(JSON.parse((await text("/evidence/api/v1/metrics")).body).data.predictionCalibration, { available: false, scored: 7, minScored: 30 });
});

test("absent readers, readers with nothing to say and readers that fail leave the page as it was; a failure is counted and reported, and the bank falls back one month", options, async (t) => {
  const none = await serve(t);
  const bare = (await none.text("/evidence/metrics")).body;
  assert.equal(bare.includes("AI 助手回答常见用药问题") || bare.includes("预测的校准"), false, "absent readers: no section");
  assert.deepEqual(Object.keys(JSON.parse((await none.text("/evidence/api/v1/metrics")).body).data), ["months"]);

  const quiet = await serve(t, { questionBank: async ({ month }) => EMPTY_MONTH(month), predictionCalibration: async () => null });
  const quietPage = (await quiet.text("/evidence/metrics")).body;
  assert.equal(quietPage.includes("AI 助手回答常见用药问题") || quietPage.includes("预测的校准"), false, "a month with no answers, and a registry that is not composed: no section");

  const broken = await serve(t, { questionBank: async () => { throw new Error("geo schema missing"); }, predictionCalibration: async () => { throw new Error("evolution down"); } });
  const brokenPage = await broken.text("/evidence/metrics");
  assert.equal(brokenPage.status, 200, "a failed section never fails the page");
  assert.ok(brokenPage.body.includes("按月公开的数") && brokenPage.body.includes("核验通过率"), "the three figures are still there");
  assert.equal(brokenPage.body.includes("预测的校准"), false);
  assert.ok(broken.reports.includes("evidence_public_section_failed"), "traceable, not swallowed");
  assert.equal(/** @type {any} */ (broken.routes).stats().metrics.sectionFailures, 2);

  // The current month has no answers yet: the page shows last month's.
  const previous = await serve(t, { questionBank: async ({ month }) => (month === "2026-09" ? bankMonth(month) : EMPTY_MONTH(month)) });
  assert.ok((await previous.text("/evidence/metrics")).body.includes("AI 助手回答常见用药问题：2026-09"));
});

test("a section's answer is remembered for ten minutes and shared by the views that arrive while it is being read", options, async () => {
  let clock = NOW.getTime();
  let asked = 0;
  const metrics = createEvidencePublicMetrics({ database: db, now: () => new Date(clock), questionBank: async ({ month }) => { asked += 1; return bankMonth(month); }, predictionCalibration: async () => CALIBRATION });
  await Promise.all([metrics.questionBank(), metrics.questionBank(), metrics.questionBank()]);
  await metrics.questionBank();
  assert.equal(asked, 1, "concurrent and later views share one read");
  clock += 601_000;
  await metrics.questionBank();
  assert.equal(asked, 2, "asked again once the ten minutes have passed");
  assert.deepEqual(await createEvidencePublicMetrics({ database: db }).questionBank(), null, "no reader: nothing");
});

test("a doctor's or a company's people appear on the in-app and the public author page, and nothing appears for an account that set none", options, async (t) => {
  const open = async (/** @type {string} */ userId) => {
    const user = { id: userId };
    const { zone } = await zones.save(user, { title: `${userId} zone`, description: "d", background: "b" });
    const live = (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
    return (await zones.setVisibility(user, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  };
  const input = (/** @type {string} */ title, /** @type {any} */ extra = {}) => ({
    title, subtype: "academic", summary: "摘要。", body: "正文", state: "published", limitations: "单项试验", provenance: "p",
    sources: [{ title: "试验", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" }],
    content: { question: "q", answer: "a", population: "成人" },
    claims: [{ claimId: "CLM-001", claimType: "direct", claim: "卒中更少。", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" }], ...extra,
  });
  const kindZone = (await zones.save({ id: "doctor" }, { title: "产品专区", description: "d", background: "b", kind: "product" })).zone;
  const kindLive = (await zones.save({ id: "doctor" }, { expectedRevision: kindZone.revision, state: "published" }, kindZone.id)).zone;
  const doctorZone = (await zones.setVisibility({ id: "doctor" }, kindLive.id, { visibility: "internet", expectedRevision: kindLive.revision })).zone;
  await zones.saveEditorial({ id: "doctor" }, input("医生的卡", {
    producer: { kind: "doctor", name: "李医生", relation: "own_product", products: ["Drug A"] }, journeyStage: { key: "treatment-choice", label: "治疗选择" },
    disclosure: { authors: [{ name: "李医生", affiliation: "协和医院 心内科", title: "主任医师 · 心血管" }], reviewers: [{ name: "王药师", title: "药师" }] },
  }), doctorZone.id, null, true, "geo");
  const plainZone = await open("plain");
  await zones.saveEditorial({ id: "plain" }, input("普通卡"), plainZone.id, null, true, "result");
  const handles = await authorHandlesFor(db, ["doctor", "plain"]);

  const inApp = new EvidenceAuthors({ database: db });
  const doctorPage = await inApp.page({ id: "reader" }, /** @type {string} */ (handles.get("doctor")));
  assert.deepEqual(doctorPage.producer, { kind: "doctor", name: "李医生", relation: "own_product", products: ["Drug A"] });
  assert.deepEqual(doctorPage.people, [{ name: "李医生", affiliation: "协和医院 心内科", title: "主任医师 · 心血管" }, { name: "王药师", affiliation: null, title: "药师" }]);
  const plainPage = await inApp.page({ id: "reader" }, /** @type {string} */ (handles.get("plain")));
  assert.equal("producer" in plainPage || "people" in plainPage, false, "an account that signs as itself and names nobody: nothing");

  const { text } = await serve(t);
  const publicDoctor = (await text(`/evidence/a/${handles.get("doctor")}`)).body;
  assert.ok(publicDoctor.includes("卡片里署名的作者和审核人：李医生，协和医院 心内科，主任医师 · 心血管；王药师，药师"));
  const publicPlain = (await text(`/evidence/a/${handles.get("plain")}`)).body;
  assert.equal(publicPlain.includes("卡片里署名的作者和审核人"), false, "nothing for an account that set none");
});
