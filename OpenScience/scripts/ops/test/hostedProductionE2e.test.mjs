import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { assertAutomatedMemoryIsolation, sessionTranscript, specialistOutputs } from "../hosted-production-e2e.mjs";

test("live E2E reads the complete package at the paths recorded by its run", () => {
  for (const prefix of ["", "deliverables/aspirin-adr-signal-analysis/"]) {
    const report = `${prefix}safety-report.md`, signals = `${prefix}signals.csv`;
    assert.deepEqual(specialistOutputs(["artifacts/hosted-production-e2e.json", report, signals]), { report, signals });
  }
});

test("missing, mixed or ambiguous packages cannot certify delivery", () => {
  for (const artifacts of [
    undefined,
    ["safety-report.md"],
    ["deliverables/a/safety-report.md", "deliverables/b/signals.csv"],
    ["safety-report.md", "signals.csv", "deliverables/a/safety-report.md", "deliverables/a/signals.csv"],
    ["../safety-report.md", "../signals.csv"],
  ]) assert.throws(() => specialistOutputs(artifacts), { code: "hosted_e2e_specialist_output_untracked" });
});

test("automated acceptance proves memory exclusion instead of requiring a forbidden extraction", () => {
  const run = { automated: true }, existing = new Set(["old"]);
  assert.doesNotThrow(() => assertAutomatedMemoryIsolation(run, [], [{ id: "old", value: "marker" }], existing, "marker"));
  assert.throws(() => assertAutomatedMemoryIsolation({}, [], [], existing, "marker"), { code: "hosted_e2e_automation_untracked" });
  for (const [project, profile] of [[[{ kind: "run_summary" }], []], [[], [{ id: "new", value: "marker" }]]]) {
    assert.throws(() => assertAutomatedMemoryIsolation(run, project, profile, existing, "marker"), { code: "hosted_e2e_automated_memory_leak" });
  }
});

/** A control plane that answers the transcript route as `transcripts` says, in order, and counts the runtime starts. */
async function fakeControlPlane(transcripts) {
  const seen = { transcriptReads: 0, starts: 0 };
  const server = createServer((request, response) => {
    const reply = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method === "POST" && request.url === "/api/commands/start_runtime") { seen.starts += 1; request.resume(); return reply(200, { data: "http://x/api/runtime" }); }
    if (request.method === "GET" && request.url === "/api/runtime/sessions/s1/transcript") { const next = transcripts[Math.min(seen.transcriptReads, transcripts.length - 1)]; seen.transcriptReads += 1; return reply(next.status, next.body); }
    return reply(404, { code: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a transcript read after the run starts a stopped runtime once and reads again", async (t) => {
  const gone = { status: 409, body: { code: "runtime_not_running" } };
  const plane = await fakeControlPlane([gone, { status: 200, body: { data: { messages: [{ role: "user" }] } } }]);
  t.after(plane.close);
  const read = await sessionTranscript(plane.base, `${plane.base}/api/runtime`, "s1", {});
  assert.deepEqual(read.body.data.messages, [{ role: "user" }]);
  assert.deepEqual(plane.seen, { transcriptReads: 2, starts: 1 });
});

test("a transcript read starts nothing when the runtime is running, and a second refusal is the answer, not a loop", async (t) => {
  const running = await fakeControlPlane([{ status: 200, body: { data: { messages: [] } } }]);
  t.after(running.close);
  await sessionTranscript(running.base, `${running.base}/api/runtime`, "s1", {});
  assert.deepEqual(running.seen, { transcriptReads: 1, starts: 0 });
  const stuck = await fakeControlPlane([{ status: 409, body: { code: "runtime_not_running" } }]);
  t.after(stuck.close);
  await assert.rejects(sessionTranscript(stuck.base, `${stuck.base}/api/runtime`, "s1", {}), { code: "hosted_e2e_request_failed", status: 409, responseCode: "runtime_not_running" });
  assert.deepEqual(stuck.seen, { transcriptReads: 2, starts: 1 });
  const other = await fakeControlPlane([{ status: 409, body: { code: "something_else" } }]);
  t.after(other.close);
  await assert.rejects(sessionTranscript(other.base, `${other.base}/api/runtime`, "s1", {}), { responseCode: "something_else" });
  assert.deepEqual(other.seen, { transcriptReads: 1, starts: 0 });
});
