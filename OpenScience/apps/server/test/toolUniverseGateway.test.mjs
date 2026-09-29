import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createToolUniverseGateway, TOOL_UNIVERSE_GATEWAY_PATH } from "../src/toolUniverseGateway.mjs";

async function fixture(t, options = {}) {
  const calls = [];
  let active = true;
  const project = { userId: "owner", id: "project" };
  const runtimeManager = { async assertActiveEviMedWorkloadToken(token) {
    if (!active || token !== "workload") throw Object.assign(new Error("Invalid workload"), { status: 401, code: "evimed_workload_token_invalid" });
    return { userId: project.userId, projectId: project.id };
  } };
  const store = { userById: async (id) => ({ id }), requireProject: async (user, id) => { assert.equal(user.id, project.userId); assert.equal(id, project.id); return project; } };
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ body, authorization: req.headers.authorization, session: req.headers["mcp-session-id"], method: req.method });
    if (options.redirect) { res.writeHead(302, { location: "http://untrusted.invalid/" }); res.end(); return; }
    if (req.method === "DELETE" || body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    const result = body.method === "initialize" ? { protocolVersion: "2024-11-05" }
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
