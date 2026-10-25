import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NativeInputRoute } from "../src/nativeInputRoute.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const request = (requestId, text = requestId) => ({ requestId, sessionId: "session", mode: "queue", content: [{ type: "text", text }] });
async function fixture(fn, options = {}) {
  const root = await fs.mkdtemp("/tmp/evimed-native-route-");
  const project = { userId: "alice", id: "p", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await fs.mkdir(project.workspaceDir); await fs.mkdir(project.metaDir);
  let clock = Date.parse("2026-10-25T00:00:00Z");
  const calls = [];
  const context = new NativeInputRoute({ route: async (_project, _sessionId, text) => { calls.push(text); return { effectiveAgentId: "geo-content", effectiveRouteReason: "session-binding", question: text }; },
    now: () => clock, ...options });
  try { await fn({ context, project, calls, advance: (ms) => { clock += ms; }, root }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("queued input routes are immutable and request-scoped: one request is classified once, and only the route of the input that was frozen is answered", async () => fixture(async ({ context, project, calls }) => {
  await context.prepare(project, request("A")); await context.prepare(project, request("B"));
  await context.prepare(project, request("A"));
  assert.deepEqual(calls, ["A", "B"], "the same request does not classify twice");
  await assert.rejects(context.prepare(project, request("A", "different")), { code: "native_route_conflict" });
  const read = await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] });
  assert.equal(read.routes.length, 1);
  assert.deepEqual(read.routes[0].route, { effectiveAgentId: "geo-content", effectiveRouteReason: "session-binding" }, "the route, and no question text, is what is kept");
  assert.equal(JSON.stringify(read).includes("question"), false);
  assert.equal((await context.routeFor(project, "session", ["A"], "A")).effectiveAgentId, "geo-content");
  assert.equal(await context.routeFor(project, "session", ["A"], "B"), null, "the adopted turn's text must be the frozen one");
  assert.equal((await context.routeFor(project, "session", ["A"], "  A \n")).effectiveAgentId, "geo-content", "spacing is not another text");
}));

test("owner, session and current input content are rechecked, and nothing is written inside the workspace", async () => fixture(async ({ context, project }) => {
  await context.prepare(project, request("A"));
  const read = (target, sessionId, text) => context.read(target, { sessionId, inputs: [{ requestId: "A", textDigest: hash(text) }] });
  assert.equal((await read({ ...project, userId: "bob" }, "session", "A")).routes.length, 0);
  assert.equal((await read(project, "other", "A")).routes.length, 0);
  assert.equal((await read(project, "session", "wrong")).routes.length, 0);
  assert.equal((await read({ ...project, id: "foreign" }, "session", "A")).routes.length, 0);
  await assert.rejects(context.read(project, { sessionId: "../x", inputs: [] }), { code: "native_route_request_invalid" });
  assert.deepEqual(await fs.readdir(project.workspaceDir), []);
}));

test("an envelope expires after its time to live and never returns", async () => fixture(async ({ context, project, advance }) => {
  await context.prepare(project, request("A"));
  advance(1001);
  assert.equal((await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] })).routes.length, 0);
  assert.equal(await context.routeFor(project, "session", ["A"], "A"), null);
}, { ttlMs: 1000 }));

test("a preparation that outlives its bound cannot write an envelope later", async () => fixture(async ({ context, project }) => {
  await assert.rejects(context.prepare(project, request("slow")), { code: "native_route_timeout" });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal((await context.read(project, { sessionId: "session", inputs: [{ requestId: "slow", textDigest: hash("slow") }] })).routes.length, 0);
}, { timeoutMs: 5, route: async () => { await new Promise(resolve => setTimeout(resolve, 25)); return { effectiveAgentId: "geo-content" }; } }));

test("a learning pause or trial beginning after preparation prevents the queued input from reading its route, and prepares nothing new", async () => fixture(async ({ context, project }) => {
  await context.prepare(project, request("A"));
  context.allowed = async () => false;
  assert.deepEqual(await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] }), { routes: [] });
  assert.equal(await context.prepare(project, request("B")), null);
}));

test("concurrent replays of one native request share the same frozen route", async () => {
  let routed = 0;
  await fixture(async ({ context, project }) => {
    const [a, b] = await Promise.all([context.prepare(project, request("A")), context.prepare(project, request("A"))]);
    assert.equal(routed, 1);
    assert.equal(a.digest, b.digest);
  }, { route: async () => { routed += 1; await new Promise(resolve => setTimeout(resolve, 15)); return { effectiveAgentId: "geo-content" }; } });
});

test("opaque request ids cannot escape metadata storage, metadata symlinks are refused, and what the handbook arm kept there is taken away", async () => fixture(async ({ context, project }) => {
  const id = "../../outside";
  await context.prepare(project, request(id));
  assert.ok(context.file(project, "session", id).startsWith(path.join(project.metaDir, "native-routes")));
  // The one-day files the retired envelope left behind are removed with the first prune, and a link in their place is removed as a link.
  await fs.mkdir(path.join(project.metaDir, "native-handbooks"));
  await fs.writeFile(path.join(project.metaDir, "native-handbooks", "old.json"), "{}");
  await context.prepare(project, request("C"));
  assert.equal(await fs.stat(path.join(project.metaDir, "native-handbooks")).catch(() => null), null);
  await fs.rm(path.join(project.metaDir, "native-routes"), { recursive: true, force: true });
  await fs.symlink(project.workspaceDir, path.join(project.metaDir, "native-routes"));
  await assert.rejects(context.prepare(project, request("B")));
  assert.deepEqual(await fs.readdir(project.workspaceDir), []);
}));

test("an unbound turn keeps its initial capability snapshot when a steer looks like another capability", async () => fixture(async ({ context, project, calls }) => {
  context.route = async (_project, _session, text) => { calls.push(text); return { effectiveAgentId: text.startsWith("Initial") ? "geo-content" : "open-domain-answer", effectiveRouteReason: "llm:0.9" }; };
  await context.prepare(project, request("A", "Initial capability A"));
  const steer = { ...request("B", "An unrelated capability B question"), mode: "steer" };
  assert.equal(await context.prepare(project, steer), null);
  assert.deepEqual(calls, ["Initial capability A"], "a steer does not classify or prepare a replacement capability");
  assert.deepEqual(await context.read(project, { sessionId: "session", inputs: [{ requestId: "B", textDigest: hash("An unrelated capability B question") }] }), { routes: [] });
  assert.equal((await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("Initial capability A") }] })).routes.length, 1);
  await context.prepare(project, request("C", "An unrelated capability B question"));
  assert.deepEqual(calls, ["Initial capability A", "An unrelated capability B question"], "the next queued turn still resolves its own capability");
}));

test("a restart reuses the frozen route instead of classifying the input again", async () => fixture(async ({ context, project, calls }) => {
  const first = await context.prepare(project, request("A", "Initial evidence"));
  const restarted = new NativeInputRoute({ route: async () => { throw new Error("A restart must reuse the frozen route"); }, now: context.now });
  assert.equal((await restarted.prepare(project, request("A", "Initial evidence"))).digest, first.digest);
  assert.deepEqual(calls, ["Initial evidence"]);
  assert.equal((await restarted.routeFor(project, "session", ["A", "A"], "Initial evidence")).effectiveAgentId, "geo-content");
}));
