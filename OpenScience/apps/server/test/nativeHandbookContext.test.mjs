import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NativeHandbookContext } from "../src/nativeHandbookContext.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const request = (requestId, text = requestId) => ({ requestId, sessionId: "session", mode: "queue", content: [{ type: "text", text }] });
async function fixture(fn, options = {}) {
  const root = await fs.mkdtemp("/tmp/evimed-native-handbook-");
  const project = { userId: "alice", id: "p", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await fs.mkdir(project.workspaceDir); await fs.mkdir(project.metaDir);
  let clock = Date.parse("2026-09-30T00:00:00Z");
  const calls = [];
  const receipts = (text) => [{ id: `method:capability-handbook:geo-content:${text}`, ownerId: "alice", capabilityId: "geo-content", contentDigest: `sha256:${hash(text)}`, version: 1, path: `.evimed-handbooks/${hash(text)}/SKILL.md` }];
  const context = new NativeHandbookContext({ route: async (_project, sessionId, text) => { calls.push(text); return { effectiveAgentId: "geo-content", effectiveRouteReason: "session-binding", question: text }; },
    select: async (_project, _session, route) => ({ context: `Context for ${route.question}`, items: receipts(route.question) }),
    budget: () => 8192, now: () => clock, ...options });
  try { await fn({ context, project, calls, receipts, advance: (ms) => { clock += ms; }, root }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("queued input envelopes are immutable, request-scoped and not attached until acknowledged", async () => fixture(async ({ context, project, calls }) => {
  await context.prepare(project, request("A")); await context.prepare(project, request("B"));
  await context.prepare(project, request("A"));
  assert.deepEqual(calls, ["A", "B"], "same request does not classify twice");
  await assert.rejects(context.prepare(project, request("A", "different")), { code: "handbook_request_conflict" });
  const read = await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] });
  assert.equal(read.contexts.length, 1); assert.match(read.contexts[0].context, /Context for A/); assert.doesNotMatch(read.contexts[0].context, /Context for B/);
  assert.deepEqual(await context.receipts(project, { sessionId: "session", kernelRequestIds: ["A"], effectiveAgentId: "geo-content" }), []);
  await context.acknowledge(project, { sessionId: "session", receipts: [{ requestId: "A", digest: read.contexts[0].digest }] });
  assert.equal((await context.receipts(project, { sessionId: "session", kernelRequestIds: ["A", "B"], effectiveAgentId: "geo-content" })).length, 1);
  assert.deepEqual(await context.receipts(project, { sessionId: "session", kernelRequestIds: ["B"], effectiveAgentId: "geo-content" }), []);
  assert.equal((await context.routeFor(project, "session", ["A"], "A")).effectiveAgentId, "geo-content");
  assert.equal(await context.routeFor(project, "session", ["A"], "B"), null);
}));

test("owner, session, current input content and acknowledgement digest are rechecked", async () => fixture(async ({ context, project }) => {
  await context.prepare(project, request("A"));
  const read = () => context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] });
  assert.equal((await context.read({ ...project, userId: "bob" }, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] })).contexts.length, 0);
  assert.equal((await context.read(project, { sessionId: "other", inputs: [{ requestId: "A", textDigest: hash("A") }] })).contexts.length, 0);
  assert.equal((await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("wrong") }] })).contexts.length, 0);
  await assert.rejects(context.acknowledge(project, { sessionId: "session", receipts: [{ requestId: "A", digest: hash("fake") }] }), { code: "handbook_receipt_mismatch" });
  const [{ digest }] = (await read()).contexts;
  await context.acknowledge(project, { sessionId: "session", receipts: [{ requestId: "A", digest }] });
  assert.deepEqual(await context.receipts(project, { sessionId: "session", kernelRequestIds: ["A"], effectiveAgentId: "meta-analysis" }), []);
  assert.equal(await fs.stat(path.join(project.workspaceDir, "native-handbooks")).catch(() => null), null);
}));

test("retention, timeout, prompt budget and project bounds never introduce stale context", async () => fixture(async ({ context, project, advance }) => {
  await context.prepare(project, request("A")); await context.prepare(project, request("B"));
  context.budget = () => Buffer.byteLength("Context for A") + 1;
  const read = await context.read(project, { sessionId: "session", inputs: ["A", "B"].map(requestId => ({ requestId, textDigest: hash(requestId) })) });
  assert.equal(read.contexts.length, 1, "the current step has one combined budget");
  advance(1001);
  assert.equal((await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] })).contexts.length, 0);
}, { ttlMs: 1000 }));

test("a preparation that outlives its bound cannot write an envelope later", async () => fixture(async ({ context, project }) => {
  await assert.rejects(context.prepare(project, request("slow")), { code: "handbook_context_timeout" });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal((await context.read(project, { sessionId: "session", inputs: [{ requestId: "slow", textDigest: hash("slow") }] })).contexts.length, 0);
}, { timeoutMs: 5, select: async () => { await new Promise(resolve => setTimeout(resolve, 25)); return { context: "Late", items: [] }; } }));

test("a learning pause or trial beginning after preparation prevents the queued input from reading the supplement", async () => fixture(async ({ context, project }) => {
  await context.prepare(project, request("A"));
  context.allowed = async () => false;
  assert.deepEqual(await context.read(project, { sessionId: "session", inputs: [{ requestId: "A", textDigest: hash("A") }] }), { contexts: [] });
  assert.equal(await context.prepare(project, request("B")), null);
}));
