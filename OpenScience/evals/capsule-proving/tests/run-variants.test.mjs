import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLabResidentProfiles, pollLabConsolidation, createMemoryClient, firstLine, replaceLabFile, startLabGateways, verifyLabExisting } from "../run/lab.mjs";
import { assertResumeCompatible, engineShard, main, parseArguments } from "../run/run.mjs";
import { NativeMemoryConsolidation } from "../../../apps/server/src/nativeMemoryConsolidation.mjs";
import { OpenVikingClient } from "../../../apps/server/src/openVikingClient.mjs";
import { OpenVikingSessions } from "../../../apps/server/src/openVikingSessions.mjs";
import { startOpenVikingStub } from "../../../apps/server/test/helpers/openVikingStub.mjs";

const base = ["--set", "synthetic-users", "--split", "dev", "--data", "/d", "--out", "/runs/r1", "--engine-url", "http://127.0.0.1:1", "--engine-key-file", "/k", "--database-url-file", "/u", "--ingest-only"];
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const jsonl = async (file) => (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), "run-variants-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("feature flags preserve defaults and parse repeatable JSON/string overrides and variants", () => {
  const defaults = parseArguments(base);
  assert.deepEqual(defaults.config, {});
  assert.deepEqual(defaults.answerVariants, []);
  assert.equal(defaults.maintain, "none");
  assert.equal(defaults.rejectionJudge, true);
  const options = parseArguments([...base, "--config", "memoryOpeningByUseEnabled=true", "--config", "mode=verify", "--config", "count=4", "--config", "nil=null", "--config", 'nested={"k":[1,2]}', "--config", "mode=pass", "--answer-variant", 'nohistory:memoryHistorySearchEnabled=false,names=[1,2],label="a,b",mode=verify', "--answer-variant", "zero:memoryContextLimit=0", "--maintain", "consolidate+verify", "--maintain-after", "0,5,5", "--no-rejection-judge", "--label", "E1 test"]);
  assert.deepEqual(options.config, { memoryOpeningByUseEnabled: true, mode: "pass", count: 4, nil: null, nested: { k: [1, 2] } });
  assert.deepEqual(options.answerVariants, [{ name: "nohistory", config: { memoryHistorySearchEnabled: false, names: [1, 2], label: "a,b", mode: "verify" } }, { name: "zero", config: { memoryContextLimit: 0 } }]);
  assert.deepEqual(options.maintainAfter, [0, 5]);
  assert.equal(options.rejectionJudge, false);
  assert.equal(options.label, "E1 test");
  assert.equal(parseArguments([...base, "--maintain", "verify", "--maintain-after", "each"]).maintainAfter, "each");
  for (const flags of [["--config", "bad"], ["--answer-variant", "../bad:x=1"], ["--answer-variant", "x:a=1", "--answer-variant", "x:a=2"], ["--maintain", "bad"], ["--maintain", "verify"], ["--maintain-after", "-1"], ["--maintain-after", "1.5"], ["--answer-variant"]]) assert.throws(() => parseArguments([...base, ...flags]));
});

test("stable userKey sharding refuses any changed or reordered resume engine list", () => {
  const options = parseArguments([...base, "--engine-url", "http://127.0.0.1:1/,http://127.0.0.1:2"]);
  assert.deepEqual(options.engineUrls, ["http://127.0.0.1:1", "http://127.0.0.1:2"]);
  const keys = ["U01", "U02", "U03", "U04"];
  assert.deepEqual(Object.fromEntries(keys.map((key) => [key, engineShard(key, 2)])), Object.fromEntries([...keys].reverse().map((key) => [key, engineShard(key, 2)])));
  assert.equal(engineShard("U01", 2), 0);
  assert.equal(engineShard("U01", 1), 0);
  const facts = { set: "s", split: "dev", arm: "product", engine: { urls: options.engineUrls } };
  assertResumeCompatible(facts, facts);
  assert.throws(() => assertResumeCompatible(facts, { ...facts, engine: { urls: [...options.engineUrls].reverse() } }), /different engine URL list/);
  assert.throws(() => assertResumeCompatible(facts, { ...facts, engine: { urls: options.engineUrls.slice(0, 1) } }), /different engine URL list/);
  assertResumeCompatible({ ...facts, engine: { url: options.engineUrls[0] } }, { ...facts, engine: { urls: options.engineUrls.slice(0, 1) } });
});

test("variant gateways read the same engine memory but only the enabled one returns raw history", async (t) => {
  const stub = await startOpenVikingStub(t);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const userId = "evlab_variants_U01";
  const engineUser = sessions.engineUser(userId);
  await sessions.register(userId);
  const uri = stub.seedMemory(engineUser, "preferences/tea.md", "- keeps a blue teapot", { type: "preferences" });
  let historyCalls = 0;
  const group = await startLabGateways({ sessions,
    runtimeManager: { assertActiveEviMedWorkloadToken: async () => ({ userId, projectId: "default" }) },
    store: { userById: async (id) => ({ id }), requireProject: async (user, id) => ({ id, userId: user.id, name: "Default" }) },
    admission: { admit: async () => ({ learn: true, recall: true, learnReason: null, recallReason: null, sessionId: null }) },
    historySearch: async () => { historyCalls += 1; return [{ conversationTitle: "Teapot", conversationUrl: "/chat/tea", messages: [{ sourceRole: "user", date: "2026-01-02", text: "The teapot is blue." }] }]; },
  }, { memoryEngineEnabled: true, memoryEnabled: true, memoryHistorySearchEnabled: true }, [{ name: "nohistory", config: { memoryHistorySearchEnabled: false } }]);
  t.after(() => group.close());
  const primary = createMemoryClient({ base: group.gateways.get("").base, token: "lab-test" });
  const variant = createMemoryClient({ base: group.gateways.get("nohistory").base, token: "lab-test" });
  const first = await primary.callTool("search", { query: "teapot" });
  const second = await variant.callTool("search", { query: "teapot" });
  assert.equal(first.isError, false); assert.equal(second.isError, false);
  assert.equal(first.blocks[0], second.blocks[0]);
  assert.match(first.blocks.join("\n"), /Original conversation excerpts/);
  assert.doesNotMatch(second.blocks.join("\n"), /Original conversation excerpts/);
  assert.equal(historyCalls, 1);
  assert.deepEqual(await primary.callTool("read", { uris: [uri] }), await variant.callTool("read", { uris: [uri] }));
  const request = `/api/v1/content/read?uri=${encodeURIComponent(uri)}`;
  assert.deepEqual(await primary.fetchJSON(request), await variant.fetchJSON(request));
});

test("verification feature detection delegates to the product prototype with limit and force", async () => {
  const prototype = NativeMemoryConsolidation.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "verifyExisting");
  try {
    delete prototype.verifyExisting;
    await assert.rejects(verifyLabExisting({}, "user"), { code: "verify_unavailable" });
    const consolidation = { marker: true };
    prototype.verifyExisting = async function (userId, options) {
      assert.equal(this, consolidation); assert.equal(userId, "user"); assert.deepEqual(options, { limit: 9, force: true });
      return { checked: 2, supported: 1, corrected: 1, unsupported: 0, unverifiable: 0, calls: 2 };
    };
    assert.equal((await verifyLabExisting(consolidation, "user", { limit: 9, force: true })).corrected, 1);
  } finally { if (original) Object.defineProperty(prototype, "verifyExisting", original); else delete prototype.verifyExisting; }
});

test("planting refreshes the overlay body and engine bytes without rejecting true evidence", async () => {
  let engine = "- 12 cups"; let held = { memoryType: "preferences", body: engine, projectId: "p1" };
  const revisions = [];
  const sessions = { memoryRoot: () => "viking://user/test/memories", read: async () => engine, replace: async (_user, _uri, text) => { engine = text; } };
  const overlay = { database: null, file: async () => held, addRevision: async (row) => revisions.push(row), upsertFile: async (row) => { held = { ...held, ...row }; } };
  await replaceLabFile({ sessions, overlay }, { userId: "u" }, "preferences/cups.md", "- 99 cups");
  assert.equal(engine, "- 99 cups"); assert.equal(held.body, engine); assert.equal(held.memoryType, "preferences");
  assert.equal(revisions[0].before, "- 12 cups"); assert.equal(revisions[0].reason, "eval_corruption");
  await assert.rejects(replaceLabFile({ sessions, overlay }, { userId: "u" }, "../bad.md", "bad"), /memory file path/);
});

async function runnerFixture(t, { questions = true } = {}) {
  const root = await scratch(t); const out = path.join(root, "r1");
  const corruptionsFile = path.join(root, "corruptions.json");
  await writeFile(corruptionsFile, JSON.stringify({ corruptions: [{ id: "c1", kind: "number", find: "12", replace: "99" }] }));
  const item = { caseId: "U01", userKey: "same-user", set: "synthetic-users", split: "dev", meta: { corruptionsFile },
    sessions: [1, 2].map((n) => ({ sessionId: `s${n}`, at: "2026-01-02T00:00:00Z", messages: [{ role: "user", text: "12 cups" }] })),
    questions: questions ? [1, 2].map((n) => ({ qid: `q${n}`, afterSession: n, text: "How many cups?", asOf: "2026-01-02T00:00:00Z" })) : [] };
  const events = []; const opened = []; let files = {};
  const dependencies = { loadCases: async () => [item], client: { model: "fake", thinking: "disabled" },
    openLab: async (options) => {
      opened.push(options);
      return { config: {}, account: options.account, facts: { engineVersion: "stub" }, redact: String, errorLine: firstLine,
        user: async () => ({ userId: "u" }), noteConversation: () => events.push("note"), close: async () => {},
        ingestSession: async (_user, session) => {
          events.push(`ingest:${session.sessionId}`); files = { "preferences/cups.md": "- 12 cups" };
          return { sessionId: session.sessionId, userTurns: 1, messages: 1, usage: { promptTokens: 0, completionTokens: 0 }, operations: { adds: 1, updates: 0, deletes: 0 }, commit: { status: "completed" }, ms: 0 };
        },
        snapshot: async () => { events.push("snapshot"); return { files: { ...files }, metrics: { files: Object.keys(files).length, chars: Object.values(files).join("").length } }; },
        replaceFile: async (_user, rel, text) => { events.push("plant"); files[rel] = text; },
        consolidate: async (_user, options) => { assert.deepEqual(options, { mode: "merge" }); events.push("consolidate"); files["preferences/cups.md"] = "- 12 cups"; return { outcome: "completed" }; },
        verifyExisting: async () => { events.push("verify"); throw Object.assign(new Error("verify_unavailable"), { code: "verify_unavailable" }); },
        memoryFor: (_user, { variant }) => ({ variant, residentBlock: async () => { events.push(`opening:${variant || "primary"}`); return Object.values(files).join(""); } }),
      };
    },
    answering: { answerQuestion: async ({ memory, qid, caseId }) => {
      events.push(`answer:${memory.variant || "primary"}`);
      const profileBlock = await memory.residentBlock();
      return { qid, caseId, answer: profileBlock, opening: { profileBlock }, toolCalls: [], rounds: 1, usage: { promptTokens: 0, completionTokens: 0 }, ms: 0 };
    } },
  };
  const args = [...base, "--out", out, "--data", path.join(root, "data"), "--engine-url", "http://127.0.0.1:1,http://127.0.0.1:2"];
  if (questions) { args.splice(args.indexOf("--ingest-only"), 1); args.push("--deepseek-key-file", "/fake", "--plugin-tgz", "/fake"); }
  return { out, item, events, opened, dependencies, args };
}

test("runner orders ingest, plant, maintenance, snapshot, primary and variant; maintenance failures continue", async (t) => {
  const f = await runnerFixture(t);
  const args = [...f.args, "--answer-variant", "nohistory:memoryHistorySearchEnabled=false", "--config", "memoryOpeningByUseEnabled=true", "--maintain", "consolidate+verify", "--maintain-after", "1", "--plant-corruptions-after", "1", "--no-rejection-judge", "--label", "E1 test"];
  const totals = await main(args, f.dependencies);
  assert.equal(totals.failures, 1); assert.equal(totals.answers, 4);
  assert.deepEqual(f.events, ["ingest:s1", "snapshot", "plant", "snapshot", "consolidate", "snapshot", "snapshot", "verify", "snapshot", "snapshot", "snapshot", "answer:primary", "opening:primary", "answer:nohistory", "opening:nohistory", "ingest:s2", "snapshot", "snapshot", "answer:primary", "opening:primary", "answer:nohistory", "opening:nohistory"]);
  assert.equal(f.opened.length, 2); assert.deepEqual(f.opened[0].configOverrides, { memoryOpeningByUseEnabled: true }); assert.equal(f.opened[0].rejectionJudge, false);
  const caseDir = path.join(f.out, "cases/U01");
  const primary = await jsonl(path.join(caseDir, "answers.jsonl"));
  assert.deepEqual(primary, await jsonl(path.join(caseDir, "answers.nohistory.jsonl")));
  assert.equal(primary[0].opening.profileBlock, "- 12 cups");
  const maintenance = await jsonl(path.join(caseDir, "maintenance.jsonl"));
  assert.deepEqual(maintenance.map((row) => [row.afterSession, row.kind, row.filesChanged]), [[1, "consolidate", ["preferences/cups.md"]], [1, "verify", []]]);
  assert.match(maintenance[1].result.error, /verify_unavailable/);
  assert.ok(maintenance.every((row) => Number.isFinite(row.ms) && !Number.isNaN(Date.parse(row.startedAt))));
  assert.deepEqual((await json(path.join(caseDir, "corruptions-restored.json"))).results, [{ id: "c1", status: "restored" }]);
  assert.equal((await json(path.join(caseDir, "snapshots/1.json"))).bloat.turns, 1);
  assert.equal((await json(path.join(caseDir, "snapshots/2.json"))).bloat.turns, 2);
  assert.equal((await json(path.join(caseDir, "bloat.json"))).addedPer100Turns, 100);
  const run = await json(path.join(f.out, "run.json"));
  assert.equal(run.label, "E1 test"); assert.deepEqual(run.flags.config, { memoryOpeningByUseEnabled: true }); assert.equal(run.answerVariants[0].name, "nohistory");
  assert.deepEqual(run.answerVariants[0].flags.config, { memoryOpeningByUseEnabled: true, memoryHistorySearchEnabled: false });
  const status = await readFile(path.join(f.out, "STATUS"), "utf8");
  assert.match(status, /DONE U01\/answer.nohistory\/q1/); assert.match(status, /FAIL U01\/maintain.verify\/1 verify_unavailable/);
  f.events.length = 0;
  const resumed = await main(args, f.dependencies);
  assert.equal(resumed.answers, 0); assert.ok(!f.events.includes("consolidate")); assert.ok(!f.events.some((event) => event.startsWith("ingest:")));
  assert.equal((await jsonl(path.join(caseDir, "maintenance.jsonl"))).length, 2);
});

test("maintenance adds explicit checkpoints; each visits existing checkpoints; completed steps resume", async (t) => {
  const f = await runnerFixture(t, { questions: false });
  await main([...f.args, "--maintain", "consolidate", "--maintain-after", "0,1,2"], f.dependencies);
  assert.equal((await jsonl(path.join(f.out, "cases/U01/maintenance.jsonl"))).length, 3);
  f.events.length = 0;
  await main([...f.args, "--maintain", "consolidate", "--maintain-after", "each"], f.dependencies);
  assert.deepEqual(f.events, ["note", "note"]);
});

test("old run directories resume single-engine metadata and STATUS keys; changed shards fail before open", async (t) => {
  const f = await runnerFixture(t, { questions: false });
  const caseDir = path.join(f.out, "cases/U01");
  await mkdir(path.join(caseDir, "snapshots"), { recursive: true });
  await writeFile(path.join(f.out, "run.json"), JSON.stringify({ runId: "r1", set: "synthetic-users", split: "dev", arm: "product", engine: { url: "http://127.0.0.1:1" }, flags: { historySearch: true } }));
  await writeFile(path.join(f.out, "STATUS"), "2026-01-01T00:00:00Z DONE U01/ingest/s1 old\n2026-01-01T00:00:00Z DONE U01/ingest/s2 old\n2026-01-01T00:00:00Z DONE U01/snapshot/2 old\n");
  await writeFile(path.join(caseDir, "snapshots/2.json"), JSON.stringify({ afterSession: 2, files: { "preferences/cups.md": "- 12 cups" } }));
  const totals = await main([...f.args, "--engine-url", "http://127.0.0.1:1"], f.dependencies);
  assert.equal(totals.skipped, 2); assert.equal(totals.sessions, 0); assert.deepEqual(f.events, ["note", "note"]);
  const resumedRun = await json(path.join(f.out, "run.json"));
  assert.equal(resumedRun.resumes.length, 1);
  assert.deepEqual(resumedRun.flags.config, {});
  assert.deepEqual(resumedRun.engine.urls, ["http://127.0.0.1:1"]);
  assert.deepEqual(resumedRun.answerVariants, []);
  assert.equal((await json(path.join(caseDir, "bloat.json"))).files, 1);
  f.opened.length = 0;
  await assert.rejects(main(f.args, f.dependencies), /different engine URL list/);
  assert.equal(f.opened.length, 0);
});


test("a failed final maintenance step retries on resume, refreshing the previously completed snapshot", async (t) => {
  const f = await runnerFixture(t, { questions: false });
  const open = f.dependencies.openLab;
  let round = 0;
  f.dependencies.openLab = async (options) => {
    const lab = await open(options);
    lab.consolidate = async () => {
      if (round++ === 0) throw new Error("temporary maintenance failure");
      await lab.replaceFile(null, "preferences/cups.md", "- 7 cups");
      return { outcome: "completed" };
    };
    return lab;
  };
  const args = [...f.args, "--engine-url", "http://127.0.0.1:1", "--maintain", "consolidate", "--maintain-after", "2"];
  assert.equal((await main(args, f.dependencies)).failures, 1);
  const snapshot = path.join(f.out, "cases/U01/snapshots/2.json");
  assert.equal((await json(snapshot)).files["preferences/cups.md"], "- 12 cups");
  assert.equal((await main(args, f.dependencies)).failures, 0);
  assert.equal((await json(snapshot)).files["preferences/cups.md"], "- 7 cups");
  const rows = await jsonl(path.join(f.out, "cases/U01/maintenance.jsonl"));
  assert.equal(rows.length, 2);
  assert.match(rows[0].result.error, /temporary maintenance failure/);
  assert.deepEqual(rows[1].filesChanged, ["preferences/cups.md"]);
});

test("runner sends every userKey to its hash-selected engine and serializes cases sharing memory", async (t) => {
  const f = await runnerFixture(t, { questions: false });
  const items = [
    { ...f.item, caseId: "A", userKey: "shared" },
    { ...f.item, caseId: "B", userKey: "other" },
    { ...f.item, caseId: "C", userKey: "shared" },
  ];
  f.dependencies.loadCases = async () => items;
  const open = f.dependencies.openLab;
  const assignments = [];
  let sharedInFlight = 0;
  f.dependencies.openLab = async (options) => {
    const lab = await open(options);
    lab.user = async (userKey) => { assignments.push([userKey, options.engineUrl]); return { userId: userKey }; };
    const ingest = lab.ingestSession;
    lab.ingestSession = async (user, session) => {
      if (user.userId === "shared") { sharedInFlight += 1; assert.equal(sharedInFlight, 1); }
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await ingest(user, session);
      if (user.userId === "shared") sharedInFlight -= 1;
      return result;
    };
    return lab;
  };
  assert.equal((await main(f.args, f.dependencies)).failures, 0);
  const urls = ["http://127.0.0.1:1", "http://127.0.0.1:2"];
  assert.equal(assignments.length, 3);
  for (const [key, url] of assignments) assert.equal(url, urls[engineShard(key, urls.length)]);
});


test("no-maintenance corruption control reports actual restoration state and skips absent targets", async (t) => {
  const f = await runnerFixture(t, { questions: false });
  await writeFile(f.item.meta.corruptionsFile, JSON.stringify({ corruptions: [
    { id: "c1", kind: "number", find: "12", replace: "99" },
    { id: "not-yet-present", kind: "number", find: "unseen", replace: "bad" },
  ] }));
  await main([...f.args, "--plant-corruptions-after", "2"], f.dependencies);
  const dir = path.join(f.out, "cases/U01");
  assert.equal((await json(path.join(dir, "corruptions-applied.json"))).skipped.length, 1);
  assert.deepEqual((await json(path.join(dir, "corruptions-restored.json"))).results, [{ id: "c1", status: "still_corrupt" }]);
});

test("maintenance passes the configured verify mode and records product summaries unchanged", async (t) => {
  const f = await runnerFixture(t, { questions: false });
  const open = f.dependencies.openLab;
  const calls = [];
  const summary = { checked: 3, supported: 1, corrected: 1, unsupported: 0, unverifiable: 1, calls: 2 };
  f.dependencies.openLab = async (options) => ({ ...await open(options),
    consolidate: async (_user, opts) => { calls.push(opts); return { outcome: "completed", mode: "verify" }; },
    verifyExisting: async (_user, opts) => { calls.push(opts); return summary; },
  });
  await main([...f.args, "--config", "nativeMemoryConsolidationMode=verify", "--maintain", "consolidate+verify", "--maintain-after", "2"], f.dependencies);
  assert.deepEqual(calls, [{ mode: "verify" }, { limit: 200, mode: "verify" }]);
  assert.deepEqual((await jsonl(path.join(f.out, "cases/U01/maintenance.jsonl")))[1].result, summary);
});


test("lab resident providers use the product's scoped index and native files for default projects and variants", async () => {
  const calls = [];
  const memorySettings = { settings: async () => ({ learningPaused: false, recallPaused: false, pausedProjects: [] }), sessionState: async () => ({}) };
  const nativeMemory = {
    residentCard: async () => { throw new Error("default projects have no card"); },
    openingFiles: async (...args) => { calls.push(["files", ...args]); return [{ uri: "viking://user/u/memories/notes/n.md", usedCount: 2, body: "A useful fact" }]; },
    openingIndex: async (...args) => { calls.push(["index", ...args]); return { counts: { notes: 3 } }; },
  };
  const config = { memoryRecallEnabled: true, memoryEngineEnabled: true, memoryOpeningIndexEnabled: true, memoryOpeningByUseEnabled: true, memoryOpeningTopK: 2 };
  const providers = createLabResidentProfiles({ config, memorySettings, nativeMemory });
  const result = await providers.forDispatch("u", { projectId: "default", sessionId: null, attended: true });
  assert.match(result.text, /notes 3/); assert.match(result.text, /Most used/); assert.match(result.text, /A useful fact/);
  assert.deepEqual(calls, [["files", "u", "default", 2], ["index", "u", "default"]]);
  calls.length = 0;
  const off = createLabResidentProfiles({ config: { ...config, memoryOpeningIndexEnabled: false, memoryOpeningByUseEnabled: false }, memorySettings, nativeMemory });
  assert.equal((await off.forDispatch("u", { projectId: "default", sessionId: null })).text, "");
  assert.deepEqual(calls, []);
});

test("lab consolidation polls the explicit product entry with force and retains its results", async () => {
  const results = ["submitted", { outcome: "submitted", taskId: "t1" }, { outcome: "completed", checked: 2 }];
  const seen = [];
  const consolidation = { consolidate: async (...args) => { seen.push(args); return results[seen.length - 1]; } };
  const result = await pollLabConsolidation(consolidation, "u", { mode: "verify", pollMs: 1 });
  assert.equal(result.outcome, "completed"); assert.deepEqual(result.results, results);
  assert.deepEqual(seen, Array.from({ length: 3 }, () => ["u", { mode: "verify", force: true }]));
  assert.equal((await pollLabConsolidation({ consolidate: async () => "submitted" }, "u", { timeoutMs: 0 })).outcome, "submitted");
});

test('answers-only refuses incomplete ingestion and never calls ingestion', async t => {
  const f = await runnerFixture(t);
  const result = await main([...f.args, '--answers-only'], f.dependencies);
  assert.equal(result.failures, 1);
  assert.equal(result.sessions, 0);
  assert.equal(f.events.some(e => e.startsWith('ingest:')), false);
  assert.match(await readFile(path.join(f.out, 'STATUS'), 'utf8'), /answers_only_incomplete_ingestion/);
});

test('new answer variants reuse settled memory, select their own model and preserve earlier variants on resume', async t => {
  const f = await runnerFixture(t);
  f.item.questions = [f.item.questions[1]];
  await main([...f.args, '--answer-variant', 'prior:memorySearchHintEnabled=true'], f.dependencies);
  f.events.length = 0;
  const captured = [];
  f.dependencies.answering.answerQuestion = async input => {
    captured.push(input);
    return { qid: input.qid, caseId: input.caseId, answer: 'fixture', toolCalls: [], usage: {}, model: { name: input.client.model }, fullContext: { truncated: true } };
  };
  const args = [...f.args, '--answers-only', '--variants-only', '--answer-variant', 'strong:forceSearch=all,answerModel=qwen3.8-max'];
  const result = await main(args, f.dependencies);
  assert.equal(result.sessions, 0); assert.equal(result.answers, 1);
  assert.equal(captured[0].client.model, 'qwen3.8-max');
  assert.equal(captured[0].forceSearch, 'all'); assert.equal(captured[0].sessions.length, 2);
  assert.equal(f.events.some(e => e.startsWith('ingest:')), false);
  assert.deepEqual(f.opened.at(-1).answerVariants[0].config, {});
  const manifest = await json(path.join(f.out, 'run.json'));
  assert.deepEqual(manifest.answerVariants.map(v => v.name), ['prior', 'strong']);
  assert.equal(manifest.answerVariants[1].model.answerJudgeSameFamily, true);
  assert.equal(manifest.answerStats.strong.truncatedQuestions, 1);
  const opens = f.opened.length;
  await assert.rejects(main([...f.args, '--answers-only', '--answer-variant', 'strong:forceSearch=history'], f.dependencies), /variant strong changed/);
  assert.equal(f.opened.length, opens);
});
