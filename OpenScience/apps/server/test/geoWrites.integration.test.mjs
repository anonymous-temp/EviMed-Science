// What `geo_write` may put into a GEO project, against the real DDL: every
// item checked against the closed vocabularies and refused one by one (the
// rest written), claims versioned by what they say, the lock's whole-set rules,
// and the words a run may never write (a person's 「放行」, a measured target,
// a platform step), and what decides an article's placement being the
// platform's record rather than the run's word.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GEO_MEASURED_RANGE, geoArticleGateOf, geoLockCheck, geoProgramMinimal, geoRuntimeWrite } from "../src/geoWrites.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const run = randomBytes(4).toString("hex");
const USER = `writer-${run}`;

/** @type {any} */
let database = null;
/** @type {GeoStore} */
let store;
let projectCounter = 0;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geowrites");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  await store.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

async function freshProject() {
  const created = await store.createProject({ userId: USER, projectId: `p-${run}-${++projectCounter}`, engines: ["deepseek"], coverageDays: 90 });
  const project = await store.getProject(USER, created.id);
  return /** @type {any} */ (project);
}

/** A finished baseline, which the strategy and the tiers are read from. @param {any} project */
async function measured(project) {
  await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, status, surface) VALUES ($1, $2, $3, 'baseline', 'done', '{}'::jsonb)`,
    [`rb-${project.id}`, USER, project.id]);
  return project;
}

/** @param {any} project @param {string} what @param {Record<string, any>} body @param {any} [renameProject] @param {any} [articleGate] */
const write = (project, what, body, renameProject = null, articleGate = null) => geoRuntimeWrite({ store, project, what, body, renameProject, articleGate });
/** The run ledger's verdict, as a composition hands it in: every deliverable passed. */
const ledgerPassed = async () => "passed";

/** A full-program set: 12 groups over the four pools, 3 control, 4 measured questions each (48). */
function fullSet({ control = 3, pools = ["P1", "P2", "P3", "P4"], perGroup = 4 } = {}) {
  return Array.from({ length: 12 }, (_unused, index) => ({
    pool: pools[index % pools.length], name: `群 ${index}`, isControl: index < control,
    questions: Array.from({ length: perGroup }, (_q, q) => ({ text: `问 ${index}-${q}`, isMeasured: true })),
  }));
}

test("a write's calls it cannot read are refused whole; its items are refused one by one", options, async () => {
  const project = await freshProject();
  await assert.rejects(write(project, "passwords", {}), { status: 400, code: "geo_write_what_invalid" });
  await assert.rejects(write(project, "claims", { data: {} }), { status: 400, code: "geo_write_payload_invalid" });
  await assert.rejects(write(project, "claims", { items: [] }), { code: "geo_write_payload_invalid" });
  await assert.rejects(write(project, "claims", { items: Array(201).fill({}) }), { code: "geo_write_payload_invalid" });
  await assert.rejects(write(project, "questions", { items: [{}] }), { code: "geo_write_payload_invalid" });
  await assert.rejects(write(project, "claims", { items: [{ claimKey: "x".repeat(300_000) }] }), { status: 413, code: "geo_request_too_large" });

  const result = await write(project, "claims", { items: [
    { claimKey: "dose", statement: "每周一次", quote: "每周一次皮下注射。", sourceRef: "说明书", sourceKind: "label" },
    { claimKey: "bad kind", statement: "s", quote: "q", sourceRef: "r", sourceKind: "blog" },
    { claimKey: "noquote", statement: "s", sourceRef: "r" },
    { claimKey: "dose", statement: "again", quote: "q", sourceRef: "r" },
    "not an object",
    { claimKey: "extra", statement: "s", quote: "q", sourceRef: "r", secret: true },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.ids.length, 2, "the valid claim and the one with an extra field are written");
  const refusals = result.issues.map((/** @type {any} */ issue) => [issue.index, issue.field, issue.code]);
  assert.deepEqual(refusals, [
    [1, "claimKey", "invalid"], [1, "sourceKind", "unknown_value"], [2, "quote", "missing"], [3, "claimKey", "duplicate"], [4, undefined, "invalid"],
    [5, "secret", "ignored_fields"],
  ]);
});

test("a claim is versioned by what it says; its bookkeeping changes in place", options, async () => {
  const project = await freshProject();
  const first = await write(project, "claims", { items: [{ claimKey: "dose", statement: "每周一次", quote: "每周一次皮下注射。", sourceRef: "说明书 2024" }] });
  assert.deepEqual(first.claims.map((/** @type {any} */ entry) => [entry.version, entry.change]), [[1, "created"]]);
  const bookkeeping = await write(project, "claims", { items: [{ claimKey: "dose", statement: "每周一次 ", quote: "每周一次皮下注射。",
    sourceRef: "说明书 2024", evidenceLevel: "A", verifiedAt: "2026-09-25", status: "active" }] });
  assert.deepEqual(bookkeeping.claims.map((/** @type {any} */ entry) => [entry.id, entry.version, entry.change]), [[first.ids[0], 1, "updated"]],
    "whitespace is not a new statement");
  const changed = await write(project, "claims", { items: [{ claimKey: "dose", statement: "每周一次，第 4 周起加量", quote: "每周一次皮下注射。", sourceRef: "说明书 2024" }] });
  assert.deepEqual(changed.claims.map((/** @type {any} */ entry) => [entry.version, entry.change]), [[2, "versioned"]]);
  const listed = await store.listClaims(project.id);
  assert.equal(listed.length, 1, "the list shows the latest version of each claim");
  assert.equal(listed[0].version, 2);
  assert.equal((await store.claimIds(project.id)).size, 2, "the old version stays for the articles that cite it");
});

test("the product merges field by field, a competitor is refused alone, and a brand names a default-named project", options, async () => {
  const project = await freshProject();
  const renamed = /** @type {any[]} */ ([]);
  const result = await write(project, "product", { data: {
    brandName: "玛仕度肽", genericName: "玛仕度肽注射液", rx: "rx", identityStatus: "confirmed", aliases: ["信尔美"],
    competitors: [{ brandName: "替尔泊肽", reason: "同适应证" }, { reason: "no name" }], dosage: "2mg",
  } }, async (/** @type {string} */ userId, /** @type {string} */ projectId, /** @type {string} */ name) => { renamed.push([userId, projectId, name]); });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["dosage", "ignored_fields"], ["brandName", "missing"]]);
  const saved = await store.getProject(USER, project.id);
  assert.equal(saved?.product.brandName, "玛仕度肽");
  assert.deepEqual(saved?.competitors.map((/** @type {any} */ entry) => entry.brandName), ["替尔泊肽"]);
  assert.deepEqual(renamed, [[USER, project.projectId, "玛仕度肽"]]);
  const again = await write(/** @type {any} */ (saved), "product", { data: { holder: "信达生物" } });
  assert.equal(again.ok, true);
  const merged = await store.getProject(USER, project.id);
  assert.deepEqual([merged?.product.brandName, merged?.product.holder], ["玛仕度肽", "信达生物"], "a later write adds, it does not replace");
  assert.equal((await write(/** @type {any} */ (merged), "product", { data: { rx: "maybe" } })).ok, false);
});

test("a question map is a new unlocked version; invalid groups and questions are left out by index", options, async () => {
  const project = await freshProject();
  const result = await write(project, "questions", { data: { note: "first map", groups: [
    { pool: "P1", name: "用法", questions: [{ text: "怎么打", isMeasured: true }, { text: "", isMeasured: true }, { text: "多久", platform: "tiktok" }] },
    { pool: "P9", name: "bad pool", questions: [{ text: "q" }] },
    { pool: "P2", name: "对比", isControl: true, audience: "physician", questions: [{ text: "和司美格鲁肽比", sourceUrl: "ftp://x" }, { text: "哪个好", kind: "real" }] },
  ] } });
  assert.equal(result.ok, true);
  assert.equal(result.version, 1);
  assert.equal(result.ids.length, 2);
  assert.deepEqual(result.issues.map((/** @type {any} */ issue) => [issue.group ?? null, issue.index ?? null, issue.field ?? null, issue.code]), [
    [0, 1, "text", "missing"], [0, 2, "platform", "unknown_value"], [null, 1, "pool", "unknown_value"], [2, 0, "sourceUrl", "invalid"],
  ]);
  const map = await store.questionMap(project.id, 1);
  assert.deepEqual(map.map((group) => [group.name, group.questions.map((question) => question.text)]), [["用法", ["怎么打"]], ["对比", ["哪个好"]]]);
  assert.equal(map[1].questions[0].pool, "P2", "a question takes its group's pool");
  assert.equal((await store.questionSets(project.id))[0].lockedAt, null);
});

test("locking checks the whole set: all four pools, the measured count, and in the full program the control groups", options, async () => {
  const project = await freshProject();
  const lock = async (/** @type {Record<string, any>} */ data = {}) => write(project, "lock_questions", { data });
  assert.deepEqual((await lock()).issues.map((/** @type {any} */ issue) => issue.code), ["not_found"], "nothing to lock yet");

  await write(project, "questions", { data: { groups: fullSet({ pools: ["P1", "P2", "P3"] }) } });
  let refused = await lock();
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.issues.map((/** @type {any} */ issue) => issue.code), ["pools_missing"]);

  await write(project, "questions", { data: { groups: fullSet({ control: 1 }) } });
  refused = await lock();
  assert.deepEqual(refused.issues.map((/** @type {any} */ issue) => issue.code), ["control_groups"]);

  await write(project, "questions", { data: { groups: fullSet({ perGroup: 2 }) } });
  refused = await lock();
  assert.deepEqual(refused.issues.map((/** @type {any} */ issue) => issue.code), ["measured_count"], "24 measured is short of 40");

  // A set of 36 with no control groups: the run saying "minimal" does not make it one.
  await write(project, "questions", { data: { groups: fullSet({ control: 0, perGroup: 3 }) } });
  refused = await lock({ minimal: true });
  assert.equal(refused.ok, false, "a caller's `minimal` is not the program's");
  assert.deepEqual(refused.issues.map((/** @type {any} */ issue) => issue.code).sort(), ["control_groups", "measured_count", "notice"]);
  // A single step asked for downstream (信源), the questions only its upstream: a minimal set —
  // 30 or more measured, four pools, control groups only a notice.
  await store.setStep(project.id, "sources", { status: "queued", requested: true });
  const minimal = await write(/** @type {any} */ (await store.getProject(USER, project.id)), "lock_questions", { data: {} });
  assert.equal(minimal.ok, true, JSON.stringify(minimal.issues));
  assert.equal(minimal.measuredCount, 36);
  assert.deepEqual(minimal.issues.map((/** @type {any} */ issue) => issue.code), ["notice"]);
  assert.equal((await store.getProject(USER, project.id))?.steps.questions.status, "minimal");

  // The full program asked for: the questions step itself is requested.
  await store.setStep(project.id, "questions", { requested: true });
  const program = /** @type {any} */ (await store.getProject(USER, project.id));
  await write(program, "questions", { data: { groups: fullSet() } });
  const full = await write(program, "lock_questions", { data: {} });
  assert.equal(full.ok, true, JSON.stringify(full.issues));
  assert.deepEqual([full.version, full.measuredCount], [5, 48]);
  assert.equal((await store.getProject(USER, project.id))?.steps.questions.status, "done");
  const again = await write(program, "lock_questions", { data: { version: 5 } });
  assert.equal(again.alreadyLocked, true, "locking twice is a no-op");
});

test("a set is minimal only when the program asked for a later step and not for the questions", () => {
  const steps = (/** @type {string[]} */ requested) => Object.fromEntries(requested.map((step) => [step, { requested: true }]));
  assert.equal(geoProgramMinimal({}), false, "nothing asked for: the full rules");
  assert.equal(geoProgramMinimal(null), false);
  assert.equal(geoProgramMinimal(steps(["sources"])), true, "只做信源: its questions are an upstream");
  assert.equal(geoProgramMinimal(steps(["questions"])), false, "只列问题: the questions are the product");
  assert.equal(geoProgramMinimal(steps(["evidence", "journey", "questions", "diagnosis", "sources", "content", "distribution", "monitoring"])), false);
});

test("the lock rule is a pure function of the set", () => {
  assert.deepEqual(GEO_MEASURED_RANGE.full, [40, 120]);
  const groups = (/** @type {number} */ control, /** @type {number} */ total, /** @type {number} */ perGroup) =>
    Array.from({ length: total }, (_unused, index) => ({ pool: ["P1", "P2", "P3", "P4"][index % 4], isControl: index < control,
      questions: Array.from({ length: perGroup }, () => ({ isMeasured: true, pool: null })) }));
  assert.deepEqual(geoLockCheck(groups(3, 12, 4), false).refusals, []);
  assert.equal(geoLockCheck(groups(6, 12, 4), false).refusals[0].code, "control_groups", "six control groups are too many");
  assert.equal(geoLockCheck(groups(3, 24, 4), false).refusals[0].code, "control_groups", "3 of 24 is under a fifth, even with the tolerance");
  assert.deepEqual(geoLockCheck(groups(3, 20, 4), false).refusals, [], "3 of 20 is inside the tolerance");
  assert.equal(geoLockCheck(groups(3, 12, 11), false).refusals[0].code, "measured_count", "132 measured is over 120");
  assert.deepEqual(geoLockCheck(groups(0, 10, 3), true).refusals, [], "a minimal set of 30 locks without control groups");
});

test("targets are forecasts or commercial, three tiers, no duplicates; sources and articles check what they point at", options, async () => {
  const project = await measured(await freshProject());
  const targets = await write(project, "targets", { items: [
    { tier: "1", metricId: "M-19", target: 25, dataType: "forecast" },
    { tier: "2", metricId: "M-19", target: 30, dataType: "measured" },
    { tier: "2", metricId: "M-19", target: 30, dataType: "commercial", budgetCny: 2000 },
    { tier: "1", metricId: "M-19", pool: "all", target: 26, dataType: "forecast" },
    { tier: "4", metricId: "M-19", dataType: "forecast" },
  ] });
  assert.deepEqual(targets.issues.map((/** @type {any} */ issue) => [issue.index ?? null, issue.field, issue.code]), [
    [1, "dataType", "unknown_value"], [3, "metricId", "duplicate"], [4, "tier", "unknown_value"], [null, "tier", "notice"],
  ]);
  assert.deepEqual((await store.latestTargets(project.id))?.rows.map((row) => [row.tier, row.pool, row.dataType]), [["1", "all", "forecast"], ["2", "all", "commercial"]]);

  const sources = await write(project, "sources", { items: [
    { domain: "https://WWW.39.net/path", kind: "vertical", layer: "coverage", newsIndexed: true },
    { domain: "not a host", kind: "vertical" },
    { domain: "39.net", kind: "news" },
    { domain: "fake-times.cn", impostor: true, blacklistReason: "冒名站", layer: "anchor", cited: { deepseek: 9 } },
  ] });
  assert.deepEqual(sources.issues.map((/** @type {any} */ issue) => [issue.index, issue.code]), [[1, "invalid"], [2, "duplicate"], [3, "ignored_fields"]],
    "measured counts are the platform's, not the run's: dropped, the rest of the source kept");
  const listed = await store.listSources(project.id);
  assert.deepEqual(listed.map((source) => source.domain).sort(), ["39.net", "fake-times.cn"]);
  assert.deepEqual(listed.find((source) => source.domain === "fake-times.cn")?.cited ?? {}, {}, "no count came from the run");

  const claims = await write(project, "claims", { items: [{ claimKey: "c", statement: "s", quote: "q", sourceRef: "r" }] });
  await write(project, "questions", { data: { groups: [{ pool: "P1", name: "g", questions: [{ text: "q", isMeasured: true }] }] } });
  const [group] = await store.questionMap(project.id, 1);
  const sha = "e".repeat(64);
  const articles = await write(project, "articles", { items: [
    { path: "deliverables/a.md", layer: "card", claimIds: claims.ids, groupId: group.id, safety: "clear", contentSha256: sha },
    { path: "deliverables/b.md", layer: "card", claimIds: ["gcl_nope"], groupId: group.id, safety: "clear", contentSha256: sha },
    { path: "../etc/passwd", layer: "card", claimIds: [], groupId: group.id, safety: "clear", contentSha256: sha },
    { path: "deliverables/c.md", layer: "card", claimIds: [], groupId: group.id, safety: "released", contentSha256: sha },
    { path: "deliverables/d.md", layer: "essay", claimIds: [], groupId: group.id, safety: "clear", contentSha256: sha },
    { path: "deliverables/e.md", layer: "qa", claimIds: [], groupId: "ggr_nope", safety: "clear", contentSha256: "short" },
  ] }, null, ledgerPassed);
  assert.deepEqual(articles.issues.map((/** @type {any} */ issue) => [issue.index, issue.field, issue.code]), [
    [1, "claimIds", "not_found"], [2, "path", "invalid"], [3, "safety", "unknown_value"], [4, "layer", "unknown_value"],
    [5, "groupId", "not_found"], [5, "contentSha256", "invalid"],
  ], "a run never writes a person's 放行");
  const registered = await store.listArticles(project.id);
  assert.deepEqual(registered.map((article) => [article.path, article.status]), [["deliverables/a.md", "publishable"]]);
  // Re-registering the same path updates it: an open safety finding pulls it back to draft.
  await write(project, "articles", { items: [{ path: "deliverables/a.md", layer: "card", claimIds: claims.ids, groupId: group.id, safety: "open",
    contentSha256: sha }] }, null, ledgerPassed);
  const [again] = await store.listArticles(project.id);
  assert.deepEqual([again.id, again.status, again.safety], [registered[0].id, "draft", "open"]);
});

test("an open safety finding stays open whatever the run registers next; only the release route clears it", options, async () => {
  const project = await freshProject();
  await write(project, "questions", { data: { groups: [{ pool: "P1", name: "g", questions: [{ text: "q", isMeasured: true }] }] } });
  const [group] = await store.questionMap(project.id, 1);
  const article = (/** @type {string} */ safety) => ({ path: "deliverables/geo-content/card-1.md", layer: "card", claimIds: [], groupId: group.id,
    safety, contentSha256: "f".repeat(64) });
  await write(project, "articles", { items: [article("open")] }, null, ledgerPassed);
  const cleared = await write(project, "articles", { items: [article("clear")] }, null, ledgerPassed);
  assert.equal(cleared.ok, true);
  const [held] = await store.listArticles(project.id);
  assert.deepEqual([held.safety, held.status], ["open", "draft"], "the run's own 'clear' cannot lift a safety stop");
  // A person looks and releases it (the route's compare-and-set); from then on the run's word counts again.
  const released = await store.changeArticle(project.id, held.id, { safety: "released", fromSafety: ["open"] });
  assert.deepEqual([released?.safety, released?.status], ["released", "publishable"]);
  await write(project, "articles", { items: [article("clear")] }, null, ledgerPassed);
  const [after] = await store.listArticles(project.id);
  assert.deepEqual([after.safety, after.status], ["clear", "publishable"]);
  await write(project, "articles", { items: [article("open")] }, null, ledgerPassed);
  assert.deepEqual((await store.listArticles(project.id)).map((row) => [row.safety, row.status]), [["open", "draft"]], "a new finding holds it again");
});

test("every article but a correction names its question group", options, async () => {
  const project = await freshProject();
  const sha = "a".repeat(64);
  const result = await write(project, "articles", { items: [
    { path: "deliverables/geo-content/card.md", layer: "card", claimIds: [], safety: "clear", contentSha256: sha },
    { path: "deliverables/geo-content/qa.md", layer: "qa", claimIds: [], safety: "clear", contentSha256: sha },
    { path: "deliverables/geo-content/fix.md", layer: "correction", claimIds: [], safety: "clear", contentSha256: sha },
  ] }, null, ledgerPassed);
  assert.deepEqual(result.issues.map((/** @type {any} */ issue) => [issue.index, issue.field, issue.code]), [[0, "groupId", "missing"], [1, "groupId", "missing"]],
    "a group-less article could be placed into a control group unseen");
  assert.deepEqual((await store.listArticles(project.id)).map((row) => row.layer), ["correction"]);
});

test("an article's gate is the run ledger's verdict, never the run's own claim", options, async () => {
  const project = await freshProject();
  await write(project, "questions", { data: { groups: [{ pool: "P2", name: "g", questions: [{ text: "q", isMeasured: true }] }] } });
  const [group] = await store.questionMap(project.id, 1);
  const item = (/** @type {string} */ name, extra = {}) => ({ path: `deliverables/geo-content/${name}.md`, layer: "popular", claimIds: [], groupId: group.id,
    safety: "clear", contentSha256: "b".repeat(64), gate: "passed", ...extra });
  // No ledger to ask: the run's "passed" is not taken — the article is unverified and not publishable.
  const unasked = await write(project, "articles", { items: [item("one")] });
  assert.deepEqual(unasked.articles.map((/** @type {any} */ entry) => entry.gate), ["unverified"]);
  assert.deepEqual((await store.listArticles(project.id)).map((row) => [row.gate, row.status]), [["unverified", "draft"]]);
  // The ledger is asked with the deliverable the article was written in.
  const asked = /** @type {any[]} */ ([]);
  const ledger = async (/** @type {any} */ _project, /** @type {any} */ ref) => { asked.push(ref); return ref.path.endsWith("two.md") ? "passed" : "failed"; };
  const answered = await write(project, "articles", { items: [item("two", { runId: "run_1" }), item("three", { deliverableId: "geo-content" })] }, null, ledger);
  assert.deepEqual(answered.articles.map((/** @type {any} */ entry) => entry.gate), ["passed", "failed"]);
  assert.deepEqual(asked, [
    { runId: "run_1", deliverableId: "geo-content", path: "deliverables/geo-content/two.md" },
    { runId: null, deliverableId: "geo-content", path: "deliverables/geo-content/three.md" },
  ]);
  assert.deepEqual((await store.listArticles(project.id)).map((row) => [row.path.split("/").pop(), row.gate, row.status]),
    [["one.md", "unverified", "draft"], ["two.md", "passed", "publishable"], ["three.md", "failed", "draft"]]);
  const wrong = await write(project, "articles", { items: [item("four", { gate: "certainly" })] }, null, ledger);
  assert.deepEqual(wrong.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["gate", "unknown_value"]]);
});

test("the ledger's verdict: passed only for a deliverable accepted clean", () => {
  const run = (/** @type {Record<string, any>} */ deliverable, status = "succeeded") => ({ status, deliverables: [{ id: "geo-content", ...deliverable }] });
  assert.equal(geoArticleGateOf(run({ status: "delivered", lastVerdict: "pass" }), "geo-content"), "passed");
  assert.equal(geoArticleGateOf(run({ status: "accepted", lastVerdict: "pass" }, "running"), "geo-content"), "passed");
  assert.equal(geoArticleGateOf(run({ status: "delivered", lastVerdict: "unverified" }), "geo-content"), "unverified");
  assert.equal(geoArticleGateOf(run({ status: "submitted", lastVerdict: "issues" }), "geo-content"), "unverified");
  assert.equal(geoArticleGateOf(run({ status: "failed" }), "geo-content"), "failed");
  assert.equal(geoArticleGateOf(run({ status: "delivered", lastVerdict: "pass" }, "canceled"), "geo-content"), "failed");
  assert.equal(geoArticleGateOf(run({ status: "delivered", lastVerdict: "pass" }), "other"), "unverified", "a deliverable the run does not hold");
  assert.equal(geoArticleGateOf(null, "geo-content"), "unverified");
});

test("a run reports its thinking steps; the platform's steps and the questions' done are not its to write", options, async () => {
  const project = await freshProject();
  const step = (/** @type {Record<string, any>} */ data) => write(project, "step", { data });
  assert.equal((await step({ step: "evidence", status: "running", note: "查说明书" })).ok, true);
  assert.equal((await store.getProject(USER, project.id))?.steps.evidence.note, "查说明书");
  assert.deepEqual((await step({ step: "diagnosis", status: "done" })).issues.map((/** @type {any} */ issue) => issue.code), ["refused"]);
  assert.deepEqual((await step({ step: "questions", status: "done" })).issues.map((/** @type {any} */ issue) => issue.code), ["refused"]);
  assert.equal((await step({ step: "questions", status: "running" })).ok, true);
  assert.deepEqual((await step({ step: "evidence", status: "finished" })).issues.map((/** @type {any} */ issue) => issue.code), ["unknown_value"]);
  const steps = (await store.getProject(USER, project.id))?.steps;
  assert.deepEqual([steps?.evidence.status, steps?.diagnosis.status, steps?.questions.status], ["running", "none", "running"]);
});

test("journey, strategy and placement preferences are versions, and each refused entry is named", options, async () => {
  const project = await measured(await freshProject());
  const journey = await write(project, "journey", { data: {
    subtypes: [{ name: "单纯性肥胖", size: 12000000 }, { size: "no name" }],
    stages: [{ stage: "确诊前", emotion: "焦虑", questions: ["减肥针安全吗"], infoSources: ["小红书"] }],
    careNodes: [{ node: "起始用药", redFlags: ["持续剧烈腹痛"] }],
    files: [{ path: "deliverables/journey.xlsx", title: "完整旅程矩阵" }, { path: "/etc/x" }],
  } });
  assert.equal(journey.version, 1);
  assert.deepEqual(journey.issues.map((/** @type {any} */ issue) => [issue.index, issue.field, issue.code]), [[1, "name", "missing"], [1, "path", "invalid"]]);
  const saved = await store.latestJourney(project.id);
  assert.equal(saved?.data.subtypes[0].size, "12000000");
  assert.equal(saved?.data.stages[0].questions[0], "减肥针安全吗");

  const strategy = await write(project, "strategy", { data: {
    battlefield: { groups: ["语义群 1"], reason: "证据最硬" },
    expectations: [{ engine: "deepseek", promise: "讲对", layers: ["anchor"] }, { engine: "bing", promise: "x" }],
    gaps: [{ class: "benefit_only", text: "只讲减重不讲胃肠反应" }, { class: "vibes", text: "x" }],
    layout: { doubao: { coverage: ["toutiao.com"], owned: ["douyin.com"] }, bing: { anchor: [] } },
    sources: [{ domain: "39.net", layer: "coverage" }, { domain: "bad host" }],
    summary: "先守千问，再攻豆包",
  } });
  assert.equal(strategy.version, 1);
  assert.equal(strategy.sourceIds.length, 1);
  assert.deepEqual(strategy.issues.map((/** @type {any} */ issue) => issue.code), ["unknown_value", "unknown_value", "unknown_value", "invalid"]);
  const latest = await store.latestStrategy(project.id);
  assert.deepEqual(latest?.expectations.map((/** @type {any} */ entry) => entry.engine), ["deepseek"]);
  assert.deepEqual(Object.keys(latest?.layout ?? {}), ["doubao"]);
  assert.equal((await write(project, "strategy", { data: { summary: "second" } })).version, 2);

  const plan = await write(project, "placement_plan", { data: { preferred: [{ layer: "coverage", engines: ["doubao"], outlets: ["39.net"] }, { engines: ["bing"] }],
    avoid: ["fake-times.cn"] } });
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.issues.map((/** @type {any} */ issue) => [issue.index, issue.code]), [[1, "unknown_value"]]);
  assert.deepEqual((await store.latestPlacementPlan(project.id))?.data.avoid, ["fake-times.cn"]);
});

test("a claim keeps the reader's name for its source, from the method's sourceRefLabel", options, async () => {
  const project = await freshProject();
  await write(project, "claims", { items: [{ claimKey: "id", statement: "s", quote: "q", sourceRef: "web-page:e1edc04a1ac28750",
    sourceRefLabel: "玛仕度肽注射液说明书（国家药监局 2025）", sourceKind: "label" }] });
  const [claim] = await store.listClaims(project.id);
  assert.equal(claim.sourceRef, "web-page:e1edc04a1ac28750");
  assert.equal(claim.sourceLabel, "玛仕度肽注射液说明书（国家药监局 2025）");
});

test("no strategy, tiers or 信源 step before the project has a finished baseline", options, async () => {
  const project = await freshProject();
  const strategy = await write(project, "strategy", { data: { summary: "早了" } });
  assert.equal(strategy.ok, false);
  assert.deepEqual(strategy.issues.map((/** @type {any} */ issue) => issue.code), ["baseline_missing"]);
  const targets = await write(project, "targets", { items: [{ tier: "2", metricId: "M-19", target: 30, dataType: "forecast" }] });
  assert.equal(targets.ok, false);
  const step = await write(project, "step", { data: { step: "sources", status: "done" } });
  assert.equal(step.ok, false);
  assert.equal(await store.latestStrategy(project.id), null);
  await measured(project);
  assert.equal((await write(project, "strategy", { data: { summary: "测完了" } })).ok, true);
});

test("factual accuracy is a hard line of 98 % in every tier", options, async () => {
  const project = await measured(await freshProject());
  const result = await write(project, "targets", { items: [
    { tier: "1", metricId: "M-06", pool: "P1", baseline: 67.6, target: 76, dataType: "forecast" },
    { tier: "2", metricId: "M-06", pool: "P1", baseline: 67.6, target: 98, dataType: "forecast" },
    { tier: "2", metricId: "M-01", pool: "P2", baseline: 12.5, target: 20, dataType: "forecast" },
  ] });
  assert.deepEqual(result.issues.filter((/** @type {any} */ issue) => issue.code !== "notice").map((/** @type {any} */ issue) => [issue.index, issue.code]),
    [[0, "below_hard_line"]]);
  assert.deepEqual((await store.latestTargets(project.id))?.rows.map((row) => [row.tier, row.metricId, row.target]).sort(),
    [["2", "M-01", 20], ["2", "M-06", 98]]);
});
