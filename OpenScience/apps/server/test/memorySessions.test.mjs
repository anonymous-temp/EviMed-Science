// 「本次用到的背景」, 「本次不用」 and the incognito switch, over HTTP.
//
// The panel reads the run ledger — what each run of the conversation was
// handed — and hydrates each line from the store that owns it, so what the
// researcher sees is what the run was given, with the revision its 「不对」
// needs. What the runtime has mounted now is a second, separately named list.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  MAX_BACKGROUND_MEMORIES, createMemorySessionRoutes, mountedMethodsFor, sessionBackground, sessionDispatchNotes, setAsideMethodName,
  setAsideMethodNames, setAsideMethodsNotice,
} from "../src/memorySessions.mjs";
import { sendError } from "../src/security.mjs";

const user = { id: "usr_1" };
const project = { id: "prj_1", userId: "usr_1" };

function memoryDouble() {
  /** @type {Map<string, { incognito: boolean, excluded: any[] }>} */
  const states = new Map();
  const state = (sessionId) => states.get(sessionId) ?? { incognito: false, excluded: [] };
  return {
    configured: true,
    states,
    async sessionState(_userId, _projectId, sessionId) { return structuredClone(state(sessionId)); },
    async updateSessionState(_userId, _projectId, sessionId, patch) {
      const next = structuredClone(state(sessionId));
      if (patch.incognito !== undefined) {
        if (typeof patch.incognito !== "boolean") throw Object.assign(new Error("bad"), { status: 400, code: "memory_session_invalid" });
        next.incognito = patch.incognito;
      }
      if (patch.exclude) next.excluded = [...next.excluded.filter((item) => item.id !== patch.exclude.id), { label: "", ...patch.exclude }];
      if (patch.include) next.excluded = next.excluded.filter((item) => !(item.type === patch.include.type && item.id === patch.include.id));
      states.set(sessionId, next);
      return structuredClone(next);
    },
    recordSummariesCalls: /** @type {any[]} */ ([]),
    async recordSummaries(_userId, ids) {
      this.recordSummariesCalls.push(ids);
      return ids.filter((id) => id === "rec_1").map((id) => ({ id, kind: "preference", scope: "user", summary: "证据用表格呈现", value: "",
        status: "active", version: 3, provenance: { basis: "stated", observations: 2, runs: 2, conversations: 1 } }));
    },
    async list() { return [{ id: "note_1", content: "肾病随访笔记" }]; },
    recentChangesCalls: /** @type {any[]} */ ([]),
    async recentChanges(_userId, options) {
      this.recentChangesCalls.push(options);
      return [{ id: "rec_2", summary: "刚记下的偏好", change: "created", version: 1 }];
    },
  };
}

const runs = [
  { id: "run_2", sessionId: "ses_1", status: "succeeded", startedAt: "2026-09-20T02:00:00.000Z",
    recalledMemories: [{ id: "record:rec_1", kind: "preference", scope: "user" }, { id: "capsule:fact_1", kind: "workflow", scope: "capsule" }],
    methodsLoaded: [{ name: "renal-dosing", digest: `sha256:${"a".repeat(64)}` }] },
  { id: "run_1", sessionId: "ses_1", status: "succeeded", startedAt: "2026-09-20T01:00:00.000Z",
    recalledMemories: [{ id: "record:rec_1", kind: "preference", scope: "user" }, { id: "note_1", kind: "note", scope: "user" },
      { id: "record:rec_gone", kind: "profile", scope: "user" }],
    methodsLoaded: [{ name: "old-method", digest: `sha256:${"b".repeat(64)}` }] },
  { id: "run_other", sessionId: "ses_2", status: "running", startedAt: "2026-09-20T03:00:00.000Z",
    recalledMemories: [{ id: "record:rec_9", kind: "profile", scope: "user" }] },
];
const agentRuns = { list: async () => structuredClone(runs) };
const capsules = {
  documents: {
    async get(_userId, kind, id) {
      assert.equal(kind, "fact");
      return id === "fact_1" ? { id, revision: 4, payload: { capsuleId: "cap_1", factKind: "workflow", content: "先查肾功能再给剂量", origin: "explicit", status: "approved" } } : null;
    },
  },
};
const mountedMethods = async () => [
  { name: "renal-dosing", label: "renal-dosing", source: "learned", methodId: "mth_1", revision: 2, available: true },
  { name: "method-fact_1", label: "先查肾功能", source: "capsule", entryId: "fact_1", capsuleId: "cap_1", revision: 4, available: true },
];

test("the panel lists what every run of the conversation was handed, once each, hydrated from its own store", async () => {
  const researchMemory = memoryDouble();
  researchMemory.states.set("ses_1", { incognito: false, excluded: [{ type: "capsule", id: "fact_1", label: "" }, { type: "method", id: "method-fact_1", label: "" }] });
  const background = await sessionBackground({ researchMemory, agentRuns, capsules, mountedMethods }, user, project, "ses_1");

  assert.deepEqual(background.runs.map((run) => run.id), ["run_1", "run_2"], "this conversation's runs, oldest first");
  assert.deepEqual(background.memories.map((item) => [item.type, item.id, item.runIds]), [
    ["memory", "rec_1", ["run_1", "run_2"]],
    ["note", "note_1", ["run_1"]],
    ["memory", "rec_gone", ["run_1"]],
    ["capsule", "fact_1", ["run_2"]],
  ]);
  const [record, note, gone, fact] = background.memories;
  assert.equal(record.summary, "证据用表格呈现");
  assert.equal(record.basis, "stated");
  assert.equal(record.version, 3, "the version 「不对」 archives against");
  assert.equal(note.summary, "肾病随访笔记");
  assert.equal(gone.available, false, "a memory deleted since is still listed as used, and said to be gone");
  assert.equal(fact.revision, 4);
  assert.equal(fact.capsuleId, "cap_1");
  assert.equal(fact.setAside, true);
  assert.equal(record.setAside, false);
  assert.ok(!background.memories.some((item) => item.id === "rec_9"), "another conversation's recall is not this one's");

  assert.deepEqual(background.methods.map((method) => [method.name, method.used, method.setAside, method.source]), [
    ["renal-dosing", true, false, "learned"],
    ["method-fact_1", false, true, "capsule"],
    ["old-method", true, false, "earlier"],
  ]);
  assert.equal(background.methods[2].available, false, "loaded in an earlier run and no longer mounted");

  // 「本次新记下」: this conversation's writes since its first run began.
  assert.deepEqual(background.written.map((item) => item.id), ["rec_2"]);
  assert.equal(researchMemory.recentChangesCalls[0].sessionId, "ses_1");
  assert.equal(researchMemory.recentChangesCalls[0].since, "2026-09-20T00:59:59.000Z");
});

test("a conversation with no run yet has nothing to list and asks nothing of the change log", async () => {
  const researchMemory = memoryDouble();
  const background = await sessionBackground({ researchMemory, agentRuns, capsules, mountedMethods: null }, user, project, "ses_new");
  assert.deepEqual([background.runs, background.memories, background.methods, background.written], [[], [], [], []]);
  assert.equal(researchMemory.recentChangesCalls.length, 0);
});

test("the panel lists the capsule methods recorded at the last launch and selects none again; only an unlaunched project is selected", async () => {
  // Security review 2026-09-20: the panel selected every capsule again on each
  // read — up to eight capsules of a thousand entries of 20,000 characters.
  let selections = 0;
  const select = async () => {
    selections += 1;
    return [{ id: "fact_live", directoryName: "fact_live", capsuleId: "cap_1", factKind: "workflow", content: "现在会选到的方法" }];
  };
  const runtimeManager = {
    key: (/** @type {any} */ subject) => `${subject.userId}:${subject.id}`,
    lastMountedLearnedMethods: new Map(),
    lastMountedCapsuleMethods: new Map([["usr_1:prj_1", [{ id: "fact_1", directoryName: "fact_1", capsuleId: "cap_1", factKind: "workflow",
      content: "先查肾功能再给剂量" }]]]),
  };
  const recorded = await mountedMethodsFor({ runtimeManager, capsules, select }, project);
  assert.equal(selections, 0, "what the launch recorded is what is mounted");
  assert.deepEqual(recorded.map((method) => [method.name, method.label, method.revision]), [["method-fact_1", "先查肾功能再给剂量", 4]]);
  const unlaunched = await mountedMethodsFor({ runtimeManager: { ...runtimeManager, lastMountedCapsuleMethods: new Map() }, capsules, select }, project);
  assert.equal(selections, 1);
  assert.deepEqual(unlaunched.map((method) => method.name), ["method-fact_live"]);
});

test("a long conversation lists its most recent recalls, their records read in one light query", async () => {
  const researchMemory = memoryDouble();
  const recalled = Array.from({ length: MAX_BACKGROUND_MEMORIES + 50 }, (_, index) => ({ id: `record:rec_${index}`, kind: "preference", scope: "user" }));
  const long = [{ id: "run_long", sessionId: "ses_long", status: "succeeded", startedAt: "2026-09-20T03:00:00.000Z", recalledMemories: recalled }];
  const background = await sessionBackground({ researchMemory, agentRuns: { list: async () => structuredClone(long) }, capsules, mountedMethods: null },
    user, project, "ses_long");
  assert.equal(background.memories.length, MAX_BACKGROUND_MEMORIES);
  assert.equal(background.memories[0].id, "rec_50", "the earliest recalls give way");
  assert.equal(researchMemory.recordSummariesCalls.length, 1);
  assert.equal(researchMemory.recordSummariesCalls[0].length, MAX_BACKGROUND_MEMORIES);
});

test("mounted methods name what the run sees, with the revision each retire needs", async () => {
  const runtimeManager = {
    key: (subject) => `${subject.userId}:${subject.id}`,
    lastMountedLearnedMethods: new Map([["usr_1:prj_1", [{ id: "mth_1", name: "renal-dosing", digest: "sha256:x", trial: true }]]]),
  };
  const learning = { getMethod: async () => ({ revision: 5, payload: { status: "candidate", frontmatter: { description: "肾功能分层给药" } } }) };
  const select = async () => [{ id: "fact_1", directoryName: "fact_1", capsuleId: "cap_1", factKind: "workflow", content: "先查肾功能再给剂量" }];
  const methods = await mountedMethodsFor({ runtimeManager, capsules, learning, select }, project);
  assert.deepEqual(methods.map((method) => [method.name, method.source, method.revision]), [
    ["renal-dosing", "learned", 5],
    ["method-fact_1", "capsule", 4],
  ]);
  assert.equal(methods[0].trial, true);
  assert.equal(methods[0].description, "肾功能分层给药");
  assert.deepEqual(await mountedMethodsFor({ runtimeManager: { key: () => "none", lastMountedLearnedMethods: new Map() } }, project), []);
  assert.equal(setAsideMethodsNotice([]), "");
  assert.match(setAsideMethodsNotice(["a", "b"]), /本次不用这些方法：a、b/);
  assert.equal(setAsideMethodName({ id: "method-x", label: "剂量核对" }), "method-x（剂量核对）");
  assert.equal(setAsideMethodName({ id: "renal-dosing", label: "renal-dosing" }), "renal-dosing");
});

test("a dispatch reads the methods set aside, and a state it cannot read sets nothing aside", async () => {
  const researchMemory = memoryDouble();
  researchMemory.states.set("ses_1", { incognito: false, excluded: [{ type: "memory", id: "rec_1", label: "" }, { type: "method", id: "method-x", label: "剂量核对" }] });
  assert.deepEqual(await setAsideMethodNames(researchMemory, "usr_1", "prj_1", "ses_1"), ["method-x（剂量核对）"]);
  assert.deepEqual(await setAsideMethodNames({ configured: true }, "usr_1", "prj_1", "ses_1"), [], "a store without sessions");
  assert.deepEqual(await setAsideMethodNames({ configured: true, sessionState: async () => { throw new Error("down"); } }, "u", "p", "s"), []);
  assert.deepEqual(await setAsideMethodNames({ configured: false }, "u", "p", "s"), []);
});

async function serve(t, researchMemory) {
  const audits = [];
  const routes = createMemorySessionRoutes({
    config: { maxJsonBytes: 65536 }, researchMemory, agentRuns, capsules, mountedMethods,
    context: async () => ({ user, project }),
    audit: async (_ctx, action, status, details) => { audits.push({ action, status, details }); },
  });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end("unhandled"); } })
      .catch((error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { call, audits };
}

test("the routes switch incognito, set aside and bring back, and refuse anything else by name", async (t) => {
  const researchMemory = memoryDouble();
  const { call, audits } = await serve(t, researchMemory);

  assert.equal((await (await call("GET", "/api/memory/sessions/ses_1")).json()).data.incognito, false);
  const on = await call("PUT", "/api/memory/sessions/ses_1", { incognito: true });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).data.incognito, true);
  assert.equal((await call("PUT", "/api/memory/sessions/ses_1", { incognito: true, excluded: [] })).status, 400);

  const aside = await (await call("POST", "/api/memory/sessions/ses_1/exclusions", { type: "memory", id: "rec_1", label: "表格" })).json();
  assert.deepEqual(aside.data.excluded, [{ type: "memory", id: "rec_1", label: "表格" }]);
  assert.equal((await call("POST", "/api/memory/sessions/ses_1/exclusions", { type: "memory", id: "rec_1", reason: "x" })).status, 400);
  const back = await (await call("DELETE", "/api/memory/sessions/ses_1/exclusions", { type: "memory", id: "rec_1" })).json();
  assert.deepEqual(back.data.excluded, []);

  const background = await (await call("GET", "/api/memory/sessions/ses_1/background")).json();
  assert.equal(background.data.incognito, true);
  assert.equal(background.data.memories.length, 4);

  assert.equal((await call("GET", "/api/memory/sessions/bad%20id")).status, 400);
  assert.equal((await call("PATCH", "/api/memory/sessions/ses_1")).status, 405);
  assert.equal((await call("GET", "/api/memory/other")).status, 404, "a path that is not a session route is not claimed");
  assert.deepEqual(audits.map((entry) => entry.action), ["memory.session.incognito", "memory.session.exclude", "memory.session.include"]);

  const unconfigured = await serve(t, { ...memoryDouble(), configured: false });
  assert.equal((await unconfigured.call("GET", "/api/memory/sessions/ses_1")).status, 503);
});

// Wired is not fed (learningComposition.test.mjs): each piece above is dark in
// a real deployment unless the composition root hands it the conversation.
test("the composition root feeds the conversation's state to every path that reads it", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const gateway = server.slice(server.indexOf("const capsuleGatewayHandler = createCapsuleGatewayHandler("), server.indexOf("const revisionGatewayHandler ="));
  assert.match(gateway, /running: \(_user, project\) => agentRuns\.activeRuns\(project\)/);
  assert.match(gateway, /state: \(userId, projectId, sessionId\) => researchMemory\.sessionState\(userId, projectId, sessionId\)/);
  assert.match(gateway, /appendRecalledMemories:/);
  assert.match(server, /if \(await memorySessionRoutes\(req, res\)\) return;/);
  assert.match(server, /if \(await memoryTimelineRoutes\(req, res\)\) return;/);
  assert.match(server, /createMemoryTimelineRoutes\(\{ config, researchMemory, agentRuns, feedbackEvents, learning: learningService, context \}\)/);
  assert.match(server, /mountedMethods: \(project\) => mountedMethodsFor\(\{ runtimeManager, capsules: capsuleService, learning: learningService \}, project\)/);
  assert.match(server, /const sessionNotes = await sessionDispatchNotes\(\{ researchMemory, capsules: capsuleService \}, ctx\.user\.id, ctx\.project\.id, session\.sessionId\);/);
  assert.match(server, /system: sessionNotes\.length \? `\$\{prepared\.system\}\\n\\n\$\{sessionNotes\.join\("\\n\\n"\)\}` : prepared\.system,/);
  const triggers = server.slice(server.indexOf("new LearningTriggers({"), server.indexOf("new LearningTriggers({") + 600);
  assert.match(triggers, /sessionState:/);
});

test("a dispatch is told what its conversation set aside and which shared capsule it is trying", async () => {
  const researchMemory = memoryDouble();
  researchMemory.states.set("ses_1", { incognito: false, excluded: [{ type: "method", id: "method-x", label: "剂量核对" }], trialCapsuleId: "pack-1" });
  const capsules = { trialContext: async (_userId, id) => (id === "pack-1" ? "<evimed-capsule-trial>李主任的方法</evimed-capsule-trial>" : "") };
  const notes = await sessionDispatchNotes({ researchMemory, capsules }, "usr_1", "prj_1", "ses_1");
  assert.equal(notes.length, 2);
  assert.match(notes[0], /本次不用这些方法：method-x（剂量核对）/);
  assert.match(notes[1], /李主任的方法/);
  assert.deepEqual(await sessionDispatchNotes({ researchMemory, capsules }, "usr_1", "prj_1", "ses_other"), []);
  assert.deepEqual(await sessionDispatchNotes({ researchMemory: { configured: true, sessionState: async () => { throw new Error("down"); } }, capsules }, "u", "p", "s"), [],
    "a state that cannot be read adds nothing rather than failing the turn");
});
