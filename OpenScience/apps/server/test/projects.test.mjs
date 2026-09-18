// Projects are named by people and identified by the machine (C4, 2026-09-18).
//
// Creation used to take an ASCII id and call it a name, so 「阿司匹林一级预防」
// was refused; nothing could rename a project; the seeded one was called
// "Default Project" in a Chinese product; and nothing said how much a project
// had been used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { errorCodeMessage } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { DEFAULT_PROJECT_NAME, projectIdFromName } from "../src/store.mjs";

async function withApp(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-projects-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await fn({ call, dataDir, app });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("an id is derived from the name: ASCII slugged, p-<8 hex> for a name with no ASCII letter, never a collision", () => {
  const taken = new Set(["default", "metformin-lactic-acidosis"]);
  assert.equal(projectIdFromName("Metformin & Lactic Acidosis", new Set()), "metformin-lactic-acidosis");
  assert.equal(projectIdFromName("Metformin & Lactic Acidosis", taken), "metformin-lactic-acidosis-2");
  assert.equal(projectIdFromName("Résumé d'étude", new Set()), "resume-d-etude", "accents fold to their letters");
  assert.equal(projectIdFromName("阿司匹林一级预防", new Set(), () => "0a1b2c3d"), "p-0a1b2c3d");
  assert.equal(projectIdFromName("2024 年随访", new Set(), () => "0a1b2c3d"), "p-0a1b2c3d", "digits alone are not a name to slug");
  assert.equal(projectIdFromName("Default", new Set(["default"]), () => "ffffffff"), "default-2");
  let calls = 0;
  assert.equal(projectIdFromName("阿司匹林", new Set(["p-00000000"]), () => (calls++ === 0 ? "00000000" : "11111111")), "p-11111111");
  assert.equal(projectIdFromName("x".repeat(80), new Set()).length, 40);
});

test("a project is created from a name in any language, renamed by name, and archived rather than deleted", async () => {
  await withApp(async ({ call }) => {
    const chinese = await call("POST", "/api/projects", { name: "阿司匹林一级预防" });
    assert.equal(chinese.status, 200, JSON.stringify(chinese.body));
    assert.match(chinese.body.data.id, /^p-[0-9a-f]{8}$/);
    assert.deepEqual({ ...chinese.body.data, id: "p" }, { id: "p", name: "阿司匹林一级预防", archivedAt: null, runCount: 0, lastActivityAt: null });
    const english = await call("POST", "/api/projects", { name: "Metformin & Lactic Acidosis" });
    assert.equal(english.body.data.id, "metformin-lactic-acidosis");
    const again = await call("POST", "/api/projects", { name: "Metformin & Lactic Acidosis" });
    assert.equal(again.body.data.id, "metformin-lactic-acidosis-2", "the same name twice is two projects");
    const legacy = await call("POST", "/api/projects", { id: "legacy-client" });
    assert.deepEqual([legacy.body.data.id, legacy.body.data.name], ["legacy-client", "legacy-client"], "a caller that still sends an id keeps it");
    for (const [label, body] of [["nothing", {}], ["a blank name", { name: "  " }], ["a name too long", { name: "长".repeat(41) }], ["an unknown field", { name: "x", quota: 1 }], ["a bad id", { name: "x", id: "../up" }]]) {
      assert.equal((await call("POST", "/api/projects", body)).status, 400, label);
    }

    const renamed = await call("PATCH", `/api/projects/${chinese.body.data.id}`, { name: "阿司匹林一级预防（≥70 岁）" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.name, "阿司匹林一级预防（≥70 岁）");
    assert.equal(renamed.body.data.id, chinese.body.data.id, "the id is a path and does not move");
    assert.equal((await call("PATCH", "/api/projects/nope", { name: "x" })).status, 404);
    assert.equal((await call("PATCH", `/api/projects/${chinese.body.data.id}`, { name: "x", id: "moved" })).status, 400);
    const defaultRenamed = await call("PATCH", "/api/projects/default", { name: "我的课题" });
    assert.equal(defaultRenamed.body.data.name, "我的课题");

    const archived = await call("POST", `/api/projects/${english.body.data.id}/archive`, {});
    assert.equal(archived.status, 200);
    assert.ok(Date.parse(archived.body.data.archivedAt));
    const restored = await call("POST", `/api/projects/${english.body.data.id}/archive`, { archived: false });
    assert.equal(restored.body.data.archivedAt, null);
    assert.equal((await call("POST", "/api/projects/default/archive", {})).status, 400);
    assert.equal((await call("POST", `/api/projects/${english.body.data.id}/archive`, { archived: "yes" })).status, 400);

    const listed = (await call("GET", "/api/projects")).body.data;
    const byId = new Map(listed.map((item) => [item.id, item]));
    assert.equal(byId.get(chinese.body.data.id).name, "阿司匹林一级预防（≥70 岁）");
    assert.equal(byId.get("default").name, "我的课题");
    for (const item of listed) {
      assert.equal(typeof item.runCount, "number");
      assert.ok(item.lastActivityAt === null || Number.isFinite(Date.parse(item.lastActivityAt)));
      assert.ok(Object.hasOwn(item, "archivedAt"));
    }
  });
});

test("a project's list row says how many runs it holds and when one last did anything", async () => {
  await withApp(async ({ call, dataDir }) => {
    const created = (await call("POST", "/api/projects", { name: "Busy" })).body.data;
    const ledger = path.join(dataDir, "users", "dev", "projects", created.id, ".openscience", "runs.jsonl");
    const started = (id, at) => ({
      event: "started", id, dispatchId: null, dispatchStatus: "accepted", kernelRequestIds: [], sessionId: `ses_${id}`,
      mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null, effectiveAgentId: null, effectiveAgentVersion: null,
      effectiveRuntimeAgent: null, effectiveRouteReason: null, model: "deepseek/deepseek-flash", question: "q", createdAt: at, startedAt: at, baselineCursor: null,
    });
    await mkdir(path.dirname(ledger), { recursive: true });
    await writeFile(ledger, [
      started("run_a", "2026-09-10T01:00:00.000Z"),
      { event: "finished", id: "run_a", status: "succeeded", errorCode: null, artifacts: [], finishedAt: "2026-09-12T08:00:00.000Z", durationMs: 1 },
      started("run_b", "2026-09-11T01:00:00.000Z"),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    const row = (await call("GET", "/api/projects")).body.data.find((item) => item.id === created.id);
    assert.equal(row.runCount, 2);
    assert.equal(row.lastActivityAt, "2026-09-12T08:00:00.000Z");
    const empty = (await call("GET", "/api/projects")).body.data.find((item) => item.id === "default");
    assert.deepEqual([empty.runCount, empty.lastActivityAt], [0, null]);
  });
});

test("the seeded project is 「我的研究」, an old English one is renamed once, and a deliberate name stays", async () => {
  await withApp(async ({ call }) => {
    assert.equal((await call("GET", "/api/projects")).body.data.find((item) => item.id === "default").name, DEFAULT_PROJECT_NAME);
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-projects-legacy-"));
  const projectRoot = path.join(dataDir, "users", "dev", "projects", "default");
  await mkdir(path.join(projectRoot, ".openscience"), { recursive: true });
  await mkdir(path.join(projectRoot, "workspace"), { recursive: true });
  await mkdir(path.join(projectRoot, "runtime"), { recursive: true });
  await writeFile(path.join(projectRoot, "project.json"), `${JSON.stringify({ id: "default", name: "Default Project", activeWorkspace: "" })}\n`, "utf8");
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false });
      const address = await app.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
      try {
        const listed = await (await fetch(`${base}/api/projects`, { headers })).json();
        if (pass === 0) {
          assert.equal(listed.data.find((item) => item.id === "default").name, DEFAULT_PROJECT_NAME);
          const meta = JSON.parse(await readFile(path.join(projectRoot, "project.json"), "utf8"));
          assert.equal(meta.defaultNameMigrated, true);
          assert.equal(meta.activeWorkspace, "", "the rest of project.json is kept");
          // Named "Default Project" on purpose, after the migration.
          const renamed = await fetch(`${base}/api/projects/default`, { method: "PATCH", headers, body: JSON.stringify({ name: "Default Project" }) });
          assert.equal(renamed.status, 200);
        } else {
          assert.equal(listed.data.find((item) => item.id === "default").name, "Default Project", "renamed once, not every start");
        }
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the project ceiling is refused with its reason, in the reader's language, and counts archived projects", async () => {
  await withApp(async ({ call }) => {
    const first = (await call("POST", "/api/projects", { name: "One" })).body.data;
    await call("POST", `/api/projects/${first.id}/archive`, {});
    const refused = await call("POST", "/api/projects", { name: "Two" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "project_limit_reached");
    assert.match(errorCodeMessage("project_limit_reached"), /项目数已达上限.*存储空间.*运行时/);
  }, { maxProjectsPerUser: 2 });
});
