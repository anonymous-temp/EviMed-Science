// 「从其他 AI 导入」 over HTTP, on a real PostgreSQL and a stub engine (the model that splits the text is stubbed): the pasted text becomes an
// offer, the person's choice becomes messages to the engine in the form its templates read as an import, and each limit answers by name.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createMemoryRoutes } from "../src/memoryRoutes.mjs";
import { NativeMemoryImport } from "../src/nativeMemoryImport.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { NativeMemoryOverlay } from "../src/nativeMemoryOverlay.mjs";
import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";
import { NativeMemoryWorker } from "../src/nativeMemoryWorker.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { MemorySettingsStore } from "../src/memorySettings.mjs";
import { migrateMemorySettings } from "../src/memorySettingsPersistence.mjs";
import { HttpError, sendJson } from "../src/security.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const config = { memoryEngineEnabled: true, memoryEnabled: true, maxJsonBytes: 1_000_000, deepseekProviderEnabled: true, deepseekApiKey: "k", deepseekModel: "deepseek-v4-flash", memoryImportOffersPerHour: 3 };

/** @type {ControlPlaneDatabase} */
let database;
const users = [];
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateMemorySettings(database);
});
after(async () => {
  if (!url) return;
  for (const id of users) await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
  await database.close();
});

const PASTED = "- 我是心内科医生，主要做房颤的临床研究\n- 我对青霉素过敏\n- 我的邮箱密码是 Xk9#mQ2vLpR7\n- 回答尽量简短";
const MODEL_ANSWER = JSON.stringify({ statements: [
  { line: 1, text: "我是心内科医生，主要做房颤的临床研究", tier: "ordinary" },
  { line: 2, text: "我对青霉素过敏", tier: "on_request" },
  { line: 3, text: "我有一个邮箱密码", tier: "never" },
  { line: 4, text: "回答尽量简短", tier: "ordinary" },
] });

async function fixture(t, { answer = MODEL_ANSWER, extract = () => ({}), perHour } = {}) {
  resetNativeMemoryMetrics();
  const userId = `ni_${randomUUID().slice(0, 8)}`;
  users.push(userId);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Import test','development')", [userId]);
  const stub = await startOpenVikingStub(t, { extract });
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const overlay = new NativeMemoryOverlay({ database });
  const memorySettings = new MemorySettingsStore(config, { database });
  const nativeMemory = new NativeMemoryStore({ sessions, overlay });
  const worker = new NativeMemoryWorker({ config, memorySettings, sessions, overlay });
  const models = [];
  const nativeMemoryImport = new NativeMemoryImport({
    config: { ...config, ...(perHour === undefined ? {} : { memoryImportOffersPerHour: perHour }) }, overlay, nativeMemory, memorySettings,
    callModel: async (_deps, call) => { models.push(call); if (answer instanceof Error) throw answer; return { choices: [{ message: { content: typeof answer === "function" ? answer(call) : answer } }] }; },
  });
  const audits = [];
  const routes = createMemoryRoutes({
    config, memorySettings, nativeMemory, nativeMemoryImport,
    store: { ensureUser: async () => ({ id: userId }), requireProject: async (_user, id) => { if (id === "p_missing") throw new HttpError(404, "project_not_found", "x"); return { id }; } },
    context: async () => ({ user: { id: userId, name: "Import test" }, project: { id: "p1" } }),
    audit: async (_ctx, action, outcome, detail) => { audits.push({ action, outcome, detail }); },
    decodeRouteComponent: (value) => decodeURIComponent(value),
  });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) sendJson(res, 404, { error: { code: "not_found" } }); })
      .catch((error) => sendJson(res, error?.status ?? 500, { error: { code: error?.code ?? "internal", message: String(error?.message ?? "") } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body = undefined) => {
    const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const engineUser = sessions.engineUser(userId);
  await sessions.register(userId);
  const importMessages = () => stub.requests.filter((request) => request.method === "POST" && /\/messages$/.test(request.path) && request.path.includes("evimed-import-")).map((request) => request.body.parts[0].text);
  return { userId, stub, sessions, overlay, memorySettings, call, audits, worker, engineUser, models, importMessages };
}

test("the pasted text is read into an offer: ordinary statements ticked, the private ones unticked, and what is never kept only counted", options, async (t) => {
  const f = await fixture(t);
  const offered = await f.call("POST", "/api/memory/import", { text: PASTED });
  assert.equal(offered.status, 200);
  const data = offered.json.data;
  assert.match(data.id, /^imp_[a-f0-9]{24}$/);
  assert.deepEqual(data.statements.map((statement) => [statement.text, statement.sensitivity, statement.ticked]), [
    ["我是心内科医生，主要做房颤的临床研究", "ordinary", true], ["我对青霉素过敏", "on_request", false], ["回答尽量简短", "ordinary", true],
  ]);
  assert.equal(data.leftOut, 1, "one line was left out because it is never kept");
  assert.equal(JSON.stringify(offered.json).includes("密码"), false, "and nothing of it travels back");
  assert.equal(f.models.length, 1, "one model call");
  assert.equal(f.models[0].purpose, "memory-extraction");
  assert.equal(f.models[0].body.thinking.type, "disabled");
  assert.deepEqual(f.stub.requests.filter((request) => request.path.includes("/messages")), [], "nothing reached the engine before the person decided");
  const held = await f.overlay.importOffer(f.userId, data.id);
  assert.equal(JSON.stringify(held.statements).includes("邮箱密码"), false, "the offer on the server does not hold the words of a never-kept line either");
  assert.deepEqual(f.audits.map((entry) => entry.action), ["memory.import.offer"]);
});

test("saving hands the engine the ticked statements in the form its templates read as an import, a session of its own, and the offer is spent", options, async (t) => {
  const f = await fixture(t);
  const { data } = (await f.call("POST", "/api/memory/import", { text: PASTED })).json;
  const saved = await f.call("POST", `/api/memory/import/${data.id}/confirm`, {});
  assert.equal(saved.status, 200);
  assert.equal(saved.json.data.saved, 2, "the ticked ones, by default");
  const [message] = f.importMessages();
  assert.equal(message, "这是我在另一个 AI 助手里的记忆导出，请把它们导入到这里：\n- 我是心内科医生，主要做房颤的临床研究\n- 回答尽量简短");
  const commits = await f.overlay.commitsOf(f.userId);
  assert.deepEqual(commits.map((commit) => [commit.origin, commit.engineSession.startsWith("evimed-import-")]), [["import", true]]);
  assert.equal((await f.call("GET", "/api/memory/profile")).json.data.pending.length, 0, "an import is no 「正在记住」 row of the page's own one-liner");
  // Spent: a second confirm answers what was saved and sends nothing again; the statements are gone from the server.
  assert.equal((await f.call("POST", `/api/memory/import/${data.id}/confirm`, {})).json.data.saved, 2);
  assert.equal(f.importMessages().length, 1);
  assert.deepEqual((await f.overlay.importOffer(f.userId, data.id)).statements, []);
  assert.deepEqual(f.audits.map((entry) => entry.action), ["memory.import.offer", "memory.import.save", "memory.import.save"]);
  assert.equal(nativeMemoryCounters().imports.saved, 1);
});

test("the person's own choice: a ticked private statement goes apart as an explicit request, an unticked one is not sent, and an id the offer did not make is ignored", options, async (t) => {
  const f = await fixture(t);
  const { data } = (await f.call("POST", "/api/memory/import", { text: PASTED })).json;
  const allergy = data.statements.find((statement) => statement.sensitivity === "on_request").id;
  const brief = data.statements.find((statement) => statement.text === "回答尽量简短").id;
  const saved = await f.call("POST", `/api/memory/import/${data.id}/confirm`, { ids: [allergy, brief, "s99"] });
  assert.equal(saved.json.data.saved, 2);
  assert.equal(f.importMessages()[0], "这是我在另一个 AI 助手里的记忆导出，请把它们导入到这里：\n- 回答尽量简短\n我明确要求记住下面这几条：\n- 我对青霉素过敏");
  const g = await fixture(t);
  const offered = (await g.call("POST", "/api/memory/import", { text: PASTED })).json.data;
  assert.equal((await g.call("POST", `/api/memory/import/${offered.id}/confirm`, { ids: [] })).json.data.saved, 0, "nothing ticked saves nothing");
  assert.equal(g.importMessages().length, 0);
});

test("more than ten statements go in messages of ten, so an extraction is not given fifty lines at once", options, async (t) => {
  const many = Array.from({ length: 23 }, (_, index) => `用的第${index + 1}种工具是编号${index + 1}的软件`);
  const f = await fixture(t, { answer: JSON.stringify({ statements: many.map((text, index) => ({ line: index + 1, text, tier: "ordinary" })) }) });
  const { data } = (await f.call("POST", "/api/memory/import", { text: many.map((line) => `- ${line}`).join("\n") })).json;
  assert.equal(data.statements.length, 23);
  assert.equal((await f.call("POST", `/api/memory/import/${data.id}/confirm`, {})).json.data.saved, 23);
  const messages = f.importMessages();
  assert.deepEqual(messages.map((message) => message.split("\n").length - 1), [10, 10, 3]);
});

test("what the engine writes from an import reads 「从其他 AI 导入」 and is the person's: the never rules apply a second time at the engine", options, async (t) => {
  /** @type {any} */
  let f;
  f = await fixture(t, { extract: ({ session, messages }) => {
    if (!session.startsWith("evimed-import-")) return {};
    const said = messages.map((message) => message.parts.map((part) => part.text).join("")).join("\n");
    return { adds: [{ uri: `viking://user/${f.engineUser}/memories/profile.md`, memory_type: "profile", after: `# 用户\n${said.split("\n").filter((line) => line.startsWith("- ")).map((line) => `${line} (as of 2026-10-25)`).join("\n")}` }] };
  } });
  const { data } = (await f.call("POST", "/api/memory/import", { text: PASTED })).json;
  await f.call("POST", `/api/memory/import/${data.id}/confirm`, {});
  await f.worker.processCommits({ userId: f.userId });
  const profile = (await f.call("GET", "/api/memory/profile")).json.data;
  const lines = profile.records.filter((record) => record.document);
  assert.deepEqual(lines.map((line) => line.value).sort(), ["回答尽量简短", "我是心内科医生，主要做房颤的临床研究"].sort());
  for (const line of lines) assert.deepEqual(line.evidence.map((item) => item.label), ["从其他 AI 导入"], line.value);
});

test("a model that cannot be read, a paused account, an hour's worth of offers, a gone offer and a bad body each answer by name", options, async (t) => {
  const unreadable = await fixture(t, { answer: "this is not json" });
  const refused = await unreadable.call("POST", "/api/memory/import", { text: PASTED });
  assert.deepEqual([refused.status, refused.json.error.code], [503, "memory_import_unavailable"]);
  assert.equal((await unreadable.overlay.importsSince(unreadable.userId, new Date(Date.now() - 3_600_000))), 0, "no offer was made");
  const failing = await fixture(t, { answer: new Error("model unreachable") });
  assert.equal((await failing.call("POST", "/api/memory/import", { text: PASTED })).json.error.code, "memory_import_unavailable");
  assert.ok(nativeMemoryCounters().imports.model_failed >= 1);

  const paused = await fixture(t);
  await paused.memorySettings.updateSettings(paused.userId, { learningPaused: true });
  const refusedPaused = await paused.call("POST", "/api/memory/import", { text: PASTED });
  assert.deepEqual([refusedPaused.status, refusedPaused.json.error.code], [409, "memory_import_paused"]);
  assert.equal(paused.models.length, 0, "nothing was read for an account that keeps nothing");

  const limited = await fixture(t);
  for (let index = 0; index < 3; index += 1) assert.equal((await limited.call("POST", "/api/memory/import", { text: PASTED })).status, 200);
  const over = await limited.call("POST", "/api/memory/import", { text: PASTED });
  assert.deepEqual([over.status, over.json.error.code], [429, "memory_import_rate_limited"]);
  assert.equal(limited.models.length, 3, "the model was not asked a fourth time");
  assert.ok(nativeMemoryCounters().imports.rate_limited >= 1);
  const off = await fixture(t, { perHour: 0 });
  assert.equal((await off.call("POST", "/api/memory/import", { text: PASTED })).json.error.code, "memory_import_rate_limited", "0 refuses every import");

  const gone = await fixture(t);
  assert.deepEqual([(await gone.call("POST", "/api/memory/import/imp_000000000000000000000000/confirm", {})).status, (await gone.call("POST", "/api/memory/import/not-an-id/confirm", {})).json.error.code], [404, "memory_import_expired"]);
  const expired = (await gone.call("POST", "/api/memory/import", { text: PASTED })).json.data;
  await database.query("UPDATE evimed_memory.native_imports SET expires_at = clock_timestamp() - interval '1 minute' WHERE id=$1", [expired.id]);
  assert.equal((await gone.call("POST", `/api/memory/import/${expired.id}/confirm`, {})).json.error.code, "memory_import_expired");
  assert.equal(await gone.overlay.deleteExpiredImports(), 1, "an offer nobody saved is not kept past its hour");

  const bad = await fixture(t);
  assert.equal((await bad.call("POST", "/api/memory/import", { text: "" })).status, 400);
  assert.equal((await bad.call("POST", "/api/memory/import", { text: "x".repeat(8_001) })).status, 400);
  assert.equal((await bad.call("POST", "/api/memory/import", { text: PASTED, extra: 1 })).status, 400);
  assert.equal((await bad.call("POST", "/api/memory/import/imp_000000000000000000000000/confirm", { ids: "all" })).status, 400);
  assert.equal(bad.models.length, 0);
});

test("an offer belongs to the account that asked for it", options, async (t) => {
  const f = await fixture(t);
  const { data } = (await f.call("POST", "/api/memory/import", { text: PASTED })).json;
  const other = await fixture(t);
  assert.equal((await other.call("POST", `/api/memory/import/${data.id}/confirm`, {})).json.error.code, "memory_import_expired", "another account cannot spend it");
});
