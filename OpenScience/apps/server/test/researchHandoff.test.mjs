/**
 * 「转为深度研究」: a quick answer's question, sources and premises handed to a
 * new research conversation whose first message carries the 「来自 AI 搜索」
 * card — through the existing path: a session binding, then the one prompt
 * path (`POST /api/agent-runs/dispatch`).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RESEARCH_HANDOFF_PATH, createResearchHandoffRoutes, handoffMessage, readHandoff } from "../src/researchHandoff.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { HttpError } from "../src/security.mjs";

const found = {
  question: "司美格鲁肽对肥胖成人的体重下降幅度如何？",
  premises: ["成人", "肾功能正常", "非妊娠"],
  sources: [
    { title: "Once-Weekly Semaglutide in Adults with Overweight or Obesity", doi: "10.1056/NEJMoa2032183", pmid: "33567185",
      quote: "The mean change in body weight from baseline to week 68 was −14.9% in the semaglutide group." },
    { title: "国家药监局说明书", url: "https://www.nmpa.gov.cn/example" },
  ],
};

test("the first message is the question, then a 「来自 AI 搜索」 card with the premises and each source", () => {
  assert.equal(handoffMessage(readHandoff(found)), [
    "司美格鲁肽对肥胖成人的体重下降幅度如何？",
    "",
    "> **来自 AI 搜索**",
    ">",
    "> 适用前提：成人 · 肾功能正常 · 非妊娠",
    ">",
    "> 已找到的来源：",
    "> 1. Once-Weekly Semaglutide in Adults with Overweight or Obesity（DOI 10.1056/NEJMoa2032183 · PMID 33567185）",
    ">    “The mean change in body weight from baseline to week 68 was −14.9% in the semaglutide group.”",
    "> 2. 国家药监局说明书（https://www.nmpa.gov.cn/example）",
  ].join("\n"));
  assert.equal(handoffMessage(readHandoff({ question: "只有问题" })), "只有问题", "nothing found, no card");
});

test("a hand-off carries what it says and nothing else", () => {
  for (const [body, pattern] of [
    [{ ...found, answer: "…" }, /unsupported field/],
    [{ question: "" }, /question/],
    [{ ...found, sources: [{ title: "x", url: "javascript:alert(1)" }] }, /http\(s\)/],
    // Built rather than written: a credential-shaped literal is what the
    // source audit exists to refuse.
    [{ ...found, sources: [{ title: "x", url: Object.assign(new URL("https://example.org/"), { username: "someone", password: "x" }).href }] }, /without credentials/],
    [{ ...found, sources: [{ title: "x", doi: "not-a-doi" }] }, /not a DOI/],
    [{ ...found, sources: [{ title: "x", pmid: "12ab" }] }, /not a PMID/],
    [{ ...found, sources: [{ url: "https://example.org" }] }, /title/],
    [{ ...found, sources: Array.from({ length: 21 }, () => ({ title: "x" })) }, /at most 20/],
    [{ ...found, sources: [{ title: "x", abstract: "…" }] }, /unsupported field/],
  ]) {
    assert.throws(() => readHandoff(body), (error) => error.code === "research_handoff_invalid" && pattern.test(error.message), JSON.stringify(body).slice(0, 80));
  }
});

function routeFixture({ enabled = true, projects = ["default", "study"] } = {}) {
  const calls = [];
  const agents = new Map([
    ["clinical-evidence-synthesis", { id: "clinical-evidence-synthesis", version: "2.0.0", visibility: "public" }],
    ["source-understanding", { id: "source-understanding", version: "1.0.0", visibility: "internal" }],
  ]);
  const routes = createResearchHandoffRoutes({
    config: { researchHandoffEnabled: enabled, maxJsonBytes: 1_048_576 },
    store: { async requireProject(user, id) { if (!projects.includes(id)) throw new HttpError(404, "project_not_found", "Project not found."); return { id, userId: user.id }; } },
    researchSessions: { async put(project, sessionId, binding) { calls.push(["bind", project.id, sessionId, binding]); } },
    agentRegistry: Promise.resolve({ get: (id) => agents.get(id) }),
    context: async () => ({ user: { id: "alice" }, project: { id: "default", userId: "alice" } }),
    audit: async (_ctx, action, status, details) => { calls.push(["audit", action, status, details]); },
  });
  return { routes, calls };
}

function request(body, method = "POST") {
  const chunks = [Buffer.from(JSON.stringify(body), "utf8")];
  return { url: RESEARCH_HANDOFF_PATH, method, headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
}

function response() {
  const captured = { status: 0, body: null };
  return { captured, writeHead(status) { captured.status = status; }, end(payload) { captured.body = payload ? JSON.parse(String(payload)) : null; }, setHeader() {} };
}

test("the hand-off binds a new conversation in the chosen project, to the capability named or to the router", async () => {
  const { routes, calls } = routeFixture();
  const res = response();
  await routes(request({ ...found, projectId: "study", capabilityId: "clinical-evidence-synthesis" }), res);
  assert.equal(res.captured.status, 201);
  const { data } = res.captured.body;
  assert.match(data.sessionId, /^handoff-[a-f0-9]{24}$/);
  assert.equal(data.projectId, "study");
  assert.deepEqual(calls[0], ["bind", "study", data.sessionId, { mode: "specialist", agentId: "clinical-evidence-synthesis", agentVersion: "2.0.0" }]);
  assert.equal(data.draft, handoffMessage(readHandoff(found)));
  assert.equal(data.card.title, "来自 AI 搜索");
  assert.deepEqual(calls[1].slice(1), ["research.handoff.create", "completed", { target: data.sessionId, projectId: "study", sources: 2 }]);

  const open = response();
  await routes(request({ question: "只问一句" }), open);
  assert.deepEqual(calls.filter((entry) => entry[0] === "bind").at(-1).slice(1, 2).concat(calls.filter((entry) => entry[0] === "bind").at(-1)[3]),
    ["default", { mode: "open-domain" }], "no capability named: the request's project, and the router decides");
});

test("the hand-off is off unless a deployment turns it on, and refuses a project or capability that is not the person's to name", async () => {
  await assert.rejects(() => routeFixture({ enabled: false }).routes(request(found), response()),
    (error) => error.status === 503 && error.code === "research_handoff_disabled");
  const { routes, calls } = routeFixture();
  await assert.rejects(() => routes(request({ ...found, projectId: "someone-else" }), response()), (error) => error.code === "project_not_found");
  await assert.rejects(() => routes(request({ ...found, projectId: "evimed-learning" }), response()), (error) => error.status === 404);
  await assert.rejects(() => routes(request({ ...found, capabilityId: "source-understanding" }), response()),
    (error) => error.code === "research_handoff_capability_invalid", "a background capability is not a line to hand off to");
  await assert.rejects(() => routes(request({ ...found, capabilityId: "no-such" }), response()), (error) => error.code === "research_handoff_capability_invalid");
  assert.ok(!calls.some((entry) => entry[0] === "bind"), "nothing was bound for a refusal");
  await assert.rejects(() => routes(request(found, "GET"), response()), (error) => error.status === 405);
});

test("the documented contract names every field the route accepts, its path and its switch", async () => {
  const { readFile } = await import("node:fs/promises");
  const { RESEARCH_HANDOFF_FIELDS } = await import("../src/researchHandoff.mjs");
  const document = await readFile(new URL("../../../docs/WEB_DEPLOYMENT.md", import.meta.url), "utf8");
  const section = document.slice(document.indexOf("### Handing a question to deep research"));
  assert.ok(section.length > 500, "the section is there");
  assert.match(section, new RegExp(`POST ${RESEARCH_HANDOFF_PATH.replace(/\//g, "\\/")}`));
  assert.match(section, /OPEN_SCIENCE_RESEARCH_HANDOFF_ENABLED/);
  for (const field of [...RESEARCH_HANDOFF_FIELDS.request, ...RESEARCH_HANDOFF_FIELDS.source]) {
    assert.match(section, new RegExp(`"${field}"`), `the contract names ${field}`);
  }
});

test("in the running app the hand-off is a new conversation whose first message, sent through the one prompt path, carries the card", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-handoff-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, researchHandoffEnabled: true,
    bootstrapUser: "alice", bootstrapPassword: "correct horse battery staple",
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct horse battery staple" }) });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const csrf = (await login.json()).data?.csrfToken ?? "";
    const headers = { Cookie: cookie, "X-Open-Science-CSRF": csrf, "Content-Type": "application/json" };

    const refused = await fetch(`${base}${RESEARCH_HANDOFF_PATH}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(found) });
    assert.equal(refused.status, 403, "a write from the browser carries its CSRF token like every other");
    const created = await fetch(`${base}${RESEARCH_HANDOFF_PATH}`, { method: "POST", headers, body: JSON.stringify(found) });
    assert.equal(created.status, 201);
    const { data } = await created.json();
    const sessions = (await (await fetch(`${base}/api/research-sessions`, { headers })).json()).data;
    assert.ok(sessions.some((session) => session.sessionId === data.sessionId && session.mode === "open-domain"), "the conversation is bound before it exists");

    const sent = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers,
      body: JSON.stringify({ sessionId: data.sessionId, dispatchId: "handoff-send-1", text: data.draft }) });
    assert.equal(sent.status, 202, "the person's send goes through the one prompt path");
    const user = await app.store.userById("alice");
    const [run] = await app.agentRuns.list(await app.store.requireProject(user, "default"));
    assert.equal(run.sessionId, data.sessionId);
    // The ledger keeps the question on one line, and shortened; the card is in it.
    assert.match(run.question, /^司美格鲁肽对肥胖成人的体重下降幅度如何？\s+> \*\*来自 AI 搜索\*\*/, "and its first message carries the card");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
