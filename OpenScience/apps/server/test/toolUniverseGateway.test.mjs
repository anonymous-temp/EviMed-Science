import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpError } from "../src/security.mjs";
import { createToolUniverseGateway, TOOL_UNIVERSE_GATEWAY_PATH } from "../src/toolUniverseGateway.mjs";

async function fixture(t, options = {}) {
  const calls = [];
  let active = true;
  const project = { userId: "owner", id: "project" };
  const runtimeManager = { async assertActiveEviMedWorkloadToken(token) {
    if (!active || token !== "workload") throw new HttpError(401, "evimed_workload_token_invalid", "Invalid workload");
    return { userId: project.userId, projectId: project.id };
  } };
  const store = { userById: async (id) => ({ id }), requireProject: async (user, id) => { assert.equal(user.id, project.userId); assert.equal(id, project.id); return project; } };
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ body, authorization: req.headers.authorization, session: req.headers["mcp-session-id"], method: req.method });
    if (options.redirect) { res.writeHead(302, { location: "http://untrusted.invalid/" }); res.end(); return; }
    if (req.method === "DELETE" || body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    const info = { name: "EuropePMC_search_articles", type: "EuropePMCTool", description: "Search and enrich", parameter: { properties: { query: { type: "string" }, enrich_missing_abstract: { type: "boolean" }, fulltext_terms: { type: "array" } }, required: ["query"], additionalProperties: true }, test_examples: [{ query: "test", enrich_missing_abstract: true }] };
    const result = options.info && body.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info }
      : body.method === "initialize" ? { protocolVersion: "2024-11-05" }
      : body.method === "tools/list" ? { tools: [{ name: "list_tools" }] }
      : { content: [{ type: "text", text: "public evidence" }] };
    if (options.revoke && body.method === "tools/call") active = false;
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "test-session" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const handler = createToolUniverseGateway({ config: { toolUniverseMcpUrl: `http://127.0.0.1:${upstream.address().port}/mcp`, toolUniverseApiToken: "s".repeat(64) }, runtimeManager, store });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const service of [server, upstream]) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); } });
  const request = (body, token = "workload") => fetch(`http://127.0.0.1:${server.address().port}${TOOL_UNIVERSE_GATEWAY_PATH}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { request, calls };
}

test("only active workloads reach the fixed sidecar with its private credential", async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ method: "tools/list" }, "wrong")).status, 401);
  assert.equal(f.calls.length, 0);
  const response = await f.request({ method: "tools/call", params: { name: "list_tools", arguments: {} } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.content[0].text, "public evidence");
  assert.ok(f.calls.every(call => call.authorization === `Bearer ${"s".repeat(64)}`));
  assert.equal(f.calls.at(-1).method, "DELETE", "one caller never leaves a session for another");
});

test("caller routing fields and undeclared or recursive execution targets are refused before egress", async t => {
  const f = await fixture(t);
  for (const body of [{ method: "tools/list", projectId: "other" }, { method: "tools/list", url: "http://evil" },
    { method: "tools/call", params: { name: "execute_tool", arguments: { tool_name: "execute_tool" } } },
    { method: "tools/call", params: { name: "execute_tool", arguments: { tool_name: "python_exec" } } },
    { method: "resources/read", params: { uri: "file:///etc/passwd" } }]) {
    assert.equal((await f.request(body)).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("redirects never receive a service credential and retired workloads receive no tool result", async t => {
  const redirected = await fixture(t, { redirect: true });
  assert.equal((await redirected.request({ method: "tools/list" })).status, 502);
  assert.equal(redirected.calls.length, 1);
  const revoked = await fixture(t, { revoke: true });
  assert.equal((await revoked.request({ method: "tools/call", params: { name: "list_tools" } })).status, 401);
});

test("URL-bearing fulltext tools and hidden URL parameters cannot bypass the public-source gateway", async t => {
  const f = await fixture(t);
  for (const tool_name of ["EuropePMC_get_fulltext", "EuropePMC_get_fulltext_snippets", "EuropePMC_get_full_text"]) {
    assert.equal((await f.request({ method: "tools/call", params: { name: "execute_tool", arguments: {
      tool_name, arguments: { fulltext_xml_url: "http://169.254.169.254/latest/meta-data/", output_format: "raw" } } } })).status, 400);
  }
  for (const arguments_ of [{ query: "test", fulltext_xml_url: "http://open-science-web:8787/internal/" },
    JSON.stringify({ query: "test", fulltext_xml_url: "http://127.0.0.1/" }),
    { query: "test", enrich_missing_abstract: true }, { query: "test", extract_terms_from_fulltext: ["dose"] },
    { query: "test", fulltext_terms: ["dose"] }]) {
    assert.equal((await f.request({ method: "tools/call", params: { name: "execute_tool", arguments: {
      tool_name: "EuropePMC_search_articles", arguments: arguments_ } } })).status, 400);
  }
  for (const [tool_name, arguments_] of [["EuropePMC_get_citations", { source: "../", article_id: "../../private" }],
    ["ClinicalTrials_get_study", { nct_id: "../../admin" }], ["PubMed_get_article", { pmid: "http://127.0.0.1/" }]]) {
    assert.equal((await f.request({ method: "tools/call", params: { name: "execute_tool", arguments: { tool_name, arguments: arguments_ } } })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("the actual application routes the bridge through workload authentication", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { createWebApiApp } = await import("../src/server.mjs");
  const dataDir = await mkdtemp("/tmp/evimed-tooluniverse-app-");
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "" });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const address = await app.listen(0, "127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${address.port}${TOOL_UNIVERSE_GATEWAY_PATH}`, {
    method: "POST", headers: { authorization: "Bearer invalid", "content-type": "application/json" }, body: JSON.stringify({ method: "tools/list" }) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "evimed_workload_token_invalid");
});


test("tool information exposes the same safe argument surface execution accepts", async t => {
  const f = await fixture(t, { info: true });
  const response = await f.request({ method: "tools/call", params: { name: "get_tool_info", arguments: { tool_names: "EuropePMC_search_articles" } } });
  const result = (await response.json()).result;
  const info = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(info.parameter.properties), ["query"]);
  assert.equal(info.parameter.additionalProperties, false);
  assert.equal(info.test_examples, undefined);
  assert.deepEqual(result.structuredContent, info);
});

test("discovery remains bounded literal search and never runs caller regular expressions", async t => {
  const f = await fixture(t);
  for (const args of [{ pattern: "(.+)+ZZZZ$", search_mode: "regex" }, { pattern: "x".repeat(1000) },
    { pattern: "drug", code: "unexpected" }, { pattern: "drug", limit: 1000000 }]) {
    assert.equal((await f.request({ method: "tools/call", params: { name: "grep_tools", arguments: args } })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request({ method: "tools/call", params: { name: "grep_tools", arguments: { pattern: "(.+)+ZZZZ$", search_mode: "text" } } })).status, 200);
});
