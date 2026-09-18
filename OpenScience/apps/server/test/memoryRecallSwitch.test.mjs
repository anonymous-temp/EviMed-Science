// The memory switches (2026-09-18 review, E §10.5 and §10.7): a deployment
// recall switch that is a real control arm, a provider choice readiness can
// explain, and the resident capsule profile that was read and never written.
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOCKET_TOOL_NAMES, workspaceLayout } from "@evimed/domain";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CAPSULE_PROFILE_FACT_KINDS, CAPSULE_PROFILE_MAX_TOKENS, renderCapsuleProfile } from "../src/capsuleProfile.mjs";
import { loadConfig } from "../src/config.mjs";
import { MemorySubstrate, memoryIndexSelection, selectedMemoryIndexProvider } from "../src/memorySubstrate.mjs";
import { recallAcrossMemory } from "../src/memoryRecall.mjs";
import { estimatePromptTokens } from "../src/modelGateway.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { createWebApiApp } from "../src/server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** @param {Record<string, string | undefined>} env @param {() => void} fn */
function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("recall is on by default, follows the memory subsystem's switch when unset, and its own key wins", () => {
  const read = (env) => {
    let value;
    withEnv({ OPEN_SCIENCE_MEMORY_RECALL_ENABLED: undefined, OPEN_SCIENCE_MEMORY_ENABLED: undefined, ...env }, () => {
      value = loadConfig({ rootDir: repoRoot }).memoryRecallEnabled;
    });
    return value;
  };
  assert.equal(read({}), true);
  assert.equal(read({ OPEN_SCIENCE_MEMORY_RECALL_ENABLED: "false" }), false);
  assert.equal(read({ OPEN_SCIENCE_MEMORY_ENABLED: "false" }), false,
    "a deployment that hid memory from its researchers does not keep feeding it to their runs");
  assert.equal(read({ OPEN_SCIENCE_MEMORY_ENABLED: "false", OPEN_SCIENCE_MEMORY_RECALL_ENABLED: "true" }), true);
  assert.equal(loadConfig({ rootDir: repoRoot, memoryRecallEnabled: false }).memoryRecallEnabled, false);
});

test("an unset provider selects the index exactly when it is configured, and a named one always wins", () => {
  const index = { openVikingUrl: "http://evimed-openviking:1933", openVikingApiKey: "k" };
  assert.deepEqual(memoryIndexSelection({ ...index, memoryIndexProvider: "" }),
    { provider: "openviking", source: "index-configured", indexConfigured: true });
  assert.deepEqual(memoryIndexSelection({ memoryIndexProvider: "" }),
    { provider: "builtin", source: "default", indexConfigured: false });
  // A pin is honoured — and visible as one, which is what the production
  // readiness never said (E §10.5).
  assert.deepEqual(memoryIndexSelection({ ...index, memoryIndexProvider: "builtin" }),
    { provider: "builtin", source: "named", indexConfigured: true });
  assert.deepEqual(memoryIndexSelection({ memoryIndexProvider: "openviking" }),
    { provider: "openviking", source: "named", indexConfigured: false });
  assert.equal(memoryIndexSelection({ ...index, memoryIndexProvider: "qdrant" }).source, "unknown-name");
  assert.equal(selectedMemoryIndexProvider({ ...index, memoryIndexProvider: "qdrant" }), "builtin");
  // Half a configuration is not a configuration.
  assert.equal(selectedMemoryIndexProvider({ openVikingUrl: index.openVikingUrl }), "builtin");
  assert.equal(selectedMemoryIndexProvider({ ...index, openVikingApiKeyError: "openviking_api_key_unreadable" }), "builtin");
  withEnv({ OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: undefined, OPEN_SCIENCE_OPENVIKING_URL: undefined }, () => {
    assert.equal(loadConfig({ rootDir: repoRoot }).memoryIndexProvider, "", "unset stays unset for the selection to read");
  });
});

test("with recall off the substrate asks no store and no index, and the recall tool answers disabled", async () => {
  const asked = [];
  const store = {
    configured: true,
    async settings() { asked.push("settings"); return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
    async relevant() { asked.push("relevant"); return [{ id: "m1", content: "偏好：先给结论", kind: "preference", scope: "user" }]; },
  };
  const on = new MemorySubstrate({ memoryIndexProvider: "builtin" }, { store });
  assert.equal((await on.recall("u1", "问题", { projectId: "p1" })).length, 1);
  asked.length = 0;
  const off = new MemorySubstrate({ memoryIndexProvider: "builtin", memoryRecallEnabled: false }, { store });
  assert.deepEqual(await off.recall("u1", "问题", { projectId: "p1" }), []);
  assert.deepEqual(asked, [], "the off arm must not depend on what the store would have said");

  const capsuleCalls = [];
  const capsules = { async recall() { capsuleCalls.push(1); return { items: [{ id: "f1", content: "x" }], mode: "lexical" }; } };
  const answer = await recallAcrossMemory({ capsules, memorySubstrate: off }, { id: "u1" }, { query: "问题", scope: "all" });
  assert.deepEqual(answer, { items: [], mode: "disabled", contextOnly: true, sources: { memory: 0, capsule: 0 } });
  assert.deepEqual(capsuleCalls, [], "capsule facts are memory too");
  const served = await recallAcrossMemory({ capsules, memorySubstrate: on }, { id: "u1" }, { query: "问题", scope: "all" });
  assert.equal(served.sources.capsule, 1);
  assert.equal(served.sources.memory, 1);
});

test("the resident profile lists who the researcher is, newest first, within its budget", () => {
  const facts = [
    { factKind: "preference", content: "先给结论，再给依据", updatedAt: "2026-09-01T00:00:00Z" },
    { factKind: "preference", content: "证据表用 GRADE", updatedAt: "2026-09-10T00:00:00Z" },
    { factKind: "profile", content: "临床药师，\n专注抗凝治疗", updatedAt: "2026-08-01T00:00:00Z" },
    { factKind: "writing_style", content: "避免口语化", updatedAt: "2026-08-02T00:00:00Z" },
    { factKind: "project_fact", content: "项目用 MIMIC-IV", updatedAt: "2026-09-12T00:00:00Z" },
    { factKind: "method_preference", content: "先预注册分析计划", updatedAt: "2026-09-12T00:00:00Z" },
    { factKind: "preference", content: "证据表用 GRADE", updatedAt: "2026-09-09T00:00:00Z" },
    { factKind: "stance", content: "   ", updatedAt: "2026-09-12T00:00:00Z" },
  ];
  const text = renderCapsuleProfile(facts);
  assert.equal(text, [
    "以下条目来自用户本人的记忆胶囊，均经用户确认：",
    "- 身份：临床药师， 专注抗凝治疗",
    "- 偏好：证据表用 GRADE",
    "- 偏好：先给结论，再给依据",
    "- 写作偏好：避免口语化",
    "",
  ].join("\n"));
  assert.doesNotMatch(text, /MIMIC|预注册/, "project facts stay one recall away and methods are mounted as skills");
  assert.equal(renderCapsuleProfile([]), "");
  assert.equal(renderCapsuleProfile([{ factKind: "project_fact", content: "x" }]), "");
  assert.deepEqual([...CAPSULE_PROFILE_FACT_KINDS], ["profile", "expertise", "preference", "stance", "writing_style"]);

  const many = Array.from({ length: 200 }, (_, index) => ({
    factKind: "preference", content: `偏好第${index}条：${"很长的说明".repeat(10)}`, updatedAt: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00Z`,
  }));
  const bounded = renderCapsuleProfile(many);
  assert.ok(estimatePromptTokens(bounded) <= CAPSULE_PROFILE_MAX_TOKENS, `${estimatePromptTokens(bounded)} tokens`);
  assert.match(bounded, new RegExp(`（另有 \\d+ 条未列出；需要时用 ${SOCKET_TOOL_NAMES.capsuleRecall} 检索。）\\n$`));
  const long = renderCapsuleProfile([{ factKind: "expertise", content: "长".repeat(2_000) }]);
  assert.ok([...long.split("\n")[1]].length <= "- 背景知识：".length + 400, "one entry cannot take the whole block");
});

class MemoryDocuments {
  constructor() { this.rows = new Map(); }
  key(userId, kind, id) { return `${userId}/${kind}/${id}`; }
  async get(userId, kind, id) { return this.rows.get(this.key(userId, kind, id)) ?? null; }
  async list(userId, kind, { filter = {}, limit = 50 } = {}) {
    const items = [...this.rows.values()].filter((row) => row.userId === userId && row.kind === kind
      && Object.entries(filter).every(([key, value]) => row.payload[key] === value)).slice(0, limit);
    return { items, nextCursor: null };
  }
  async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
    const current = this.rows.get(this.key(userId, kind, id));
    if ((current?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
    const row = { id, kind, userId, projectId, payload, revision: expectedRevision + 1, createdAt: "2026-09-18T00:00:00.000Z", updatedAt: `2026-09-18T00:00:0${this.rows.size % 10}.000Z` };
    this.rows.set(this.key(userId, kind, id), row);
    return row;
  }
}

async function capsuleFixture() {
  const documents = new MemoryDocuments();
  const capsules = new CapsuleService(documents);
  const own = await capsules.create("u1", { title: "我的胶囊" });
  await capsules.addEntry("u1", own.id, { factKind: "profile", layer: "profile", content: "心内科临床药师" });
  await capsules.addEntry("u1", own.id, { factKind: "writing_style", layer: "profile", content: "结论先行" });
  await capsules.addEntry("u1", own.id, { factKind: "preference", layer: "profile", content: "只看近五年指南", origin: "inferred" });
  await capsules.addEntry("u1", own.id, { factKind: "method_preference", layer: "methods", content: "先做敏感性分析" });
  const guest = await capsules.create("u1", { title: "同事的工作方式" });
  await capsules.addEntry("u1", guest.id, { factKind: "profile", layer: "profile", content: "肿瘤科医生" });
  return { documents, capsules, own, guest };
}

test("the profile reads approved person entries from the researcher's own capsules only", async () => {
  const { documents, capsules, own, guest } = await capsuleFixture();
  await capsules.activate("u1", own.id, { mode: "own", projectId: "p1" });
  await capsules.activate("u1", guest.id, { mode: "guest", projectId: "p1" });
  const facts = await capsules.profileFacts("u1", "p1", CAPSULE_PROFILE_FACT_KINDS);
  assert.deepEqual(facts.map((fact) => fact.content).sort(), ["心内科临床药师", "结论先行"],
    "a candidate is not approved, a method is a skill, and a guest's identity is not the researcher's");

  // An imported capsule, even activated as own, is the predicate `note()`
  // already uses for "not the researcher's own".
  const imported = await documents.put("u1", "capsule", "imported-1", { title: "导入的包", imported: true, activationMode: "own" }, { expectedRevision: 0 });
  await capsules.addEntry("u1", imported.id, { factKind: "profile", layer: "profile", content: "别人的身份" });
  await capsules.activate("u1", imported.id, { mode: "own", projectId: "p2" });
  assert.deepEqual(await capsules.profileFacts("u1", "p2", CAPSULE_PROFILE_FACT_KINDS), []);

  // The account-wide activation reaches every project.
  await capsules.activate("u1", own.id, { mode: "own" });
  assert.equal((await capsules.profileFacts("u1", "p3", CAPSULE_PROFILE_FACT_KINDS)).length, 2);
  await assert.rejects(capsules.profileFacts("u1", "p3", ["not-a-kind"]), { code: "capsule_payload_invalid" });
});

async function managerFixture({ recall = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-capsule-profile-"));
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const manager = new RuntimeManager({ runtimeMode: "mock", dataDir: root, memoryRecallEnabled: recall });
  const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir };
  const file = path.join(workspaceDir, workspaceLayout.capsuleProfileFile);
  return { root, manager, project, file };
}

test("the profile is written for a researcher with a capsule, cleared when recall is turned off, and absent otherwise", async () => {
  const { capsules, own } = await capsuleFixture();
  await capsules.activate("u1", own.id, { mode: "own", projectId: "p1" });

  const on = await managerFixture();
  try {
    on.manager.capsuleService = capsules;
    const result = await on.manager.syncCapsuleProfile(on.project);
    assert.equal(result.written, true);
    const text = await readFile(on.file, "utf8");
    assert.match(text, /^以下条目来自用户本人的记忆胶囊/);
    assert.match(text, /- 身份：心内科临床药师/);
    assert.equal((await lstat(on.file)).mode & 0o777, 0o444, "the run reads it; it does not edit it");

    // The switch thrown after a profile was written: the stale block must not
    // keep reaching runs the operator meant to run without memory.
    const off = new RuntimeManager({ runtimeMode: "mock", dataDir: on.root, memoryRecallEnabled: false });
    off.capsuleService = capsules;
    assert.deepEqual(await off.syncCapsuleProfile(on.project), { written: true, chars: 0 });
    assert.equal(await readFile(on.file, "utf8"), "");
  } finally {
    await rm(on.root, { recursive: true, force: true });
  }

  const none = await managerFixture();
  try {
    none.manager.capsuleService = new CapsuleService(new MemoryDocuments());
    assert.deepEqual(await none.manager.syncCapsuleProfile(none.project), { written: false, chars: 0 });
    await assert.rejects(lstat(path.dirname(none.file)), { code: "ENOENT" }, "a project that never had a capsule gains no directory");
    none.manager.capsuleService = null;
    assert.deepEqual(await none.manager.syncCapsuleProfile(none.project), { written: false, chars: 0 });
  } finally {
    await rm(none.root, { recursive: true, force: true });
  }

  const broken = await managerFixture();
  try {
    broken.manager.capsuleService = { async profileFacts() { throw Object.assign(new Error("down"), { code: "product_state_unavailable" }); } };
    assert.deepEqual(await broken.manager.syncCapsuleProfile(broken.project), { written: false, chars: 0, error: "product_state_unavailable" },
      "a run without the block is degraded, not refused — and the failure is named, not swallowed");
  } finally {
    await rm(broken.root, { recursive: true, force: true });
  }
});

async function withApp(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-recall-switch-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, memoryExtractionEnabled: false, ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** @param {string} dir @returns {Promise<string[]>} */
async function findFiles(dir, name) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(full, name));
    else if (entry.name === name) found.push(full);
  }
  return found;
}

function recordingMemory() {
  const asked = [];
  return {
    asked,
    configured: true,
    async status() { return { configured: true, connected: true, code: null, structured: true }; },
    async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
    async relevant(userId, query) {
      asked.push(query);
      return [{ id: "record:m1", content: "偏好：结论先行", memoryType: "structured", kind: "preference", scope: "user", updatedAt: "2026-09-18T00:00:00Z" }];
    },
  };
}

async function dispatchOnce(base, sessionId) {
  const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/api/research-sessions/${sessionId}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
  const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST", headers, body: JSON.stringify({ sessionId, dispatchId: `dispatch_${sessionId}`, text: "抗凝药物的出血风险怎么评估？" }),
  });
  assert.equal(dispatched.status, 202, await dispatched.clone().text());
}

test("a dispatch recalls memories with the switch on and asks nothing with it off; readiness says which", async () => {
  const onMemory = recordingMemory();
  await withApp(async ({ base, dataDir }) => {
    await dispatchOnce(base, "ses_recall_on");
    assert.equal(onMemory.asked.length, 1);
    const [memoryFile] = await findFiles(dataDir, "memory.md");
    assert.match(await readFile(memoryFile, "utf8"), /结论先行/);
    const ready = (await (await fetch(`${base}/api/ready`)).json()).data;
    assert.equal(ready.checks.memory.recallEnabled, true);
    assert.equal(ready.checks.memoryIndex.provider, "builtin");
    assert.equal(ready.checks.memoryIndex.providerSource, "default");
    assert.equal(ready.checks.memoryIndex.indexConfigured, false);
  }, { researchMemory: onMemory });

  const offMemory = recordingMemory();
  await withApp(async ({ base, dataDir }) => {
    await dispatchOnce(base, "ses_recall_off");
    assert.deepEqual(offMemory.asked, [], "the off arm is a switch, not an account whose records happen not to match");
    const [memoryFile] = await findFiles(dataDir, "memory.md");
    assert.equal(await readFile(memoryFile, "utf8"), "", "a delegated child inherits nothing either");
    const ready = (await (await fetch(`${base}/api/ready`)).json()).data;
    assert.equal(ready.checks.memory.recallEnabled, false);
  }, { researchMemory: offMemory, memoryRecallEnabled: false });
});

test("readiness names a builtin pin on a deployment whose index is configured", async () => {
  const keyDir = await mkdtemp(path.join(tmpdir(), "os-recall-key-"));
  try {
    const keyFile = path.join(keyDir, "openviking.api-key");
    await writeFile(keyFile, "not-a-real-openviking-key\n", { mode: 0o600 });
    await withApp(async ({ base }) => {
      const ready = (await (await fetch(`${base}/api/ready`)).json()).data;
      assert.equal(ready.checks.memoryIndex.provider, "builtin");
      assert.equal(ready.checks.memoryIndex.providerSource, "named");
      assert.equal(ready.checks.memoryIndex.indexConfigured, true);
    }, { memoryIndexProvider: "builtin", openVikingUrl: "http://127.0.0.1:9", openVikingApiKeyFile: keyFile });
    await withApp(async ({ base }) => {
      const ready = (await (await fetch(`${base}/api/ready`)).json()).data;
      assert.equal(ready.checks.memoryIndex.provider, "openviking");
      assert.equal(ready.checks.memoryIndex.providerSource, "index-configured");
      assert.equal(ready.checks.memoryIndex.ok, true, "an unreachable index degrades recall; it does not fail a non-strict readiness");
    }, { memoryIndexProvider: "", openVikingUrl: "http://127.0.0.1:9", openVikingApiKeyFile: keyFile });
  } finally {
    await rm(keyDir, { recursive: true, force: true });
  }
});
