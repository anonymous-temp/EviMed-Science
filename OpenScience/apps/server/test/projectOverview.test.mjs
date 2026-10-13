// The top of the memory page's 项目 tab (2026-10-12): the card, what the project did and what it delivered.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { capabilityUse, projectCard, projectWorks } from "../src/projectOverview.mjs";
import { createMemoryRoutes } from "../src/memoryRoutes.mjs";
import { createWebApiApp } from "../src/server.mjs";

const memory = (key, value, extra = {}) => ({
  id: `rec_${key.replace(/\W+/g, "_")}_${extra.kind ?? "project_fact"}`, scope: "project", scopeId: "prj_1", kind: "project_fact", key, value, summary: `句：${value}`,
  status: "active", sensitive: false, createdAt: "2026-10-01T02:00:00Z", updatedAt: "2026-10-01T02:00:00Z", ...extra,
});

test("the card is the project's slots in the order it reads, only the ones stated, by key and by nothing else", () => {
  const card = projectCard([
    memory("project.outcome", "大出血"),
    memory("project.field", "心血管"),
    memory("project.population", "75 岁以上房颤患者"),
    // Not slots: a key the model made up, a user-scope fact, a preference.
    memory("project.af_cohort.design", "回顾性队列"),
    memory("project.design", "队列", { scope: "user", scopeId: "" }),
    memory("project.comparator", "华法林", { kind: "preference" }),
  ]);
  assert.deepEqual(card.map((slot) => [slot.slot, slot.text]), [["field", "心血管"], ["population", "75 岁以上房颤患者"], ["outcome", "大出血"]]);
  assert.ok(card.every((slot) => slot.recordId.startsWith("rec_")), "each slot names the memory it opens");
});

test("the card is for any kind of work: the general slots first, a study's elements only when stated, and the extras of another kind of work after them", () => {
  const card = projectCard([
    // A software refactor: general slots, a field no medical list holds, and extras with and without a word of their own.
    memory("project.constraints", "十一月底前必须切完", { updatedAt: "2026-10-01T02:00:00Z" }),
    memory("project.goal", "把单体拆成三个服务"),
    memory("project.field", "后端架构、支付系统"),
    memory("project.subject", "支付服务"),
    memory("project.ext.interface", "对外接口保持不变", { updatedAt: "2026-10-03T02:00:00Z" }),
    memory("project.ext.release_train", "每两周一个发布窗口", { updatedAt: "2026-10-02T02:00:00Z", summary: "团队每两周一个发布窗口。" }),
    // Not extras: a name of the wrong shape, a nested key, a user-scoped fact.
    memory("project.ext.Bad Name", "x"),
    memory("project.ext.a.b", "x"),
    memory("project.ext.audience", "读者", { scope: "user", scopeId: "" }),
  ]);
  assert.deepEqual(card.map((row) => [row.slot, row.label, row.text]), [
    ["field", "领域", "后端架构、支付系统"],
    ["goal", "目标", "把单体拆成三个服务"],
    ["subject", "范围或对象", "支付服务"],
    ["constraints", "约束", "十一月底前必须切完"],
    // An extra the card has a word for is that word and the value; one it has none for is the sentence its memory states.
    ["ext.release_train", null, "团队每两周一个发布窗口。"],
    ["ext.interface", "接口", "对外接口保持不变"],
  ]);
  // A project that stated nothing has an empty card, and no clinical element is listed as missing.
  assert.deepEqual(projectCard([memory("project.glory1.dose", "20 mg")]), []);
});

test("a study's elements are on the card only when the researcher stated them, in the order a study is described", () => {
  const card = projectCard([
    memory("project.design", "回顾性队列"),
    memory("project.outcome", "大出血"),
    memory("project.population", "75 岁以上非瓣膜性房颤患者"),
    memory("project.goal", "比较新型口服抗凝药和华法林的大出血风险"),
  ]);
  assert.deepEqual(card.map((row) => [row.slot, row.label]), [["goal", "目标"], ["population", "人群"], ["outcome", "结局"], ["design", "设计"]]);
});

test("a replaced, forgotten or sensitive memory is not on the card, the newest of a fact and a decision is, and a text is bounded", () => {
  const card = projectCard([
    memory("project.design", "旧设计", { status: "superseded" }),
    memory("project.stage", "已忘记", { status: "archived" }),
    memory("project.data_source", "敏感来源", { sensitive: true }),
    memory("project.comparator", "旧对照", { updatedAt: "2026-10-01T02:00:00Z" }),
    memory("project.comparator", "新对照（决定）", { kind: "decision", updatedAt: "2026-10-05T02:00:00Z" }),
    memory("project.population", "长".repeat(500)),
  ]);
  assert.deepEqual(card.map((slot) => slot.slot), ["population", "comparator"]);
  assert.equal(card.find((slot) => slot.slot === "comparator")?.text, "新对照（决定）");
  assert.ok(card.find((slot) => slot.slot === "population").text.length <= 200);
  assert.deepEqual(projectCard([]), []);
  assert.deepEqual(projectCard(null), []);
});

const run = (id, agent, extra = {}) => ({
  id, status: "succeeded", effectiveAgentId: agent, agentId: agent, startedAt: "2026-10-10T02:00:00.000Z", finishedAt: "2026-10-10T02:30:00.000Z",
  title: `题 ${id}`, artifacts: [], ...extra,
});

test("the capabilities that answered the researcher's own conversations, by their product name, the most used first", () => {
  const runs = [
    run("r1", "comprehensive-drug-evaluation"), run("r2", "comprehensive-drug-evaluation"), run("r3", "open-domain-answer"),
    run("r4", "statistical-analysis"), run("r5", "statistical-analysis"), run("r6", "statistical-analysis"),
    // Not theirs, not done, not named, the platform's own, deleted.
    run("m1", "meta-analysis", { automated: true }),
    run("m2", "meta-analysis", { effectiveRouteReason: "autopilot:research" }),
    run("f1", "meta-analysis", { status: "failed" }),
    run("f2", "meta-analysis", { status: "running" }),
    run("u1", "agent-nobody-named"),
    run("i1", "source-understanding"),
    run("d1", "peer-review", { deleted: true }),
  ];
  const use = capabilityUse(runs, (agent) => agent === "source-understanding");
  assert.deepEqual(use.map((row) => [row.title, row.count]), [["统计分析", 3], ["综合药品评价", 2], ["普通问答", 1]]);
  assert.deepEqual(capabilityUse([]), []);
});

test("the works are the files of the runs, one per deliverable, by month in the researcher's zone, newest first", () => {
  const describe = (current) => ({
    artifactKinds: Object.fromEntries((current.artifacts ?? []).concat(current.unverifiedArtifacts ?? []).map((path) => [path, path.includes("/work/") || path.includes("revision") ? "work" : "deliverable"])),
    artifactRoles: ({
      "deliverables/clinical-evidence/report.md": "report", "deliverables/clinical-evidence/evidence-matrix.json": "matrix",
      "deliverables/clinical-evidence/delivery-summary.md": "document", "deliverables/clinical-evidence/work/notes.md": "document",
      "deliverables/review/review.docx": "document", "report.md": "report",
    }),
  });
  const runs = [
    run("r1", "clinical-evidence-synthesis", {
      title: "阿司匹林二级预防", finishedAt: "2026-10-10T02:30:00.000Z",
      artifacts: ["deliverables/clinical-evidence/delivery-summary.md", "deliverables/clinical-evidence/report.md", "deliverables/clinical-evidence/evidence-matrix.json",
        "deliverables/clinical-evidence/work/notes.md"],
    }),
    // Delivered with findings: still delivered.
    run("r2", "peer-review", { title: "审稿意见", finishedAt: "2026-09-30T17:00:00.000Z", artifacts: [], unverifiedArtifacts: ["deliverables/review/review.docx"] }),
    // A run that wrote nothing a reader opens, and one that did not finish, are not works.
    run("r3", "open-domain-answer", { title: "只回答", artifacts: [] }),
    run("r4", "clinical-evidence-synthesis", { status: "failed", artifacts: ["deliverables/clinical-evidence/report.md"] }),
    run("r5", "meta-analysis", { title: "机器的活", automated: true, artifacts: ["report.md"] }),
  ];
  const months = projectWorks(runs, { describe, timeZone: "Asia/Shanghai" });
  // 2026-09-30 17:00Z is already 10-01 in Shanghai.
  assert.deepEqual(months.map((group) => [group.month, group.items.map((item) => [item.title, item.path, item.name])]), [
    ["2026-10", [
      ["阿司匹林二级预防", "deliverables/clinical-evidence/report.md", "report.md"],
      ["审稿意见", "deliverables/review/review.docx", "review.docx"],
    ]],
  ]);
  const utc = projectWorks(runs, { describe, timeZone: "UTC" });
  assert.deepEqual(utc.map((group) => group.month), ["2026-10", "2026-09"], "the same files fall in the months of the zone asked for");
  for (const item of months.flatMap((group) => group.items)) {
    assert.ok(item.runId && item.at, "a work names its run and its day");
    assert.equal(JSON.stringify(item).includes("已交付"), false);
  }
  assert.deepEqual(projectWorks([], { describe }), []);
  assert.equal(projectWorks(runs, { describe, limit: 1 }).flatMap((group) => group.items).length, 1);
  assert.throws(() => projectWorks(runs, { describe, timeZone: "Mars/Olympus" }), { code: "memory_timeline_invalid" });
});

// ---- the route ----

const response = () => {
  const out = { status: 0, body: null };
  return { out, res: { writeHead: (status) => { out.status = status; }, end: (body) => { out.body = JSON.parse(body); } } };
};

function routes({ records = [], settings = { pausedProjects: [] }, projects = ["prj_1"], work = undefined, links = [] } = {}) {
  const calls = { requireProject: [], listed: [], work: [] };
  const route = createMemoryRoutes({
    config: { publicUrl: "http://evimed.test" },
    researchMemory: {
      async listAllRecords(userId, filters) { calls.listed.push([userId, filters]); return records.filter((record) => record.scopeId === filters.scopeId); },
      async settings() { return settings; },
      async getRecord(_userId, id) { if (id !== "rec_1") throw Object.assign(new Error("Memory not found."), { status: 404, code: "memory_not_found" }); return { id }; },
      async sourceLinks() { return links; },
    },
    store: { async requireProject(user, id) { calls.requireProject.push([user.id, id]); if (!projects.includes(id)) throw Object.assign(new Error("Project not found."), { status: 404, code: "project_not_found" }); return { id }; } },
    projectWork: work === undefined ? async (_user, project, options) => { calls.work.push([project.id, options]); return { capabilities: [{ id: "statistical-analysis", title: "统计分析", count: 2 }], works: [] }; } : work,
    context: async () => ({ user: { id: "alice" }, project: { id: "prj_current" } }),
    feedbackEvents: {}, audit: async () => {}, recordFeedback: async () => {}, decodeRouteComponent: decodeURIComponent,
  });
  return { route, calls };
}

test("the overview of a project: its card, its pause and the ledger's two lists, after the project is proved the account's", async () => {
  const { route, calls } = routes({
    records: [memory("project.field", "心血管"), memory("project.population", "房颤患者"), memory("project.population", "别的项目", { scopeId: "prj_2" })],
    settings: { pausedProjects: ["prj_1"] },
  });
  const { out, res } = response();
  assert.equal(await route({ method: "GET", url: "/api/memory/projects/prj_1/overview?timeZone=Asia%2FShanghai", headers: {} }, res), true);
  assert.equal(out.status, 200);
  assert.deepEqual(calls.requireProject, [["alice", "prj_1"]]);
  assert.deepEqual(calls.listed[0], ["alice", { scopes: ["project"], kinds: ["project_fact", "decision"], statuses: ["active"], scopeId: "prj_1" }]);
  assert.deepEqual(calls.work, [["prj_1", { timeZone: "Asia/Shanghai" }]]);
  assert.equal(out.body.data.projectId, "prj_1");
  assert.equal(out.body.data.paused, true);
  assert.deepEqual(out.body.data.card.map((slot) => slot.slot), ["field", "population"]);
  assert.deepEqual(out.body.data.capabilities, [{ id: "statistical-analysis", title: "统计分析", count: 2 }]);
  assert.equal(out.body.data.timeZone, "Asia/Shanghai");
});

test("a project that is not the account's is a 404 and its memories are never read; a bad zone is refused", async () => {
  const { route, calls } = routes();
  await assert.rejects(() => route({ method: "GET", url: "/api/memory/projects/prj_other/overview", headers: {} }, response().res), { status: 404, code: "project_not_found" });
  assert.deepEqual(calls.listed, []);
  await assert.rejects(() => route({ method: "GET", url: "/api/memory/projects/prj_1/overview?timeZone=Mars%2FOlympus", headers: {} }, response().res), { code: "memory_timeline_invalid" });
  const post = response();
  assert.equal(await route({ method: "POST", url: "/api/memory/projects/prj_1/overview", headers: {} }, post.res), false, "read-only: nothing else answers a write");
});

test("a ledger that cannot be read leaves the card, and a deployment with no ledger reader leaves empty lists (principle 19)", async () => {
  const records = [memory("project.design", "回顾性队列")];
  for (const work of [async () => { throw new Error("ledger"); }, null]) {
    const { route } = routes({ records, work });
    const { out, res } = response();
    await route({ method: "GET", url: "/api/memory/projects/prj_1/overview", headers: {} }, res);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.card.map((slot) => slot.slot), ["design"]);
    assert.deepEqual([out.body.data.capabilities, out.body.data.works, out.body.data.paused], [[], [], false]);
  }
});

test("the sources of a memory: the record is the account's or a 404, and only type, id and state leave", async () => {
  const links = [{ type: "knowledge_source", id: "src_abc", version: "v1", state: "current", stateReason: "x", stateAt: null, linkedAt: null }];
  const { route } = routes({ links });
  const { out, res } = response();
  await route({ method: "GET", url: "/api/memory/records/rec_1/sources", headers: {} }, res);
  assert.deepEqual(out.body.data, [{ type: "knowledge_source", id: "src_abc", state: "current" }]);
  await assert.rejects(() => route({ method: "GET", url: "/api/memory/records/rec_other/sources", headers: {} }, response().res), { status: 404 });
});

test("the server composes the overview from the memory store and the project's own run ledger", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-project-overview-"));
  const researchMemory = {
    configured: true,
    async status() { return { configured: true, connected: true, code: null, structured: true }; },
    async listAllRecords() { return [memory("project.design", "回顾性队列", { scopeId: "default" })]; },
    async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
  };
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, researchMemory });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const read = await fetch(`${base}/api/memory/projects/default/overview?timeZone=UTC`);
    assert.equal(read.status, 200, await read.clone().text());
    const { data } = await read.json();
    assert.equal(data.projectId, "default");
    assert.deepEqual(data.card.map((slot) => slot.slot), ["design"]);
    assert.deepEqual([data.capabilities, data.works], [[], []], "a project with no run has done and delivered nothing");
    const missing = await fetch(`${base}/api/memory/projects/nobody-has-this/overview`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});
