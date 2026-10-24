// Re-records the wire fixtures of this directory from a running OpenViking server of the pinned release.
//
//   OV_URL=http://127.0.0.1:19330 OV_KEY_FILE=<root key file> OV_ACCOUNT=<throwaway account> node record.mjs <out dir> [top|engine|memory|knowledge ...]
//
// Nothing is authored. Each file is an exchange the server really answered: the requests are the ones this repository's
// `OpenVikingClient` and `OpenVikingEngine` build (the top-level files and `engine/`) or the plain HTTP calls the two earlier
// recorders made (`memory/`, `knowledge/`), and what was answered is saved as it was sent, re-indented. The root key is never
// written (a placeholder takes its place) and the throwaway account the run used is written as `evimed`, the name of the
// production account, so that a recording does not depend on which account it was taken in.
//
// What it cannot record is named in `fixtures/*/provenance.json` (`notRecorded`): an extraction that fails because the
// model gateway answers 402 needs a gateway that does, and a server without the built-in bot or the template directory
// needs another server. The account is deleted at the end unless OV_KEEP_ACCOUNT=1.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { OpenVikingClient, memoryUri, userMemoryRoot } from "../../../apps/server/src/openVikingClient.mjs";
import { OpenVikingEngine } from "../../../apps/server/src/openVikingEngine.mjs";

const OUT = path.resolve(process.argv[2] ?? "");
const WANT = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ["top", "engine", "memory", "knowledge"]);
const BASE = (process.env.OV_URL ?? "http://127.0.0.1:19330").replace(/\/+$/, "");
const KEY = fs.readFileSync(process.env.OV_KEY_FILE ?? "", "utf8").trim();
const ACCOUNT = process.env.OV_ACCOUNT ?? `rec-${randomBytes(4).toString("hex")}`;
const PIN = JSON.parse(fs.readFileSync(new URL("../../../deps-version.json", import.meta.url), "utf8")).openviking;
const IMAGE = `${PIN.image}:${PIN.imageTag}`;
const KEY_PLACEHOLDER = "recorded-against-a-real-server";
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (!fs.statSync(OUT).isDirectory()) throw new Error("the first argument is the directory to write into");

/** Retries of a dropped connection ("other side closed", a reset through the tunnel): the request never reached a handler. */
async function fetchOnce(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (!["UND_ERR_SOCKET", "ECONNRESET"].includes(error?.cause?.code) || attempt >= 3) throw error;
      await sleep(1_000 * (attempt + 1));
    }
  }
}

/** The throwaway account is written under the production name (or the one a scenario is about). */
let shownAccount = "evimed";
const shown = (text) => String(text).split(ACCOUNT).join(shownAccount);
const write = (file, value) => {
  fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
  fs.writeFileSync(path.join(OUT, file), typeof value === "string" || Buffer.isBuffer(value) ? value : shown(`${JSON.stringify(value, null, 2)}\n`));
};

/** One trusted request, as the control plane makes it: the root key, the account and the acting user. */
async function raw(user, method, route, body, { headers = {}, keyed = true, account = ACCOUNT, timeoutMs = 300_000, binary = false } = {}) {
  const sent = {
    ...(keyed ? { "X-API-Key": KEY } : {}),
    ...(account ? { "X-OpenViking-Account": account } : {}),
    ...(user ? { "X-OpenViking-User": user } : {}),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...headers,
  };
  const started = Date.now();
  const response = await fetchOnce(`${BASE}${route}`, { method, headers: sent, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = binary ? "" : bytes.toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, bytes, contentType: response.headers.get("content-type"), ms: Date.now() - started, sent };
}

async function pollTask(user, taskId, { everyMs = 2_000, limitMs = 900_000, onPoll = () => {} } = {}) {
  const deadline = Date.now() + limitMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await raw(user, "GET", `/api/v1/tasks/${taskId}?include_events=true`);
    onPoll(last);
    if (["completed", "failed", "cancelled"].includes(last.json?.result?.status)) return last;
    await sleep(everyMs);
  }
  return last;
}

/**
 * The queues that a write or a compile feeds are empty (the server is shared with other work, so a session commit of someone
 * else in progress is not waited for, the wait is bounded, and its end is not an error).
 */
async function waitIdle(user, limitMs = 90_000) {
  const deadline = Date.now() + limitMs;
  let calm = 0;
  while (Date.now() < deadline) {
    const rows = ((await raw(user, "GET", "/api/v1/observer/queue")).json?.result?.status ?? "").split("\n").map((line) => line.split("|").map((cell) => cell.trim()));
    const busy = rows.filter((cells) => ["Embedding", "Semantic", "Semantic-Nodes", "AddResource", "Reindex"].includes(cells[1]) && (cells[2] !== "0" || cells[3] !== "0"));
    if (!busy.length) { calm += 1; if (calm >= 3) return true; } else calm = 0;
    await sleep(2_000);
  }
  return false;
}

// ----------------------------------------------------------------------------------------------------------------------
// The five calls the client has always made, recorded through the client itself.

async function recordTop() {
  const captured = [];
  const recordingFetch = async (url, init) => {
    const response = await fetchOnce(url, init);
    const text = await response.text();
    captured.push({ method: init.method, url: String(url).replace(BASE, ""), body: init.body ? JSON.parse(init.body) : null, status: response.status, text });
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const client = new OpenVikingClient({ openVikingUrl: BASE, openVikingApiKey: KEY, openVikingAccount: ACCOUNT, openVikingRequestTimeoutMs: 60_000 }, { fetchImpl: recordingFetch });
  const last = () => captured[captured.length - 1];
  const index = [];
  const save = (name, note) => {
    const exchange = last();
    const body = JSON.parse(exchange.text);
    write(name, body);
    index.push({ file: name, method: exchange.method, path: shown(exchange.url), requestBody: exchange.body && JSON.parse(shown(JSON.stringify(exchange.body))), status: exchange.status, ...(note ? { note } : {}) });
  };
  const user = "usr_contract_fixture_v050";
  const records = [
    ["preference", "rec1", "偏好 / 报告呈现\n\n用户偏好用表格呈现证据强度，不要大段散文。"],
    ["analysis", "rec2", "分析 / 心衰\n\n本项目研究 SGLT2 抑制剂在射血分数保留心衰中的证据。"],
    ["preference", "rec3", "偏好 / 检索顺序\n\n用户习惯先看系统评价，再看单项随机对照试验。"],
    ["note", "rec4", "备注 / 物流\n\n仓库盘点改在每周五下午进行，由值班主管签字。"],
  ];
  await client.status();
  save("health.json");
  for (const [kind, recordId, text] of records) {
    await client.write(user, memoryUri(user, { scope: "user", scopeId: "", kind, recordId }), text, { wait: true });
    if (recordId === "rec1") save("content-write.json");
  }
  await sleep(1_500);
  await client.find(user, "报告里的证据强度用什么形式呈现？", { targets: [`${userMemoryRoot(user)}/user`], limit: 4 });
  const found = JSON.parse(last().text);
  const allHits = found.result.memories.map((hit) => ({ uri: hit.uri.split("/").slice(-2).join("/"), score: hit.score }));
  // Trimmed to the first three hits of the four written, as the fixture it replaces was; nothing added or renamed.
  found.result.memories = found.result.memories.slice(0, 3);
  write("find.json", found);
  index.push({ file: "find.json", method: "POST", path: last().url, requestBody: last().body, status: last().status, note: "trimmed to the first three hits of four" });
  await client.list(user, `${userMemoryRoot(user)}/user`);
  save("fs-ls.json");
  await client.list(user, `${userMemoryRoot(user)}/user/preference`);
  save("fs-ls-leaves.json");
  await client.list(user, `${userMemoryRoot(user)}/user/absent`).catch(() => {});
  save("fs-ls-missing.json");
  const unauthenticated = new OpenVikingClient({ openVikingUrl: BASE, openVikingApiKey: "", openVikingAccount: ACCOUNT, openVikingRequestTimeoutMs: 60_000 }, { fetchImpl: recordingFetch });
  await unauthenticated.find(user, "报告呈现", { limit: 3 }).catch(() => {});
  save("find-unauthenticated.json");
  await client.remove(user, memoryUri(user, { scope: "user", scopeId: "", kind: "note", recordId: "rec4" }));
  save("fs-delete.json");
  await client.remove(user, memoryUri(user, { scope: "user", scopeId: "", kind: "note", recordId: "rec4" }));
  save("fs-delete-missing.json");
  write("_top-recorded.json", { recordedAt: new Date().toISOString(), allFindHits: allHits, exchanges: index });
  console.log("top", index.map((entry) => `${entry.status} ${entry.file}`).join(", "), JSON.stringify(allHits));
}

// ----------------------------------------------------------------------------------------------------------------------
// The engine check, run against the real server and recorded exchange by exchange. Twice, in one fresh account: the first
// time the account is not registered yet and the skills are not installed (a new volume), the second time everything holds.

function recordingEngine(account, { wait = sleep } = {}) {
  /** @type {any[]} */
  const exchanges = [];
  const recordingFetch = async (url, init) => {
    const target = new URL(url);
    const response = await fetchOnce(url, init);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    const entry = {
      method: init.method, path: target.pathname, query: Object.fromEntries(target.searchParams),
      actingUser: init.headers["X-OpenViking-User"] ?? null,
      idempotencyKey: init.headers["Idempotency-Key"] ? "<random>" : null,
      requestBody: init.body ? JSON.parse(init.body) : null,
      status: response.status, contentType,
    };
    // The skill's text is the shipped file (`openVikingSkills/`): its digest says which one was sent.
    if (entry.requestBody && typeof entry.requestBody.data === "string" && target.pathname === "/api/v1/skills") entry.requestBody.data = `<SKILL.md, sha256 ${sha256(entry.requestBody.data)}>`;
    if (target.pathname === "/api/v1/content/download" && response.ok) {
      const name = /skills\/([^/]+)\/SKILL\.md$/.exec(target.searchParams.get("uri") ?? "")?.[1];
      entry.bodySha256 = sha256(bytes);
      entry.bodyFile = `installed-${name}.skill.md`;
      write(`engine/${entry.bodyFile}`, bytes);
    } else {
      try { entry.response = JSON.parse(bytes.toString("utf8")); } catch { entry.response = bytes.toString("utf8"); }
    }
    exchanges.push(entry);
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  const client = new OpenVikingClient({ openVikingUrl: BASE, openVikingApiKey: KEY, openVikingAccount: account, openVikingRequestTimeoutMs: 60_000 }, { fetchImpl: recordingFetch });
  const engine = new OpenVikingEngine({ client, config: { openVikingModelKey: "a-service-key-of-credential-length-0123" }, pin: { version: PIN.version, skills: PIN.skills }, wait });
  return { engine, exchanges };
}

/**
 * Polls of the probe's task in the middle of a run that kept the same status and stage are one poll and a note: the first
 * and the last poll of the task and every change are kept (the server looks at its Compile runtime every 30 s, so a probe is
 * polled thirty times for two answers).
 */
function trimPolls(exchanges) {
  const isPoll = (entry) => entry.method === "GET" && /\/tasks\/cmp_/.test(entry.path);
  const stateOf = (entry) => `${entry.response?.result?.status}|${entry.response?.result?.stage}`;
  const lastPoll = exchanges.map(isPoll).lastIndexOf(true);
  const kept = [];
  let dropped = 0;
  let previous = null;
  for (const [position, entry] of exchanges.entries()) {
    if (isPoll(entry) && previous && position !== lastPoll && stateOf(entry) === stateOf(previous)) { dropped += 1; continue; }
    kept.push(entry);
    if (isPoll(entry)) previous = entry;
  }
  return { exchanges: kept, dropped };
}

async function recordEngine() {
  const stamp = () => new Date().toISOString();
  const shape = "exchanges are in the order the check made them: method, path, query, the acting engine user, the request body, the status and the response as sent. An installed SKILL.md is the file named in bodyFile, whose sha256 is bodySha256.";
  const scenario = async (name, label, note) => {
    shownAccount = label;
    const { engine, exchanges } = recordingEngine(ACCOUNT);
    const status = await engine.check();
    const trimmed = trimPolls(exchanges);
    write(`engine/${name}.json`, {
      recordedFrom: IMAGE, recordedAt: stamp(), note,
      verdict: { ok: status.ok, facts: status.facts, degraded: status.degraded },
      exchanges: trimmed.exchanges,
      ...(trimmed.dropped ? { trimmed: `${trimmed.dropped} polls of the probe task that kept the status and stage of the one before were removed` } : {}),
      shape,
    });
    console.log("engine", name, JSON.stringify(Object.fromEntries(Object.entries(status.facts).map(([fact, value]) => [fact, value.ok ? "ok" : value.code]))));
    return status;
  };
  await scenario("engine-check-new-volume", "evimed-fresh",
    "The check run as an account the server has never seen, which is what a new volume answers for the first minutes: the admin routes do not know the account until the batched identity registration has run. The two skills are installed by this check, and Compile is probed through the server's own runtime (no identity shim, no `compile_api` section).");
  // Wait for the batched identity registration: the next check must read the registered account.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await raw("evimed-engine", "GET", `/api/v1/admin/accounts/${ACCOUNT}/memory-templates/profile`);
    if (probe.status === 200) break;
    await sleep(10_000);
  }
  const ready = await scenario("engine-check-ready", "evimed",
    "The check against an account the server has registered, the skills installed and Compile running as the server starts it: every fact holds.");
  if (!ready.ok) console.log("WARNING: the second check did not hold every fact; look at engine-check-ready.json before keeping it");
  shownAccount = "evimed";
}

// ----------------------------------------------------------------------------------------------------------------------
// Native memory: sessions, files, search, the admin routes and the MCP endpoint (the memory lab's recorder).

async function recordMemory() {
  const index = [];
  const USER = "fx-user-a";
  const OTHER = "fx-user-b";
  /** One recorded exchange: `{ note, recordedFrom, request, status, contentType, response }`. */
  async function record(name, { user = USER, method, route, body, headers = {}, account = ACCOUNT, note, keyed = true, text = false }) {
    const result = await raw(user, method, route, body, { headers, keyed, account });
    const file = {
      note, recordedFrom: IMAGE,
      request: { method, path: route, headers: { ...result.sent, ...(keyed ? { "X-API-Key": KEY_PLACEHOLDER } : {}) }, ...(body === undefined ? {} : { body }) },
      status: result.status, contentType: result.contentType, response: text || result.json === null ? result.text : result.json,
    };
    write(`memory/${name}.json`, file);
    index.push({ file: `${name}.json`, method, path: route.split("?")[0], status: result.status, note });
    console.log(String(result.status), name);
    return result;
  }
  const keyOf = (result) => result.json?.result;

  await record("health", { user: null, account: null, keyed: false, method: "GET", route: "/health", note: "Liveness. No key, no identity." });
  await record("find-unauthenticated", { keyed: false, method: "POST", route: "/api/v1/search/find", body: { query: "报告呈现", limit: 3 }, note: "Trusted mode with a root key: identity headers without the key are refused." });
  const legacyRoot = `viking://user/${USER}/memories/evimed/user/preference`;
  for (const [id, text] of [["rec1", "偏好 / 报告呈现\n\n用户偏好用表格呈现证据强度，不要大段散文。"], ["rec2", "偏好 / 检索范围\n\n检索默认限定近十年的英文与中文文献。"], ["rec3", "偏好 / 报告语言\n\n报告一律用中文撰写。"]]) {
    const body = { uri: `${legacyRoot}/${id}.md`, content: text, mode: "create", wait: true };
    if (id === "rec1") await record("content-write-create", { method: "POST", route: "/api/v1/content/write", body, note: "content/write, mode create, wait true: a new file, embedded before the answer returns." });
    else await raw(USER, "POST", "/api/v1/content/write", body);
  }
  await record("content-write-create-conflict", { method: "POST", route: "/api/v1/content/write", body: { uri: `${legacyRoot}/rec1.md`, content: "第二次 create。", mode: "create", wait: true }, note: "mode create on an existing URI (an alias of replace from v0.5.1: no 409)." });
  await record("content-write-replace", { method: "POST", route: "/api/v1/content/write", body: { uri: `${legacyRoot}/rec2.md`, content: "偏好 / 检索范围\n\n检索默认限定近五年的英文与中文文献。", mode: "replace", wait: true }, note: "content/write, mode replace: the body changes, MEMORY_FIELDS and tags stay." });
  await record("fs-ls", { method: "GET", route: `/api/v1/fs/ls?uri=${enc(legacyRoot)}`, note: "fs/ls of one directory." });
  await record("fs-ls-missing", { method: "GET", route: `/api/v1/fs/ls?uri=${enc(`viking://user/${USER}/memories/no-such-directory`)}`, note: "fs/ls of a directory that does not exist (a user who has no memory of that type yet)." });
  await record("find", { method: "POST", route: "/api/v1/search/find", body: { query: "报告怎么呈现", limit: 3, target_uri: legacyRoot }, note: "search/find scoped to one directory." });
  await record("fs-delete", { method: "DELETE", route: `/api/v1/fs?uri=${enc(`${legacyRoot}/rec3.md`)}`, note: "DELETE fs of one file: the vector goes first, then the file." });
  await record("fs-delete-already-gone", { method: "DELETE", route: `/api/v1/fs?uri=${enc(`${legacyRoot}/rec3.md`)}`, note: "The same delete again." });
  await record("cross-user-read-refused", { user: OTHER, method: "GET", route: `/api/v1/content/read?uri=${enc(`${legacyRoot}/rec1.md`)}`, note: "Another user of the same account reading this user's file." });

  const sessionId = "dsh-session_fixture0000000000000000000000000001";
  await record("session-create", { method: "POST", route: "/api/v1/sessions", body: { session_id: sessionId }, note: "Create with the id the DSH plugin derives (dsh-<kernel session id>). The deployment default auto_commit_policy is echoed." });
  await record("session-create-exists", { method: "POST", route: "/api/v1/sessions", body: { session_id: sessionId }, note: "The same create again: the plugin treats 409 ALREADY_EXISTS as success." });
  await record("message-write-user", { method: "POST", route: `/api/v1/sessions/${sessionId}/messages`, body: { role: "user", parts: [{ type: "text", text: "我是做结构设计的工程师，在一家设计院工作。以后回答请先给结论再给依据。我们现在的项目是一座三跨预应力混凝土连续梁桥的施工图设计，我们定了主梁用 C55 混凝土。" }], created_at: "2026-10-12T08:00:00.000Z" }, note: "A user message as the plugin sends it: parts with one text part, created_at." });
  await record("message-write-assistant", { method: "POST", route: `/api/v1/sessions/${sessionId}/messages`, body: { role: "assistant", parts: [{ type: "text", text: "好的，之后先给结论再给依据。" }], created_at: "2026-10-12T08:00:05.000Z" }, note: "An assistant message." });
  await record("session-read", { method: "GET", route: `/api/v1/sessions/${sessionId}`, note: "Session metadata: pending_tokens is what the plugin compares with its commit threshold." });
  const committed = await record("session-commit", { method: "POST", route: `/api/v1/sessions/${sessionId}/commit`, body: { keep_recent_count: 0 }, note: "Commit: phase 1 answers at once with a task id." });
  const taskId = keyOf(committed)?.task_id;
  await record("task-running", { method: "GET", route: `/api/v1/tasks/${taskId}`, note: "The task right after the commit." });
  await pollTask(USER, taskId, { limitMs: 600_000 });
  const task = await record("task-completed", { method: "GET", route: `/api/v1/tasks/${taskId}`, note: "The finished task: memories_extracted, token_usage (cumulative over the session), memory_diff_uri." });
  await record("task-not-found", { method: "GET", route: "/api/v1/tasks/00000000-0000-0000-0000-000000000000", note: "A task id this user does not own or that has expired." });
  const diffUri = keyOf(task)?.result?.memory_diff_uri;
  await record("memory-diff-read", { method: "GET", route: `/api/v1/content/read?uri=${enc(diffUri)}`, note: "memory_diff.json of the archive, read as a file: result is the JSON text." });
  await record("session-commit-nothing-pending", { method: "POST", route: `/api/v1/sessions/${sessionId}/commit`, body: { keep_recent_count: 0 }, note: "Commit with no new message." });
  await record("session-read-after-commit", { method: "GET", route: `/api/v1/sessions/${sessionId}`, note: "Session metadata after one commit." });
  for (const [role, content] of [["user", "今天天气怎么样？"], ["assistant", "我无法获取实时天气。"]]) await raw(USER, "POST", `/api/v1/sessions/${sessionId}/messages`, { role, content });
  const empty = await raw(USER, "POST", `/api/v1/sessions/${sessionId}/commit`, { keep_recent_count: 0 });
  await pollTask(USER, keyOf(empty).task_id, { limitMs: 600_000 });
  const emptyTask = await record("task-completed-no-operations", { method: "GET", route: `/api/v1/tasks/${keyOf(empty).task_id}`, note: "A commit whose extraction wrote nothing." });
  await record("memory-diff-read-no-operations", { method: "GET", route: `/api/v1/content/read?uri=${enc(keyOf(emptyTask)?.result?.memory_diff_uri)}`, note: "Its memory_diff.json: written all the same, with empty operations." });
  // `task-failed` and `archive-failed-marker-read` need an extraction whose model call is refused: not recordable here.

  const root = `viking://user/${USER}/memories`;
  const tree = await record("fs-tree", { method: "GET", route: `/api/v1/fs/tree?uri=${enc(root)}&level_limit=8&node_limit=1000&include_tags=true`, note: "Every memory of one user, with tags: the memory page's listing call." });
  await record("fs-tree-by-type-tag", { method: "GET", route: `/api/v1/fs/tree?uri=${enc(root)}&level_limit=8&include_tags=true&tags=${enc("memory_type=preferences")}`, note: "The same listing filtered by the system tag." });
  const entries = keyOf(tree) ?? [];
  const preference = entries.find((entry) => !entry.isDir && entry.rel_path.startsWith("preferences/"));
  const card = entries.find((entry) => !entry.isDir && entry.rel_path.startsWith("projects/"));
  if (!preference) throw new Error("the extraction wrote no preferences file: nothing to record the memory page's calls against");
  await record("content-read", { method: "GET", route: `/api/v1/content/read?uri=${enc(preference.uri)}`, note: "A memory file's body (MEMORY_FIELDS stripped)." });
  await record("content-read-raw", { method: "GET", route: `/api/v1/content/read?uri=${enc(preference.uri)}&raw=true`, note: "The same file with its MEMORY_FIELDS comment." });
  await record("content-read-profile", { method: "GET", route: `/api/v1/content/read?uri=${enc(`${root}/profile.md`)}`, note: "profile.md: what the plugin injects at session start." });
  await record("content-read-missing", { method: "GET", route: `/api/v1/content/read?uri=${enc(`${root}/no-such-file.md`)}`, note: "A file that does not exist (profile.md of a user with no profile yet answers the same)." });
  await record("fs-attrs", { method: "GET", route: `/api/v1/fs/attrs?uri=${enc(preference.uri)}`, note: "Structured fields and tags of one memory." });
  if (card) {
    await record("fs-attrs-set-tags", { method: "POST", route: "/api/v1/fs/attrs/set_tags", body: { uri: card.uri, tags: ["project=proj_fixture_1"] }, note: "A project tag written by the control plane; the system tag memory_type stays." });
    await record("fs-tree-by-project-tag", { method: "GET", route: `/api/v1/fs/tree?uri=${enc(root)}&level_limit=8&include_tags=true&tags=${enc("project=proj_fixture_1")}`, note: "The listing filtered by the project tag." });
  }
  await record("fs-ls-preferences-as-plugin", { method: "GET", route: `/api/v1/fs/ls?uri=${enc(`${root}/preferences`)}&output=agent&recursive=true&abs_limit=512&node_limit=512`, note: "The plugin's own startup listing of preferences/." });
  await record("fs-stat", { method: "GET", route: `/api/v1/fs/stat?uri=${enc(preference.uri)}`, note: "stat of one file." });
  await record("content-write-memory-replace", { method: "POST", route: "/api/v1/content/write", body: { uri: preference.uri, content: "- 回答先给结论，再给依据，最后列出风险。", mode: "replace", wait: true }, note: "A person's edit of one memory on the memory page." });
  await record("fs-attrs-after-manual-edit", { method: "GET", route: `/api/v1/fs/attrs?uri=${enc(preference.uri)}`, note: "After the edit: memory_type and version are what they were." });

  await sleep(1_500);
  await record("search-context-as-plugin", { method: "POST", route: "/api/v1/search/search", body: { query: "回答的要求", mode: "context", purpose: "coding", score_threshold: 0.35, session_id: sessionId, dedup_turns: 5, query_expansion: "off" }, note: "Context mode as the plugin sends it (purpose coding; query_expansion off set here): bucketed retrieval, custom types are not reached." });
  await record("search-context-flat", { method: "POST", route: "/api/v1/search/search", body: { query: "项目的已定事项", mode: "context", score_threshold: 0.35, exclude_uris: ["viking://resources", "viking://agent"], query_expansion: "off" }, note: "Context mode without purpose or quotas, as the gateway rewrites it: flat retrieval, custom types reported under category \"memories\"." });
  await record("search-list", { method: "POST", route: "/api/v1/search/search", body: { query: "项目的已定事项", limit: 5, target_uri: root }, note: "search/search in list mode, scoped to the user's memories." });
  await record("system-status", { method: "GET", route: "/api/v1/system/status", note: "The plugin asks this for its user space name." });
  await record("fs-ls-user-root", { method: "GET", route: `/api/v1/fs/ls?uri=${enc("viking://user")}&output=original`, note: "The plugin lists viking://user to find its space: only the caller's own." });
  await record("skills", { method: "GET", route: "/api/v1/skills", note: "The skill catalogue the plugin reads at start." });
  await record("stats-memories", { method: "GET", route: "/api/v1/stats/memories", note: "Account-wide counts, whoever asks (the engine's own statement; not a per-user number)." });
  await record("console-tokens", { method: "GET", route: "/api/v1/console/tokens?start_date=2026-10-22&end_date=2026-10-24&timezone=UTC", note: "This user's own token usage per day (LLM input/output, embedding input)." });

  const mcp = (name, message, note) => record(name, { method: "POST", route: "/mcp", body: message, headers: { Accept: "application/json, text/event-stream" }, note, text: true });
  await mcp("mcp-initialize", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-recording", version: "0" } } }, "MCP initialize: the answer is a text/event-stream body with one message event; no session header.");
  await mcp("mcp-tools-list", { jsonrpc: "2.0", id: 2, method: "tools/list" }, "The complete tool list a USER is offered; the gateway keeps five.");
  await mcp("mcp-call-search", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "回答的要求", limit: 5, target_uri: root } } }, "tools/call search, list mode.");
  await mcp("mcp-call-read", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read", arguments: { uris: [`${root}/profile.md`] } } }, "tools/call read.");
  await mcp("mcp-call-list", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list", arguments: { uri: root } } }, "tools/call list.");
  const remembered = await mcp("mcp-call-remember", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "remember", arguments: { messages: [{ role: "user", content: "记住：图纸里的尺寸单位一律用毫米。" }] } } }, "tools/call remember: a one-off session mcp-store-<id> is created and committed; the answer names its task id.");
  const rememberTask = /task_id=([0-9a-f-]{36})/.exec(remembered.text)?.[1];
  if (rememberTask) await pollTask(USER, rememberTask, { limitMs: 600_000 });
  await mcp("mcp-call-forget", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "forget", arguments: { uri: `${legacyRoot}/rec2.md` } } }, "tools/call forget of one file.");
  await mcp("mcp-call-read-other-user", { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "read", arguments: { uris: [`viking://user/${OTHER}/memories/profile.md`] } } }, "tools/call read of another user's file: refused by the server itself.");

  // The admin routes. A trusted user exists for them only once it is registered (explicitly, or by the engine's periodic
  // flush some minutes after its first request), and the user named in the URL must be the one in X-OpenViking-User. So the
  // users of the "not registered yet" fixtures are new ones, registered or deleted within seconds of their first request.
  const admin = `/api/v1/admin/accounts/${ACCOUNT}/users`;
  const NEW = "fx-user-d";
  const FRESH = "fx-user-e";
  const GONE = "fx-user-f";
  await raw(USER, "POST", admin, { user_id: USER, role: "user" });
  await raw(OTHER, "POST", admin, { user_id: OTHER, role: "user" });
  await record("admin-user-settings-get-unregistered", { user: NEW, method: "GET", route: `${admin}/${NEW}/settings`, note: "Settings of a trusted user nobody registered yet: the admin routes do not know it." });
  await record("admin-user-register", { user: NEW, method: "POST", route: admin, body: { user_id: NEW, role: "user" }, note: "Explicit registration of a user." });
  await raw(FRESH, "POST", "/api/v1/content/write", { uri: `viking://user/${FRESH}/memories/preferences/self/示例.md`, content: "- 示例偏好。", mode: "create", wait: true });
  await record("admin-user-register-existing-files", { user: FRESH, method: "POST", route: admin, body: { user_id: FRESH, role: "user" }, note: "Explicit registration of a trusted user who already has files but is not in the register yet." });
  await record("admin-user-register-again", { user: FRESH, method: "POST", route: admin, body: { user_id: FRESH, role: "user" }, note: "The same registration a second time." });
  await record("admin-user-settings-get", { user: USER, method: "GET", route: `${admin}/${USER}/settings`, note: "A registered user's settings (memory_policy only). X-OpenViking-User is the user named in the URL." });
  await record("admin-user-settings-get-as-another-user", { user: NEW, method: "GET", route: `${admin}/${USER}/settings`, note: "The same route with a different user in the header." });
  await record("admin-user-settings-pause", { user: USER, method: "PATCH", route: `${admin}/${USER}/settings`, body: { memory_policy: { self: { enabled: false } } }, note: "Pause learning for one user. A PATCH that does not restate memory_types leaves the user with every registered type." });
  for (const [role, content] of [["user", "另外，计算书请用 Word 格式，这是我们院的固定要求。"], ["assistant", "好的。"]]) await raw(USER, "POST", `/api/v1/sessions/${sessionId}/messages`, { role, content });
  const paused = await record("session-commit-while-paused", { user: USER, method: "POST", route: `/api/v1/sessions/${sessionId}/commit`, body: { keep_recent_count: 0 }, note: "A commit while memory_policy.self.enabled is false." });
  if (keyOf(paused)?.task_id) {
    await pollTask(USER, keyOf(paused).task_id, { limitMs: 600_000 });
    await record("task-completed-while-paused", { user: USER, method: "GET", route: `/api/v1/tasks/${keyOf(paused).task_id}`, note: "Its task: what the extraction did with self memory disabled." });
  }
  await record("admin-user-settings-resume", { user: USER, method: "PATCH", route: `${admin}/${USER}/settings`, body: { memory_policy: { self: { enabled: true } } }, note: "Resume." });
  await record("admin-user-settings-patch-with-types", { user: USER, method: "PATCH", route: `${admin}/${USER}/settings`,
    body: { memory_policy: { self: { enabled: true }, memory_types: ["profile", "preferences", "entities", "corrections", "project_context", "decisions", "follow_ups", "project_facts"] } },
    note: "A settings PATCH that carries the type allowlist. A PATCH without memory_types leaves the user with every registered type (see admin-user-settings-pause.json): the deployment default no longer applies to that user." });
  await record("admin-users-list", { method: "GET", route: `${admin}?limit=3`, note: "The account's register (trimmed by the limit parameter if the server honours it)." });
  await raw(GONE, "POST", "/api/v1/content/write", { uri: `viking://user/${GONE}/memories/preferences/self/示例.md`, content: "- 示例偏好。", mode: "create", wait: true });
  await record("admin-user-delete-unregistered", { user: GONE, method: "DELETE", route: `${admin}/${GONE}`, note: "Deleting a trusted user who has files but is not in the register yet (first seen less than the flush interval ago): NOT FOUND, and the files stay." });
  await record("admin-user-delete-as-another-user", { user: USER, method: "DELETE", route: `${admin}/${OTHER}`, note: "Delete with a different user in the header: refused. The header must name the user in the URL." });
  await record("admin-user-delete-no-user-header", { user: null, method: "DELETE", route: `${admin}/${NEW}`, note: "Delete with the account header and no user header." });
  await record("session-delete", { method: "DELETE", route: "/api/v1/sessions/mcp-store-does-not-exist", note: "Deleting a session that does not exist." });
  const stores = await raw(USER, "GET", `/api/v1/fs/ls?uri=${enc(`viking://user/${USER}/sessions`)}`);
  const store = (stores.json?.result ?? []).map((entry) => entry.uri.split("/").pop()).find((name) => name.startsWith("mcp-store-"));
  if (store) await record("session-delete-remember-store", { method: "DELETE", route: `/api/v1/sessions/${store}`, note: "Deleting the one-off session a remember call left behind." });
  await record("admin-user-delete", { user: OTHER, method: "DELETE", route: `${admin}/${OTHER}`, note: "Delete a user: 202 with a task id owned by root." });
  await record("request-during-user-deletion", { user: OTHER, method: "GET", route: `/api/v1/fs/ls?uri=${enc(`viking://user/${OTHER}/memories`)}`, note: "A request as the user being deleted, at once." });
  await sleep(2_500);
  await record("request-after-user-deletion", { user: OTHER, method: "GET", route: `/api/v1/fs/ls?uri=${enc(`viking://user/${OTHER}/memories`)}`, note: "The same request a few seconds later: the id is usable again and has nothing." });
  write("memory/_recorded.json", { recordedAt: new Date().toISOString(), exchanges: index });
  console.log(`memory ${index.length} exchanges`);
}

// ----------------------------------------------------------------------------------------------------------------------
// Resources, Compile, tasks, search and skills (the knowledge lab's recorder). Files are bare bodies; the provenance holds
// the method, path, body and status of each.

async function recordKnowledge() {
  const USER = "u-0f1e2d3c4b5a69788796a5b4";
  const OTHER = "u-aa11bb22cc33dd44ee55ff66";
  const P = `viking://user/${USER}/resources/p/p-3c2b1a0998877665`;
  const fixtures = {};
  const DOCS = {
    "src_00000000000000000000000000000001.md": "# Alpha 协议\n\nSource: alpha.md\nSHA-256: 0000\nExtractor: local-read 1.0 (text)\n\n<!-- page 1 -->\nAlpha 协议是一个用于设备间时间同步的轻量协议，由 Lumen 工作组在 2021 年发布。它使用 UDP 端口 4123，默认同步周期为 64 秒。\n\n<!-- page 2 -->\nAlpha 协议的参考实现叫做 alphad，用 Rust 编写。\n",
    "src_00000000000000000000000000000002.md": "# Beta 网关\n\nSource: beta.md\nSHA-256: 0000\nExtractor: local-read 1.0 (text)\n\nBeta 网关是 Lumen 工作组维护的边缘网关产品，内置 alphad 以通过 Alpha 协议同步时间。Beta 网关 2.0 版本于 2023 年 3 月发布，支持最多 500 台下游设备。\n",
    "src_00000000000000000000000000000003.md": "# Gamma 仪表盘\n\nSource: gamma.md\nSHA-256: 0000\nExtractor: local-read 1.0 (text)\n\nGamma 仪表盘是 Beta 网关 2.0 自带的 Web 管理界面，默认监听 TCP 端口 8443，用来查看下游设备的时间偏差。\n",
  };
  const names = Object.keys(DOCS).sort();
  const q = (params) => new URLSearchParams(Object.entries(params).filter(([, value]) => value != null).map(([k, v]) => [k, String(v)])).toString();

  async function rec(name, method, route, body, { user = USER, headers, timeoutMs = 600_000, note, binary = false } = {}) {
    const result = await raw(user, method, route, body, { headers, timeoutMs, binary });
    let file = `${name}.json`;
    let binaryFact = null;
    if (binary) {
      file = `${name}.bin`;
      write(`knowledge/${file}`, result.bytes);
      binaryFact = { bytes: result.bytes.length, sha256: sha256(result.bytes) };
    } else write(`knowledge/${file}`, result.json ?? result.text);
    fixtures[name] = { file, method, path: route, as_user: user, request_headers: headers ?? {}, request_body: body ?? null, status: result.status, ...(note ? { note } : {}), ...(binaryFact ? { binary: binaryFact } : {}) };
    console.log(String(result.status), name, `${(result.ms / 1000).toFixed(1)}s`);
    return result;
  }

  // The skills are installed by the engine check (from the pinned bytes); run it here when this run did not.
  if (!WANT.has("engine")) await recordingEngine(ACCOUNT).engine.check();
  // Start from nothing, so a second recording gives the same answers as the first.
  await raw(USER, "DELETE", `/api/v1/fs?${q({ uri: P, recursive: "true" })}`);
  await waitIdle(USER);
  await rec("fs-mkdir", "POST", "/api/v1/fs/mkdir", { uri: `${P}/sources` });
  await rec("content-write-create", "POST", "/api/v1/content/write", { uri: `${P}/sources/${names[0]}`, content: DOCS[names[0]], mode: "create", wait: true, processing_mode: "vectors_only", tags: ["src=src_00000000000000000000000000000001", "doctype=other"] });
  await rec("content-write-create-exists", "POST", "/api/v1/content/write", { uri: `${P}/sources/${names[0]}`, content: "x", mode: "create", wait: true, processing_mode: "vectors_only" }, { note: "create on an existing file (an alias of replace from v0.5.1: it overwrites, no 409; the file is put back below)" });
  await rec("content-write-replace-restores", "POST", "/api/v1/content/write", { uri: `${P}/sources/${names[0]}`, content: DOCS[names[0]], mode: "replace", wait: true, processing_mode: "vectors_only", tags: ["src=src_00000000000000000000000000000001", "doctype=other"], tag_mode: "replace" }, { note: "replace puts the source back after the create above overwrote it; on a file that is missing it creates it (measured in this run: content-write-replace-missing)" });
  await rec("content-write-replace-missing", "POST", "/api/v1/content/write", { uri: `${P}/sources/replace-created.md`, content: "replace on a file that is not there\n", mode: "replace", wait: true, processing_mode: "vectors_only" }, { note: "replace on a file that does not exist creates it, parents included (v0.5.1.1; the v0.5.0 answer is not recorded)" });
  await raw(USER, "DELETE", `/api/v1/fs?${q({ uri: `${P}/sources/replace-created.md`, recursive: "false" })}`);
  await rec("content-batch-write", "POST", "/api/v1/content/batch-write", { root_uri: `${P}/sources`, wait: true, operations: [
    { uri: `${P}/sources/${names[1]}`, content: DOCS[names[1]], mode: "upsert" },
    { uri: `${P}/sources/${names[2]}`, content: DOCS[names[2]], mode: "upsert" },
    { uri: `${P}/sources/${names[0]}`, content: DOCS[names[0]], mode: "upsert" }] }, { note: "two created, one unchanged" });
  await rec("content-batch-write-root-missing", "POST", "/api/v1/content/batch-write", { root_uri: `${P}/nowhere`, wait: true, operations: [{ uri: `${P}/nowhere/a.md`, content: "a", mode: "create" }] }, { note: "the root directory must exist first (fs/mkdir)" });
  await rec("content-set-tags", "POST", "/api/v1/content/set_tags", { uri: `${P}/sources/${names[1]}`, tags: ["src=src_00000000000000000000000000000002", "state=retracted"] });
  await rec("content-batch-write-other-extensions", "POST", "/api/v1/content/batch-write", { root_uri: `${P}/sources`, wait: true, operations: [
    { uri: `${P}/sources/table.csv`, content: "code,name\nSY01,湖滨店\n", mode: "upsert" },
    { uri: `${P}/sources/edges.jsonl`, content: "{\"from\":\"a\",\"relation\":\"part_of\",\"label\":\"属于\",\"to\":\"b\",\"evidence\":[\"x\"]}\n", mode: "upsert" }] }, { note: "upsert takes extensions that content/write create refuses" });
  await rec("content-write-create-extension-refused", "POST", "/api/v1/content/write", { uri: `${P}/sources/table2.csv`, content: "a,b\n", mode: "create", processing_mode: "vectors_only" }, { note: "create allows only .md .txt .json .yaml .yml .toml .py .js .ts" });

  // The write-back the control plane makes of a page a person edited: one checked batch-write operation.
  const wikiProbe = `${P}/wiki-write-back`;
  await raw(USER, "POST", "/api/v1/fs/mkdir", { uri: wikiProbe });
  const pageUri = `${wikiProbe}/page.md`;
  const pageOne = "---\ntype: concept\ntitle: 写回检验\n---\n\n# 写回检验\n\n第一版。\n";
  await rec("content-write-page-seed", "POST", "/api/v1/content/write", { uri: pageUri, content: pageOne, mode: "replace", wait: true }, { note: "a page of a compiled tree, written in the default mode (summary and vector follow)" });
  await rec("content-download-page", "GET", `/api/v1/content/download?${q({ uri: pageUri })}`, undefined, { binary: true, note: "the stored bytes: their sha256 is the hash a write-back names" });
  const pageTwo = pageOne.replace("第一版", "第二版");
  await rec("content-batch-write-checked", "POST", "/api/v1/content/batch-write", { root_uri: wikiProbe, wait: true, operations: [{ uri: pageUri, content: pageTwo, mode: "replace", expected_sha256: sha256(pageOne) }] }, { note: "a write-back that names the hash of the page it replaces: written" });
  await rec("content-batch-write-checked-stale", "POST", "/api/v1/content/batch-write", { root_uri: wikiProbe, wait: true, operations: [{ uri: pageUri, content: pageOne.replace("第一版", "第三版"), mode: "replace", expected_sha256: sha256(pageOne) }] }, { note: "the same hash after the page changed: 409 CONFLICT 'Content revision changed', nothing written" });
  await rec("content-batch-write-checked-stale-skipped", "POST", "/api/v1/content/batch-write", { root_uri: wikiProbe, wait: true, skip_conflicts: true, operations: [{ uri: pageUri, content: pageOne.replace("第一版", "第三版"), mode: "replace", expected_sha256: sha256(pageOne) }] }, { note: "with skip_conflicts the same refusal is a 200 whose result lists the conflicts" });
  await rec("content-batch-write-checked-missing", "POST", "/api/v1/content/batch-write", { root_uri: wikiProbe, wait: true, operations: [{ uri: `${wikiProbe}/gone.md`, content: "x\n", mode: "replace", expected_sha256: sha256("x") }] }, { note: "a hash for a file that is not there: 409 CONFLICT 'Expected content no longer exists'" });
  await rec("content-batch-write-checked-busy-first", "POST", "/api/v1/content/batch-write", { root_uri: wikiProbe, wait: false, operations: [{ uri: pageUri, content: pageTwo.replace("第二版", "第四版"), mode: "replace", expected_sha256: sha256(pageTwo) }] }, { note: "wait false: answers at once with a task id while the summary and vector are processed" });
  await rec("content-batch-write-checked-busy", "POST", "/api/v1/content/batch-write", { root_uri: wikiProbe, wait: false, operations: [{ uri: pageUri, content: pageTwo.replace("第二版", "第五版"), mode: "replace", expected_sha256: sha256(pageTwo.replace("第二版", "第四版")) }] }, { note: "a second write to the same directory while the first is processed: 409 CONFLICT, conflict_type path_busy, retryable" });
  await waitIdle(USER);
  await raw(USER, "DELETE", `/api/v1/fs?${q({ uri: wikiProbe, recursive: "true" })}`);

  const upload = await (async () => {
    const boundary = `----rec${randomBytes(8).toString("hex")}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload-sample.md"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(DOCS[names[2]], "utf8"), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await fetchOnce(`${BASE}/api/v1/resources/temp_upload`, { method: "POST", headers: { "X-API-Key": KEY, "X-OpenViking-Account": ACCOUNT, "X-OpenViking-User": USER, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
    const text = await response.text();
    write("knowledge/resources-temp-upload.json", JSON.parse(text));
    fixtures["resources-temp-upload"] = { file: "resources-temp-upload.json", method: "POST", path: "/api/v1/resources/temp_upload", as_user: USER, request_body: "multipart/form-data: file=upload-sample.md", status: response.status, note: "temp_file_id is random per upload" };
    console.log(String(response.status), "resources-temp-upload");
    return JSON.parse(text);
  })();
  await rec("resources-add-no-split", "POST", "/api/v1/resources", { temp_file_id: upload.result.temp_file_id, to: `${P}/uploaded`, wait: true, args: { parse_mode: "no_split" }, processing_mode: "vectors_only", tags: ["src=src_00000000000000000000000000000009"] });
  await waitIdle(USER);

  await rec("fs-stat-file", "GET", `/api/v1/fs/stat?${q({ uri: `${P}/sources/${names[0]}` })}`);
  await rec("fs-stat-directory", "GET", `/api/v1/fs/stat?${q({ uri: `${P}/sources` })}`);
  await rec("fs-stat-missing", "GET", `/api/v1/fs/stat?${q({ uri: `${P}/sources/none.md` })}`);
  await rec("fs-attrs", "GET", `/api/v1/fs/attrs?${q({ uri: `${P}/sources/${names[1]}` })}`);
  await rec("fs-ls-page-1", "GET", `/api/v1/fs/ls?${q({ uri: `${P}/sources`, limit: 2, include_tags: "true" })}`, undefined, { note: "has_more is a top-level key beside result" });
  await rec("fs-ls-page-2", "GET", `/api/v1/fs/ls?${q({ uri: `${P}/sources`, limit: 2, offset: 2, include_tags: "true" })}`);
  await rec("fs-ls-missing", "GET", `/api/v1/fs/ls?${q({ uri: `${P}/none` })}`);
  await rec("fs-tree", "GET", `/api/v1/fs/tree?${q({ uri: P, node_limit: 1000, level_limit: 6, include_tags: "true" })}`);
  await rec("content-read", "GET", `/api/v1/content/read?${q({ uri: `${P}/sources/${names[0]}` })}`);
  await rec("content-read-lines", "GET", `/api/v1/content/read?${q({ uri: `${P}/sources/${names[0]}`, offset: 6, limit: 2 })}`, undefined, { note: "offset and limit count lines, 0-indexed" });
  await rec("content-read-missing", "GET", `/api/v1/content/read?${q({ uri: `${P}/sources/none.md` })}`);
  await rec("content-download", "GET", `/api/v1/content/download?${q({ uri: `${P}/sources/${names[0]}` })}`, undefined, { binary: true, note: "the stored bytes, unchanged" });
  await rec("search-grep", "POST", "/api/v1/search/grep", { uri: `${P}/sources`, pattern: "端口 \\d+", node_limit: 50 });
  await rec("search-grep-uri-pattern", "POST", "/api/v1/search/grep", { uri: P, pattern: "alphad", case_insensitive: true, before_context: 1, after_context: 1 });
  await rec("search-grep-no-match", "POST", "/api/v1/search/grep", { uri: `${P}/sources`, pattern: "nothing-like-this" });
  await rec("search-find-resource", "POST", "/api/v1/search/find", { query: "时间同步协议用哪个端口", target_uri: `${P}/sources`, limit: 3, level: [2] });
  await rec("search-find-by-tag", "POST", "/api/v1/search/find", { query: "网关", target_uri: `${P}/sources`, limit: 3, tags: ["state=retracted"] });
  await rec("fs-read-other-user-denied", "GET", `/api/v1/content/read?${q({ uri: `${P}/sources/${names[0]}` })}`, undefined, { user: OTHER, note: "another user of the same account" });

  // The skills come from the engine check run before this (`engine`), which installs them from the pinned bytes.
  await rec("skills-list", "GET", "/api/v1/skills");
  await rec("skills-get", "GET", `/api/v1/skills/llm-wiki?${q({ target_uri: "viking://agent/skills" })}`);
  const skill = fs.readFileSync(new URL("../../../apps/server/src/openVikingSkills/llm-wiki.skill.md", import.meta.url), "utf8");
  await rec("skills-install", "POST", "/api/v1/skills", { data: skill, target_uri: "viking://agent/skills", wait: true }, { note: "request body: {data: <SKILL.md text of the pinned tag>, target_uri: 'viking://agent/skills', wait: true}; installing over an existing skill" });
  fixtures["skills-install"].request_body = "(omitted: large)";

  await rec("compile-capabilities", "GET", "/api/v1/compile/capabilities");
  const compileBody = { from: [`${P}/sources`], to: `${P}/wiki`, skill: "viking://agent/skills/llm-wiki" };
  // A compile that says `completed` can have written one page and nothing else (measured: about one run in four on this
  // corpus, `errors` empty, no warning). That outcome is recorded when it happens (`*-index-only.json`), and the compile is
  // asked for again — into a target emptied first — until a run writes the pages the other fixtures are read against.
  const typedPages = async () => ((await raw(USER, "GET", `/api/v1/fs/tree?${q({ uri: `${P}/wiki`, node_limit: 1000, level_limit: 6 })}`)).json?.result ?? []).filter((entry) => !entry.isDir).length;
  let taskId = "";
  let key = "";
  let submitted = null;
  const seen = new Set();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    key = `evimed-kb-fixture-00000000000${attempt}`;
    submitted = await rec("compile-submit", "POST", "/api/v1/compile", compileBody, { headers: { "Idempotency-Key": key } });
    taskId = submitted.json.result.task_id;
    seen.clear();
    const started = Date.now();
    const ended = await pollTask(USER, taskId, { everyMs: 3_000, limitMs: 1_200_000, onPoll: (poll) => {
      const state = poll.json?.result?.status;
      if (state && !seen.has(state)) {
        seen.add(state);
        write(`knowledge/tasks-get-${state}.json`, poll.json);
        fixtures[`tasks-get-${state}`] = { file: `tasks-get-${state}.json`, method: "GET", path: "/api/v1/tasks/{task_id}?include_events=true", as_user: USER, status: poll.status };
        console.log("task", state, ((Date.now() - started) / 1000).toFixed(1));
      }
    } });
    await waitIdle(USER);
    if (await typedPages() >= 4 || attempt === 4) break;
    write("knowledge/tasks-get-completed-index-only.json", ended.json);
    fixtures["tasks-get-completed-index-only"] = { file: "tasks-get-completed-index-only.json", method: "GET", path: "/api/v1/tasks/{task_id}?include_events=true", as_user: USER, status: ended.status,
      note: "the same corpus, a compile that completed with no error and no warning and wrote only index.md; the target is emptied and the compile asked for again" };
    await raw(USER, "DELETE", `/api/v1/fs?${q({ uri: `${P}/wiki`, recursive: "true" })}`);
    await waitIdle(USER);
  }
  await rec("compile-submit-replayed", "POST", "/api/v1/compile", compileBody, { headers: { "Idempotency-Key": key }, note: "same key, same body: the same task comes back" });
  await rec("compile-submit-key-conflict", "POST", "/api/v1/compile", { ...compileBody, to: `${P}/wiki-other` }, { headers: { "Idempotency-Key": key }, note: "same key, different body" });
  await rec("compile-submission-by-key", "GET", `/api/v1/compile/submissions/${key}`);
  await rec("tasks-get-without-events", "GET", `/api/v1/tasks/${taskId}`);
  await rec("tasks-list", "GET", "/api/v1/tasks?task_type=compile&limit=5");
  await rec("tasks-get-unknown", "GET", "/api/v1/tasks/cmp_0000000000000000000000000000000000000000000000000000000000000000", undefined, { note: "also what an expired task answers (24 h after completion, 7 d after failure)" });
  await rec("tasks-get-other-user", "GET", `/api/v1/tasks/${taskId}`, undefined, { user: OTHER });
  await waitIdle(USER);
  await rec("fs-tree-wiki", "GET", `/api/v1/fs/tree?${q({ uri: `${P}/wiki`, node_limit: 1000, level_limit: 6 })}`);
  await rec("fs-tree-wiki-with-hidden", "GET", `/api/v1/fs/tree?${q({ uri: `${P}/wiki`, node_limit: 1000, level_limit: 6, show_all_hidden: "true" })}`, undefined, { note: "the L0/L1 sidecars .abstract.md / .overview.md appear only here" });
  await rec("content-read-wiki-index", "GET", `/api/v1/content/read?${q({ uri: `${P}/wiki/index.md` })}`);
  await rec("search-grep-source-uri-in-wiki", "POST", "/api/v1/search/grep", { uri: `${P}/wiki`, pattern: `${P}/sources/${names[0]}`.replace(/\./g, "\\."), node_limit: 200 }, { note: "which pages cite one source: the reverse index the product needs" });
  // The graph of the same documents, with the other official skill: asked for until the run writes its relations file.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const graph = await raw(USER, "POST", "/api/v1/compile", { from: [`${P}/sources`], to: `${P}/kg`, skill: "viking://agent/skills/knowledge-graph" }, { headers: { "Idempotency-Key": `evimed-kb-fixture-00000000g${attempt}` } });
    await pollTask(USER, graph.json.result.task_id, { everyMs: 3_000, limitMs: 1_200_000 });
    await waitIdle(USER);
    const there = await raw(USER, "GET", `/api/v1/content/read?${q({ uri: `${P}/kg/relations.jsonl` })}`);
    if (there.status === 200 || attempt === 3) break;
    await raw(USER, "DELETE", `/api/v1/fs?${q({ uri: `${P}/kg`, recursive: "true" })}`);
    await waitIdle(USER);
  }
  await rec("fs-tree-kg", "GET", `/api/v1/fs/tree?${q({ uri: `${P}/kg`, node_limit: 200, level_limit: 4 })}`);
  await rec("content-read-kg-relations", "GET", `/api/v1/content/read?${q({ uri: `${P}/kg/relations.jsonl` })}`);
  const toCancel = await rec("compile-submit-to-cancel", "POST", "/api/v1/compile", { ...compileBody, to: `${P}/wiki-cancelled` }, { headers: { "Idempotency-Key": "evimed-kb-fixture-0000000000c1" } });
  const cancelId = toCancel.json.result.task_id;
  await sleep(12_000);
  await rec("tasks-cancel", "POST", `/api/v1/tasks/${cancelId}/cancel`);
  const afterCancel = await pollTask(USER, cancelId, { everyMs: 3_000, limitMs: 180_000 });
  write("knowledge/tasks-get-after-cancel.json", afterCancel.json);
  fixtures["tasks-get-after-cancel"] = { file: "tasks-get-after-cancel.json", method: "GET", path: "/api/v1/tasks/{task_id}?include_events=true", as_user: USER, status: afterCancel.status };
  await rec("tasks-cancel-terminal", "POST", `/api/v1/tasks/${cancelId}/cancel`, undefined, { note: "cancelling a task that already ended" });
  await rec("fs-delete-file", "DELETE", `/api/v1/fs?${q({ uri: `${P}/uploaded`, recursive: "true" })}`);
  await rec("fs-delete-missing", "DELETE", `/api/v1/fs?${q({ uri: `${P}/uploaded`, recursive: "true" })}`, undefined, { note: "deleting again" });

  write("knowledge/provenance.json", {
    recorded_from: IMAGE, recorded_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    auth_mode: "trusted (X-API-Key root + X-OpenViking-Account: evimed + X-OpenViking-User)", account: "evimed", user: USER,
    recorder: "packages/contracts/openviking/record.mjs", fixtures,
  });
  console.log(`knowledge ${Object.keys(fixtures).length} fixtures`);
}

// ----------------------------------------------------------------------------------------------------------------------

try {
  if (WANT.has("top")) await recordTop();
  if (WANT.has("engine")) await recordEngine();
  if (WANT.has("memory")) await recordMemory();
  if (WANT.has("knowledge")) await recordKnowledge();
} finally {
  if (process.env.OV_KEEP_ACCOUNT !== "1") {
    const removed = await raw(null, "DELETE", `/api/v1/admin/accounts/${ACCOUNT}`);
    console.log(`account ${ACCOUNT} deleted: ${removed.status}`);
  }
}
