// The top of the memory page's 项目 tab (2026-10-12): the card (the engine's project-context file, tested with the store), what the project did and what it delivered.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { capabilityUse, projectWorks } from "../src/projectOverview.mjs";
import { createMemoryRoutes } from "../src/memoryRoutes.mjs";
import { createWebApiApp } from "../src/server.mjs";

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

function routes({ card = [], settings = { pausedProjects: [] }, projects = ["prj_1"], work = undefined, links = [], configured = true } = {}) {
  const calls = { requireProject: [], cards: [], work: [] };
  const route = createMemoryRoutes({
    config: { publicUrl: "http://evimed.test" },
    memorySettings: { async settings() { return settings; } },
    nativeMemory: {
      configured,
      async projectCard(userId, projectId) { calls.cards.push([userId, projectId]); return card; },
      async sourceLinks(_userId, id) { if (id !== "rec_1") throw Object.assign(new Error("Memory not found."), { status: 404, code: "memory_not_found" }); return links; },
    },
    store: { async requireProject(user, id) { calls.requireProject.push([user.id, id]); if (!projects.includes(id)) throw Object.assign(new Error("Project not found."), { status: 404, code: "project_not_found" }); return { id }; } },
    projectWork: work === undefined ? async (_user, project, options) => { calls.work.push([project.id, options]); return { capabilities: [{ id: "statistical-analysis", title: "统计分析", count: 2 }], works: [] }; } : work,
    context: async () => ({ user: { id: "alice" }, project: { id: "prj_current" } }),
    feedbackEvents: {}, audit: async () => {}, recordFeedback: async () => {}, decodeRouteComponent: decodeURIComponent,
  });
  return { route, calls };
}

const slot = (name, text) => ({ slot: name, label: null, recordId: `native:viking://user/memories/project_context/prj_1.md#${name}`, text, updatedAt: "2026-10-01T02:00:00Z" });

test("the overview of a project: the engine's card, its pause and the ledger's two lists, after the project is proved the account's", async () => {
  const card = [slot("field", "心血管"), slot("population", "房颤患者")];
  const { route, calls } = routes({ card, settings: { pausedProjects: ["prj_1"] } });
  const { out, res } = response();
  assert.equal(await route({ method: "GET", url: "/api/memory/projects/prj_1/overview?timeZone=Asia%2FShanghai", headers: {} }, res), true);
  assert.equal(out.status, 200);
  assert.deepEqual(calls.requireProject, [["alice", "prj_1"]]);
  assert.deepEqual(calls.cards, [["alice", "prj_1"]]);
  assert.deepEqual(calls.work, [["prj_1", { timeZone: "Asia/Shanghai" }]]);
  assert.equal(out.body.data.projectId, "prj_1");
  assert.equal(out.body.data.paused, true);
  assert.deepEqual(out.body.data.card.map((row) => row.slot), ["field", "population"]);
  assert.deepEqual(out.body.data.capabilities, [{ id: "statistical-analysis", title: "统计分析", count: 2 }]);
  assert.equal(out.body.data.timeZone, "Asia/Shanghai");
});

test("a project that is not the account's is a 404 and its card is never read; a bad zone is refused", async () => {
  const { route, calls } = routes();
  await assert.rejects(() => route({ method: "GET", url: "/api/memory/projects/prj_other/overview", headers: {} }, response().res), { status: 404, code: "project_not_found" });
  assert.deepEqual(calls.cards, []);
  await assert.rejects(() => route({ method: "GET", url: "/api/memory/projects/prj_1/overview?timeZone=Mars%2FOlympus", headers: {} }, response().res), { code: "memory_timeline_invalid" });
  const post = response();
  assert.equal(await route({ method: "POST", url: "/api/memory/projects/prj_1/overview", headers: {} }, post.res), false, "read-only: nothing else answers a write");
});

test("a ledger that cannot be read leaves the card, and a deployment with no ledger reader leaves empty lists (principle 19)", async () => {
  const card = [slot("design", "回顾性队列")];
  for (const work of [async () => { throw new Error("ledger"); }, null]) {
    const { route } = routes({ card, work });
    const { out, res } = response();
    await route({ method: "GET", url: "/api/memory/projects/prj_1/overview", headers: {} }, res);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.card.map((row) => row.slot), ["design"]);
    assert.deepEqual([out.body.data.capabilities, out.body.data.works, out.body.data.paused], [[], [], false]);
  }
});

test("a deployment without the memory engine answers by name and serves no card of its own", async () => {
  const { route, calls } = routes({ configured: false });
  await assert.rejects(() => route({ method: "GET", url: "/api/memory/projects/prj_1/overview", headers: {} }, response().res), { status: 503, code: "memory_engine_unavailable" });
  assert.deepEqual(calls.cards, []);
});

test("the sources of a memory: the file is the account's or a 404, and only type, id and state leave", async () => {
  const links = [{ type: "knowledge_source", id: "src_abc", state: "current" }];
  const { route } = routes({ links });
  const { out, res } = response();
  await route({ method: "GET", url: "/api/memory/records/rec_1/sources", headers: {} }, res);
  assert.deepEqual(out.body.data, [{ type: "knowledge_source", id: "src_abc", state: "current" }]);
  await assert.rejects(() => route({ method: "GET", url: "/api/memory/records/rec_other/sources", headers: {} }, response().res), { status: 404 });
});

test("the server composes the overview route over the project's own run ledger; without the engine it says so by name", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-project-overview-"));
  const memorySettings = {
    configured: true,
    async status() { return { configured: true, connected: true, code: null }; },
    async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
  };
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, memorySettings });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const read = await fetch(`${base}/api/memory/projects/default/overview?timeZone=UTC`);
    assert.equal(read.status, 503, await read.clone().text());
    assert.equal((await read.json()).code, "memory_engine_unavailable");
    const missing = await fetch(`${base}/api/memory/projects/nobody-has-this/overview`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the works of an ordinary conversation are each of its files, named by what the person opens", () => {
  const files = ["预算表.xlsx", "rename.py", "会议纪要.docx"];
  const describe = () => ({ artifactKinds: {}, artifactRoles: { "rename.py": "draft" }, outputFiles: files });
  const ordinary = { id: "r1", status: "succeeded", effectiveAgentId: "open-domain-answer", title: "月度预算", finishedAt: "2026-10-10T02:30:00.000Z", artifacts: files };
  const unrouted = { ...ordinary, id: "r2", effectiveAgentId: undefined, title: undefined, question: "整理一下会议纪要", finishedAt: "2026-10-11T02:30:00.000Z" };
  const months = projectWorks([ordinary, unrouted], { describe, timeZone: "Asia/Shanghai" });
  assert.deepEqual(months.map((group) => group.month), ["2026-10"]);
  const items = months[0].items;
  assert.equal(items.length, 6);
  assert.deepEqual(items.filter((item) => item.runId === "r1").map((item) => item.name).sort(), [...files].sort());
  assert.equal(items.find((item) => item.runId === "r2")?.title, "整理一下会议纪要", "a conversation no capability took is still the person's");
  // Without files an unrouted conversation is not a work.
  assert.deepEqual(projectWorks([unrouted], { describe: () => ({ artifactKinds: {}, artifactRoles: {} }) }), []);
});
