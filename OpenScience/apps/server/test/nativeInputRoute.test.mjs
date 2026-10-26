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

test("a slow classifier still freezes its route: the classifier bounds itself, and no second deadline cuts the request's identity short", async () => fixture(async ({ context, project }) => {
  const frozen = await context.prepare(project, request("slow"));
  assert.equal(frozen.route.effectiveAgentId, "geo-content");
  const read = await context.read(project, { sessionId: "session", inputs: [{ requestId: "slow", textDigest: hash("slow") }] });
  assert.equal(read.routes[0].digest, frozen.digest);
}, { route: async () => { await new Promise(resolve => setTimeout(resolve, 25)); return { effectiveAgentId: "geo-content" }; } }));

test("the route is the request's identity, not a learning supplement: it is frozen and read whatever the learning switch says", async () => fixture(async ({ context, project }) => {
  await context.prepare(project, request("A"));
  // No switch is consulted: a paused account's selected GEO request still needs its frozen route, and the run policy its attendance proof.
  assert.equal("allowed" in context, false);
  const read = await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] });
  assert.equal(read.routes[0].route.effectiveAgentId, "geo-content");
  assert.equal((await context.prepare(project, request("B"))).route.effectiveAgentId, "geo-content");
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

test("a selected GEO input keeps its route fields, is classified once with its own request, and is adopted only under the forwarded text", async () => fixture(async ({ context, project, calls }) => {
  const ref = "gpc_" + "a".repeat(64);
  context.route = async (_project, _session, text, input) => {
    calls.push(text); assert.deepEqual(input.requestIds, ["bound"]); assert.equal(input.request.requestId, "bound");
    return { effectiveAgentId: "open-domain-answer", geoContextRef: ref, geoInputRead: { referenceId: ref, what: "analysis" }, geoAnalysisRead: { referenceId: ref }, question: text };
  };
  const forwarded = "Human\n<evimed_geo_plan_context>trusted</evimed_geo_plan_context>";
  const frozen = await context.prepare(project, request("bound", forwarded));
  assert.equal(frozen.route.geoContextRef, ref);
  assert.deepEqual(frozen.route.geoInputRead, { referenceId: ref, what: "analysis" });
  assert.equal(await context.routeFor(project, "session", ["bound"], "Human"), null, "original human text cannot adopt a different forwarded envelope");
  assert.deepEqual(await context.routeFor(project, "session", ["bound"], "Human <evimed_geo_plan_context>trusted</evimed_geo_plan_context>"), frozen.route);
  assert.equal((await context.prepare(project, request("bound", forwarded))).digest, frozen.digest);
  assert.equal(calls.length, 1);
}));

test("a modified stored route cannot be read or adopted under the original envelope digest", async () => fixture(async ({ context, project }) => {
  await context.prepare(project, request("owned"));
  const file = context.file(project, "session", "owned");
  const envelope = JSON.parse(await fs.readFile(file, "utf8"));
  envelope.route.effectiveAgentId = "geo-strategy";
  await fs.writeFile(file, JSON.stringify(envelope));
  assert.deepEqual(await context.read(project, { sessionId: "session", inputs: [{ requestId: "owned", textDigest: hash("owned") }] }), { routes: [] });
  assert.equal(await context.routeFor(project, "session", ["owned"], "owned"), null);
}));

test("adoption never borrows a later queued route when the initiating input has no envelope", async () => fixture(async ({ context, project }) => {
  await context.prepare(project, request("later", "Same forwarded text"));
  assert.equal(await context.routeFor(project, "session", ["initiating", "later"], "Same forwarded text"), null);
  assert.equal((await context.routeFor(project, "session", ["later", "initiating"], "Same forwarded text")).effectiveAgentId, "geo-content");
}));

test("selected request identity validation and ordinary preparation share the same native bounds", async () => fixture(async ({ context, project }) => {
  for (const requestId of ["", "x".repeat(513), "bad\nidentity", "bad\u007fidentity", 0, null, {}]) {
    const input = request(/** @type {any} */ (requestId));
    assert.throws(() => context.assertRequestIdentity(input), { code: "native_route_request_invalid" });
    assert.equal(await context.prepare(project, input), null, "an ordinary unsupported native identity freezes nothing and refuses nothing");
  }
  assert.throws(() => context.assertRequestIdentity({ ...request("valid"), sessionId: "s".repeat(129) }), { code: "native_route_request_invalid" });
  const boundary = request("x".repeat(512));
  assert.doesNotThrow(() => context.assertRequestIdentity(boundary));
  assert.ok(await context.prepare(project, boundary));
  const steer = { ...request("legal-steer"), mode: "steer" };
  assert.doesNotThrow(() => context.assertRequestIdentity(steer));
  assert.equal(await context.prepare(project, steer), null, "a legal steer keeps the initiating route instead of preparing a new one");
}));
