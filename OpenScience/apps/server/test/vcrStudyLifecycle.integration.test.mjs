// 「虚拟临研」's study lifecycle on PostgreSQL (R10): 「新建研究」 makes a draft that is not on the list, the first definition names it
// and makes it active, a draft nobody spoke in is swept an hour later, and the page's 「对话」 is the conversation the study was opened with.
//
// A real database, because the rules are statements over rows: the list excludes `draft`, the name is unique per account, and the sweep
// is a query on age and status.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Readable } from "node:stream";
import pg from "pg";
import { VCR_DRAFT_STUDY_NAME, VCR_LEGACY_DEFAULT_STUDY_NAME } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore, vcrStudyNameFrom } from "../src/vcrStore.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { createVcrDraftSweeper } from "../src/vcrDrafts.mjs";
import { applyStudyNames, planStudyNames } from "../src/vcrNaming.mjs";
import { createVcrRoutes } from "../src/vcrRoutes.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {VcrStore} */
let store;
/** @type {VcrService} */
let service;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

const config = { vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 100_000, vcrMaxConcurrentJobs: 2, vcrLeaseMs: 900_000, vcrDataPlaneDir: "" };

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrlife_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
  service = new VcrService({ store, config });
});

after(async () => {
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

/** The two hooks 「新建研究」 needs, as doubles: a project that exists, a session that binds. @param {string} sessionId */
function hooksFor(sessionId, projectId = `prj_${randomUUID().slice(0, 8)}`) {
  return {
    createResearcherProject: async (/** @type {any} */ _user, /** @type {string} */ name) => ({ id: projectId, name }),
    bindSession: async () => ({ sessionId, bound: true }),
  };
}

test("the study's name comes from its definition: the title, else the first words of the question, else what the definition states", () => {
  assert.equal(vcrStudyNameFrom({ title: "  GLP-1 心血管结局试验  ", question: "别的话" }), "GLP-1 心血管结局试验");
  assert.equal(vcrStudyNameFrom({ question: "二线 NSCLC 单臂 II 期，ORR 目标 25%，要多少例？" }), "二线 NSCLC 单臂 II 期，ORR 目标");
  assert.equal(vcrStudyNameFrom({ question: "能不能用外部对照？？" }), "能不能用外部对照");
  assert.equal(vcrStudyNameFrom({ title: "", question: "   " }), null, "nothing to name it from keeps the name it has");
  assert.equal([...(vcrStudyNameFrom({ title: "长".repeat(80) }) ?? "")].length, 40, "a name is the project's length at most");
});

test("「新建研究」 makes a draft called 未命名研究: not on the list, hidden from the sidebar's projects, opened with its conversation", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const created = await service.createStudy(user, {}, hooksFor("vcr-first", "prj_draft_a"));
  assert.equal(created.status, "draft");
  assert.equal(created.name, VCR_DRAFT_STUDY_NAME);
  assert.equal(created.sessionId, "vcr-first");

  const row = await store.getStudy(user.id, created.id);
  assert.equal(row?.status, "draft");
  assert.equal(row?.conversationSessionId, "vcr-first", "the conversation the study was opened with is recorded on the row");
  // Written once: a later call does not move it.
  assert.equal(await store.setConversationSession(created.id, "vcr-second"), null);
  assert.equal((await store.getStudy(user.id, created.id))?.conversationSessionId, "vcr-first");

  const home = await service.listStudies(user);
  assert.deepEqual(home.studies, [], "a draft is not a study of the list");
  assert.deepEqual(home.draftProjectIds, ["prj_draft_a"], "the sidebar leaves its project out");
  // The orchestrator walks active studies only: nothing is scheduled before a person has spoken.
  assert.equal((await store.activeStudies(500)).some((study) => study.id === created.id), false);
  // But the study can be opened by id: the conversation's runtime reads it.
  assert.equal((await service.requireStudy(user, created.id)).id, created.id);
});

test("a caller that says what the study is gets an active study at once, named from it", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const created = await service.createStudy(user, { question: "糖尿病情景人群生成是否可行？" }, hooksFor("vcr-q"));
  assert.equal(created.status, "active");
  assert.equal(created.name, "糖尿病情景人群生成是否可行");
  const home = await service.listStudies(user);
  assert.equal(home.studies.length, 1);
  assert.deepEqual(home.draftProjectIds, []);
});

test("the first definition names a draft, writes the question back and makes it active; a later one never renames it", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const created = await service.createStudy(user, {}, hooksFor("vcr-n"));
  /** @type {Array<{ previousName: string, name: string, status: string }>} */
  const events = [];
  store.onStudyNamed = async ({ study, previousName }) => { events.push({ previousName, name: study.name, status: study.status }); };
  try {
    await store.saveDefinition({
      studyId: created.id, userId: user.id, pico: { population: "成人 2 型糖尿病", intervention: "GLP-1" }, estimand: {},
      title: "GLP-1 心血管结局试验的样本量", question: "MACE 终点、HR 0.80，固定设计还是成组序贯？",
    });
    const named = await store.getStudy(user.id, created.id);
    assert.equal(named?.name, "GLP-1 心血管结局试验的样本量");
    assert.equal(named?.status, "active");
    assert.equal(named?.question, "MACE 终点、HR 0.80，固定设计还是成组序贯？", "the question lands on the row when the row had none");
    assert.deepEqual(events, [{ previousName: VCR_DRAFT_STUDY_NAME, name: "GLP-1 心血管结局试验的样本量", status: "active" }], "the project is told once");
    const home = await service.listStudies(user);
    assert.equal(home.studies.length, 1, "now it is on the list");
    assert.deepEqual(home.draftProjectIds, []);

    await store.saveDefinition({ studyId: created.id, userId: user.id, pico: { population: "别的" }, title: "另一个名字" });
    assert.equal((await store.getStudy(user.id, created.id))?.name, "GLP-1 心血管结局试验的样本量", "a study that has a name keeps it");
    assert.equal(events.length, 1);
  } finally {
    store.onStudyNamed = null;
  }
});

test("with no title the name is the first 24 characters of the question; with neither, what the definition states", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const a = await service.createStudy(user, {}, hooksFor("vcr-a"));
  await store.saveDefinition({ studyId: a.id, userId: user.id, pico: { population: "x" }, question: "二线 NSCLC 单臂 II 期，ORR 目标 25%，要多少例？这是一个很长的问题" });
  assert.equal((await store.getStudy(user.id, a.id))?.name, "二线 NSCLC 单臂 II 期，ORR 目标");
  const b = await service.createStudy(user, {}, hooksFor("vcr-b"));
  await store.saveDefinition({ studyId: b.id, userId: user.id, pico: { population: "成人 2 型糖尿病", intervention: "二甲双胍" } });
  const named = await store.getStudy(user.id, b.id);
  assert.equal(named?.name, "成人 2 型糖尿病 二甲双胍");
  assert.equal(named?.status, "active");
});

test("a second study of a name the account already has takes the day it was made; two on one day take a number", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const one = await service.createStudy(user, {}, hooksFor("vcr-d1"));
  await store.saveDefinition({ studyId: one.id, userId: user.id, pico: { population: "x" }, title: "波立维方案比较" });
  const two = await service.createStudy(user, {}, hooksFor("vcr-d2"));
  await store.saveDefinition({ studyId: two.id, userId: user.id, pico: { population: "x" }, title: "波立维方案比较" });
  const three = await service.createStudy(user, {}, hooksFor("vcr-d3"));
  await store.saveDefinition({ studyId: three.id, userId: user.id, pico: { population: "x" }, title: "波立维方案比较" });
  const names = (await store.listStudies(user.id)).map((study) => study.name).sort();
  assert.equal(names.length, 3);
  assert.ok(names.includes("波立维方案比较"));
  const dated = names.filter((name) => name !== "波立维方案比较");
  assert.match(dated[0], /^波立维方案比较 \d{1,2}月\d{1,2}日( 2)?$/);
  assert.match(dated[1], /^波立维方案比较 \d{1,2}月\d{1,2}日( 2)?$/);
  assert.notEqual(dated[0], dated[1]);
  // Another account's study of the same name is no reason to rename this one.
  const other = { id: `u_${randomUUID().slice(0, 8)}` };
  const stranger = await service.createStudy(other, {}, hooksFor("vcr-d4"));
  await store.saveDefinition({ studyId: stranger.id, userId: other.id, pico: { population: "x" }, title: "波立维方案比较" });
  assert.equal((await store.getStudy(other.id, stranger.id))?.name, "波立维方案比较");
});

test("a study made before drafts existed keeps its status and is named by its next definition", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const old = await store.createStudy({ userId: user.id, projectId: `prj_old_${randomUUID().slice(0, 6)}`, name: VCR_LEGACY_DEFAULT_STUDY_NAME });
  await store.updateStudy(old.id, { status: "paused" }, "test");
  await store.saveDefinition({ studyId: old.id, userId: user.id, pico: { population: "x" }, title: "旧研究的新名字" });
  const named = await store.getStudy(user.id, old.id);
  assert.equal(named?.name, "旧研究的新名字");
  assert.equal(named?.status, "paused", "naming never moves a study's status");
});

test("the ops script plans names for unnamed studies from what they hold, writes them on request, and a second run plans nothing", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const withQuestion = await store.createStudy({ userId: user.id, projectId: "prj_r1", name: VCR_LEGACY_DEFAULT_STUDY_NAME, question: "成人 2 型糖尿病情景人群" });
  const withDefinition = await store.createStudy({ userId: user.id, projectId: "prj_r2", name: VCR_LEGACY_DEFAULT_STUDY_NAME });
  // A definition written before naming existed leaves the name alone (the study is not a draft and has the legacy name: it is named
  // by that very write now), so the fixture writes it directly and puts the legacy name back.
  await store.saveDefinition({ studyId: withDefinition.id, userId: user.id, pico: { population: "幽门螺杆菌感染者", intervention: "铋剂四联" } });
  await store.updateStudy(withDefinition.id, { name: VCR_LEGACY_DEFAULT_STUDY_NAME }, "test");
  const nothing = await store.createStudy({ userId: user.id, projectId: "prj_r3", name: VCR_LEGACY_DEFAULT_STUDY_NAME });

  const plan = await planStudyNames({ store });
  const mine = plan.filter((entry) => entry.userId === user.id);
  assert.equal(mine.length, 3);
  assert.equal(mine.find((entry) => entry.studyId === withQuestion.id)?.to, "成人 2 型糖尿病情景人群");
  assert.equal(mine.find((entry) => entry.studyId === withDefinition.id)?.to, "幽门螺杆菌感染者 铋剂四联");
  assert.equal(mine.find((entry) => entry.studyId === nothing.id)?.to, null, "nothing to name it from: left as it is, and said so");
  assert.equal((await store.getStudy(user.id, withQuestion.id))?.name, VCR_LEGACY_DEFAULT_STUDY_NAME, "a report writes nothing");

  /** @type {Array<[string, string]>} */
  const renamed = [];
  const written = await applyStudyNames({
    store, plan: mine,
    renameProject: async (_user, projectId, name) => { renamed.push([projectId, name]); },
    currentProjectName: async () => VCR_LEGACY_DEFAULT_STUDY_NAME,
  });
  assert.deepEqual(written, { renamed: 2, projectsRenamed: 2, left: 1 });
  assert.deepEqual(renamed.map(([projectId]) => projectId).sort(), ["prj_r1", "prj_r2"]);
  assert.equal((await store.getStudy(user.id, withQuestion.id))?.name, "成人 2 型糖尿病情景人群");
  assert.deepEqual((await planStudyNames({ store })).filter((entry) => entry.userId === user.id).map((entry) => entry.studyId), [nothing.id], "idempotent");
});

test("the sweep deletes the drafts past their hour in which nobody spoke, keeps the others, and does it twice without harm", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const stale = await service.createStudy(user, {}, hooksFor("vcr-s1", "prj_stale"));
  const spoken = await service.createStudy(user, {}, hooksFor("vcr-s2", "prj_spoken"));
  const fresh = await service.createStudy(user, {}, hooksFor("vcr-s3", "prj_fresh"));
  const named = await service.createStudy(user, {}, hooksFor("vcr-s4", "prj_named"));
  await store.saveDefinition({ studyId: named.id, userId: user.id, pico: { population: "x" }, title: "已经有名字" });
  for (const id of [stale.id, spoken.id, named.id]) await store.query("UPDATE evimed_vcr.studies SET created_at = now() - interval '3 hours' WHERE id = $1", [id]);

  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const reported = [];
  const sweeper = createVcrDraftSweeper({
    store,
    spokenIn: async (study) => study.projectId === "prj_spoken",
    remove: async (study) => {
      removed.push(study.projectId);
      // The project's deletion takes the study with it, as the control plane's transaction does.
      await store.query("DELETE FROM evimed_vcr.studies WHERE id = $1", [study.id]);
    },
    report: (code) => reported.push(code),
  });
  const first = await sweeper.sweep();
  assert.deepEqual(first, { deleted: 1, kept: 1, failed: 0 });
  assert.deepEqual(removed, ["prj_stale"]);
  assert.ok(reported.some((code) => code === `vcr_draft_deleted:${stale.id}`), "every deletion is logged");
  assert.equal(await store.getStudy(user.id, stale.id), null);
  assert.equal((await store.getStudy(user.id, spoken.id))?.status, "draft", "a draft somebody spoke in is kept whatever its age");
  assert.equal((await store.getStudy(user.id, fresh.id))?.status, "draft", "inside its hour");
  assert.equal((await store.getStudy(user.id, named.id))?.status, "active", "a named study is never a draft's business");
  assert.deepEqual(await sweeper.sweep(), { deleted: 0, kept: 1, failed: 0 }, "idempotent");
});

test("a sweep that cannot read the ledger keeps the draft, and one whose delete fails tries again next time", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const study = await service.createStudy(user, {}, hooksFor("vcr-k", "prj_keep"));
  await store.query("UPDATE evimed_vcr.studies SET created_at = now() - interval '2 hours' WHERE id = $1", [study.id]);
  /** @type {string[]} */
  const reported = [];
  const unreadable = createVcrDraftSweeper({ store, spokenIn: async () => { throw Object.assign(new Error("down"), { code: "ledger_down" }); }, remove: async () => { throw new Error("must not run"); }, report: (code) => reported.push(code) });
  const unread = await unreadable.sweep();
  assert.equal(unread.deleted, 0);
  assert.equal(unread.failed, 0);
  assert.ok(unread.kept >= 1, "the draft is kept, as is every other the ledger could not vouch for");
  assert.ok(reported.some((code) => code === `vcr_draft_ledger_unreadable:${study.id}:ledger_down`));
  const refusing = createVcrDraftSweeper({ store, spokenIn: async () => false, remove: async () => { throw Object.assign(new Error("no"), { code: "refused" }); }, report: (code) => reported.push(code) });
  const refused = await refusing.sweep();
  assert.equal(refused.deleted, 0);
  assert.ok(refused.failed >= 1, "a delete that fails is counted and tried again next sweep");
  assert.equal((await store.getStudy(user.id, study.id))?.status, "draft");
});

test("the drafts' age is the config's: a sweeper takes its ttl, and refuses one under a minute", () => {
  assert.throws(() => createVcrDraftSweeper({ store: { draftsOlderThan: async () => [] }, spokenIn: async () => false, remove: async () => {}, ttlMs: 1_000 }), /at least a minute/);
});

/** Drive the routes the page calls, with the doubles the platform's store would be. @param {{ id: string }} user */
function routeFor(user, extra = {}) {
  /** @type {any[]} */
  const projectCalls = [];
  const handler = createVcrRoutes({
    store: { ensureSessionUser: async () => ({ user }), assertCsrf: async () => {} },
    vcrStore: store, service, config, maxJsonBytes: 1_000_000,
    projects: {
      create: async () => ({ id: "unused", name: "unused" }),
      bindSession: async () => ({ sessionId: "bound", bound: true }),
      latestSessionId: async () => "newest-run-session",
      conversationSessionId: async () => "oldest-vcr-protocol-session",
      backgroundRuns: async (_userId, _projectId, own) => [
        { sessionId: "run-evidence", capabilityId: "vcr-evidence", status: "succeeded", startedAt: "2026-10-07T01:00:00.000Z" },
        { sessionId: "run-analysis", capabilityId: "vcr-analysis", status: "running", startedAt: "2026-10-07T02:00:00.000Z" },
        ...(own ? [] : []),
      ],
      rename: async (...args) => { projectCalls.push(["rename", ...args.slice(1)]); },
      ...extra,
    },
  });
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const call = async (method, path, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
      { method, url: path, headers: { "content-type": "application/json" } });
    const res = { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; }, end(/** @type {string} */ chunk = "") { this.body = String(chunk); } };
    try {
      await handler(req, res);
    } catch (error) {
      return { status: /** @type {any} */ (error).status ?? 500, code: /** @type {any} */ (error).code, body: null };
    }
    return { status: res.status, code: undefined, body: res.body ? JSON.parse(res.body).data : null };
  };
  return { call, projectCalls };
}

test("the page's 对话 is the conversation the study was opened with, not the newest background run's", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const created = await service.createStudy(user, { question: "有对话的研究" }, hooksFor("vcr-own", "prj_conv"));
  const { call } = routeFor(user);
  const view = await call("GET", `/api/vcr/studies/${created.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.sessionId, "vcr-own");
  assert.equal(view.body.conversationSessionId, undefined, "the route resolves it; the page reads sessionId");
  assert.ok(["missing", "wired", "answering", "not_answering"].includes(view.body.engine), "the page's one line at the top reads this");

  // A study made before the conversation was recorded: the oldest one bound to its first capability, then the newest.
  const legacy = await store.createStudy({ userId: user.id, projectId: "prj_legacy", name: "旧研究" });
  assert.equal((await call("GET", `/api/vcr/studies/${legacy.id}`)).body.sessionId, "oldest-vcr-protocol-session");
  const { call: noOldest } = routeFor(user, { conversationSessionId: async () => null });
  assert.equal((await noOldest("GET", `/api/vcr/studies/${legacy.id}`)).body.sessionId, "newest-run-session");
});

test("AI 运行 lists the background runs by capability title and state, never by id", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const created = await service.createStudy(user, { question: "有后台运行的研究" }, hooksFor("vcr-bg", "prj_bg"));
  const { call } = routeFor(user);
  const answer = await call("GET", `/api/vcr/studies/${created.id}/runs`);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.runs.length, 2);
  assert.deepEqual(answer.body.runs.map((/** @type {any} */ run) => run.state), ["finished", "running"]);
  for (const run of answer.body.runs) {
    assert.equal(typeof run.label, "string");
    assert.ok(run.label.length > 0);
    assert.equal(run.runId, undefined);
    assert.equal(typeof run.sessionId, "string", "the row opens the conversation it ran in");
  }
  assert.equal((await call("GET", "/api/vcr/studies/std_nobody/runs")).status, 404);
});

test("renaming a study renames its project when the project still carries the old name, and refuses a name that is not one line", options, async () => {
  const user = { id: `u_${randomUUID().slice(0, 8)}` };
  const created = await service.createStudy(user, { name: "旧名字" }, hooksFor("vcr-rn", "prj_rn"));
  const { call, projectCalls } = routeFor(user);
  const renamed = await call("PATCH", `/api/vcr/studies/${created.id}`, { name: "新名字" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "新名字");
  assert.deepEqual(projectCalls, [["rename", "prj_rn", "新名字", "旧名字"]], "the project is asked with the old name so it can tell whether the researcher renamed it");
  assert.equal((await store.getStudy(user.id, created.id))?.name, "新名字");
  assert.equal((await call("PATCH", `/api/vcr/studies/${created.id}`, { name: "   " })).status, 400);
  assert.equal((await call("PATCH", `/api/vcr/studies/${created.id}`, { name: "长".repeat(41) })).status, 400);
  // A person moves a study between the user's states; `draft` is the platform's.
  assert.equal((await call("PATCH", `/api/vcr/studies/${created.id}`, { status: "draft" })).status, 400);
  assert.equal((await call("PATCH", `/api/vcr/studies/${created.id}`, { status: "paused" })).status, 200);
});
