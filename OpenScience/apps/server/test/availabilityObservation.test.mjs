// What one finished run says about the capability it ran, the tools it called and the skills it used — the
// join the hosted collector makes, as pure functions over the records that already existed. These pin the
// row's own rule that unknown stays unknown: an open call, a refused credential and an unreadable transcript
// each say nothing, and a skill is named only where its version is genuinely known.
import assert from "node:assert/strict";
import test from "node:test";

import { observationsOfRun, skillVersionsOfRun, tallyToolCalls, toolCallOutcome } from "../src/availabilityObservation.mjs";

const DIGEST = `sha256:${"b".repeat(64)}`;
const call = (tool, status, extra = {}) => ({ type: "tool", tool, callId: `c-${Math.random()}`, status, input: {}, output: "", error: null, ...extra });
const ok = (tool, extra = {}) => call(tool, "completed", { output: JSON.stringify({ status: "success", summary: "x" }), ...extra });
const failedWith = (tool, code, extra = {}) => call(tool, "completed", { output: JSON.stringify({ status: "error", error: { code, message: "no" } }), ...extra });
const message = (parts, time = Date.parse("2026-10-03T08:00:00.000Z")) => ({ sessionId: "s1", role: "assistant", time, parts });

const finishedRun = (extra = {}) => ({
  id: "run_1", dispatchId: "dispatch-1", sessionId: "session-1", status: "succeeded", errorCode: null,
  effectiveAgentId: "adr-analysis", effectiveAgentVersion: "1.3.1", finishedAt: "2026-10-03T09:00:00.000Z", durationMs: 1_380_000,
  artifacts: ["safety-report.md", "signals.csv"], ...extra,
});
const manifest = { id: "adr-analysis", version: "1.3.1", skill: "adr-analysis", companionSkills: ["autopilot-episode"], outputs: [{ path: "safety-report.md", required: true }] };
const noResults = { total: 0, bound: 0 };

test("how a tool call ended is read from the persisted transcript's own shape", () => {
  assert.deepEqual(toolCallOutcome(ok("mcp__evimed__web_read")), { outcome: "succeeded", code: null });
  assert.deepEqual(toolCallOutcome(call("mcp__evimed__web_read", "completed", { output: "plain text, not an envelope" })), { outcome: "succeeded", code: null });
  assert.deepEqual(toolCallOutcome(failedWith("mcp__evimed__web_read", "public_source_http_error")), { outcome: "failed", code: "public_source_http_error" });
  assert.deepEqual(toolCallOutcome(call("mcp__evimed__web_read", "error", { error: { name: "ToolError", code: "timeout" } })), { outcome: "failed", code: "timeout" });
  assert.deepEqual(toolCallOutcome(call("mcp__evimed__web_read", "error", { error: { name: "ToolNotFoundError", code: "UNKNOWN_TOOL" } })), { outcome: "not-mounted", code: null });
  assert.deepEqual(toolCallOutcome(call("mcp__evimed__web_read", "error", { output: 'unknown tool "mcp__evimed__web_read"' })), { outcome: "not-mounted", code: null });
  // Unknown stays unknown: an open call, and a data source nobody configured for this researcher, prove nothing about the tool.
  assert.equal(toolCallOutcome(call("mcp__evimed__web_read", "pending")), null);
  assert.equal(toolCallOutcome(failedWith("mcp__evimed__core_search", "public_source_core_credential_missing")), null);
  assert.equal(toolCallOutcome(call("mcp__evimed__x", "error", { error: { code: "mr_input_remote_auth_required" } })), null);
});

test("a tool is tallied by its catalogue name under every spelling, and only research tools are counted", () => {
  const messages = [
    message([ok("mcp__evimed__web_read", { completedAt: Date.parse("2026-10-03T08:01:00.000Z") }), ok("evimed_web_read"), ok("evimed-research_web_read")]),
    message([failedWith("mcp__evimed__web_read", "timeout", { completedAt: Date.parse("2026-10-03T08:05:00.000Z") })]),
    // The kernel's own tools and socket tools fail routinely and are not the catalogue's.
    message([call("bash", "error", { error: { code: "exit_1" } }), call("read", "completed"), ok("evimed_submit_deliverable")]),
    // A name the catalogue does not carry, and the operator probe.
    message([ok("mcp__evimed__no_such_tool"), ok("mcp__evimed__health")]),
  ];
  const tally = tallyToolCalls(messages, { fallbackAt: "2026-10-03T09:00:00.000Z" });
  assert.deepEqual([...tally.keys()], ["web_read"]);
  const row = tally.get("web_read");
  assert.equal(row?.succeeded, 3);
  assert.equal(row?.failed, 1);
  assert.equal(row?.failedCode, "timeout");
  assert.equal(row?.failedAt, "2026-10-03T08:05:00.000Z");
  assert.equal(row?.succeededAt, "2026-10-03T08:01:00.000Z", "the latest finish among the successes, from the call's own time");
});

test("a call with no time of its own takes its message's, and a message with none takes the run's", () => {
  const withMessageTime = tallyToolCalls([message([ok("mcp__evimed__literature_search")], Date.parse("2026-10-03T07:00:00.000Z"))], { fallbackAt: "2026-10-03T09:00:00.000Z" });
  assert.equal(withMessageTime.get("literature_search")?.succeededAt, "2026-10-03T07:00:00.000Z");
  const bare = tallyToolCalls([{ parts: [ok("mcp__evimed__literature_search")] }], { fallbackAt: "2026-10-03T09:00:00.000Z" });
  assert.equal(bare.get("literature_search")?.succeededAt, "2026-10-03T09:00:00.000Z");
});

test("a delivered run is a success of its exact capability version, joined to its results, cost and skills", () => {
  const messages = [message([
    ok("mcp__evimed__drug_safety_analysis"),
    failedWith("mcp__evimed__literature_search", "public_source_http_error"),
    call("skill", "completed", { input: { name: "personal-abc" } }),
    call("skill", "completed", { input: { name: "personal-not-pinned" } }),
  ])];
  const run = finishedRun({
    mountedSkills: ["adr-analysis"],
    personalSkillGeneration: { generationId: "a".repeat(64), pins: [
      { skillId: "skill:11111111-1111-1111-1111-111111111111", revision: 4, digest: DIGEST, nativeName: "personal-abc", source: "personal" },
      { skillId: "skill:22222222-2222-2222-2222-222222222222", revision: 1, digest: DIGEST, nativeName: "personal-mounted-only", source: "personal" },
    ] },
  });
  const observations = observationsOfRun({ run, projectId: "project-1", manifest, messages, results: { total: 3, bound: 2 }, costCny: 3.5, bodyDigest: DIGEST });
  const capability = observations.find((item) => item.kind === "capability");
  assert.equal(capability?.outcome, "succeeded");
  assert.equal(capability?.id, "adr-analysis");
  assert.equal(capability?.version, "1.3.1");
  assert.equal(capability?.durationMs, 1_380_000);
  assert.equal(capability?.costCny, 3.5);
  assert.equal(capability?.ref.runId, "run_1");
  assert.equal(capability?.ref.dispatchId, "dispatch-1");
  assert.equal(capability?.ref.sessionId, "session-1");
  assert.equal(capability?.ref.projectId, "project-1");
  assert.equal(capability?.ref.at, "2026-10-03T09:00:00.000Z");
  assert.equal(capability?.ref.resultVersions, 3);
  assert.equal(capability?.ref.boundResultVersions, 2);
  assert.deepEqual(capability?.ref.skills, [
    { name: "adr-analysis", source: "delegated", version: "1.3.1", digest: DIGEST },
    { name: "autopilot-episode", source: "delegated", version: "1.3.1", digest: null },
    { name: "personal-abc", source: "personal", version: "r4", digest: DIGEST },
  ], "a personal skill is named only when the model called it, at the revision and digest the run pinned");
  const tools = observations.filter((item) => item.kind === "tool").map((item) => `${item.id}:${item.outcome}`).sort();
  assert.deepEqual(tools, ["drug_safety_analysis:succeeded", "literature_search:failed"]);
});

test("a run that owes files and left none did not deliver, and says which code", () => {
  const observations = observationsOfRun({ run: finishedRun({ artifacts: [] }), projectId: "p", manifest, messages: [], results: noResults, costCny: null });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].outcome, "failed");
  assert.equal(observations[0].ref.code, "specialist_required_output_missing");
  // A result version counts as a delivery even where the ledger lists no artifact.
  assert.equal(observationsOfRun({ run: finishedRun({ artifacts: [] }), projectId: "p", manifest, messages: [], results: { total: 1, bound: 0 }, costCny: null })[0].outcome, "succeeded");
});

test("a failed run is evidence about its capability only when the capability, a source or an engine is answerable", () => {
  const failed = observationsOfRun({ run: finishedRun({ status: "failed", errorCode: "specialist_agent_unavailable", artifacts: [] }), projectId: "p", manifest, messages: null, results: noResults, costCny: null });
  assert.equal(failed[0].outcome, "failed");
  assert.equal(failed[0].ref.code, "specialist_agent_unavailable");
  for (const status of ["canceled"]) {
    assert.deepEqual(observationsOfRun({ run: finishedRun({ status, artifacts: [] }), projectId: "p", manifest, messages: null, results: noResults, costCny: null }), [], status);
  }
  // The platform stopped it, or a ceiling refused it: not a fact about the capability.
  for (const errorCode of ["runtime_canceled", "usage_budget_exceeded", "runtime_session_error"]) {
    assert.deepEqual(observationsOfRun({ run: finishedRun({ status: "failed", errorCode, artifacts: [] }), projectId: "p", manifest, messages: null, results: noResults, costCny: null }), [], errorCode);
  }
});

test("a tool call that happened is counted whatever became of the run", () => {
  const messages = [message([ok("mcp__evimed__web_search")])];
  const observations = observationsOfRun({ run: finishedRun({ status: "canceled", artifacts: [] }), projectId: "p", manifest, messages, results: noResults, costCny: null });
  assert.deepEqual(observations.map((item) => `${item.kind}:${item.id}:${item.outcome}`), ["tool:web_search:succeeded"]);
});

test("an unreadable transcript yields no tool observations at all, never invented ones", () => {
  const observations = observationsOfRun({ run: finishedRun(), projectId: "p", manifest, messages: null, results: noResults, costCny: null });
  assert.deepEqual(observations.map((item) => item.kind), ["capability"]);
});

test("a run with no capability, no version or no finish time has nothing to say about a capability", () => {
  const messages = [message([ok("mcp__evimed__web_search")])];
  const open = observationsOfRun({ run: finishedRun({ effectiveAgentId: null, effectiveAgentVersion: null }), projectId: "p", manifest: null, messages, results: noResults, costCny: null });
  assert.deepEqual(open.map((item) => item.kind), ["tool"]);
  assert.deepEqual(observationsOfRun({ run: finishedRun({ finishedAt: null }), projectId: "p", manifest, messages, results: noResults, costCny: null }), []);
});

test("a capability that owes no files delivers in its reply", () => {
  const answerOnly = { id: "open-domain-answer", version: "1.0.0", skill: "open-domain-answer", companionSkills: [], outputs: [] };
  const run = finishedRun({ effectiveAgentId: "open-domain-answer", effectiveAgentVersion: "1.0.0", artifacts: [] });
  const [capability] = observationsOfRun({ run, projectId: "p", manifest: answerOnly, messages: null, results: noResults, costCny: null });
  assert.equal(capability.outcome, "succeeded");
});

test("a skill version is recorded only where it is known: no digest for an old run, none for a companion", () => {
  const skills = skillVersionsOfRun({ manifest, run: finishedRun(), invoked: new Set(), bodyDigest: null });
  assert.deepEqual(skills.map((skill) => [skill.name, skill.version, skill.digest]), [["adr-analysis", "1.3.1", null], ["autopilot-episode", "1.3.1", null]]);
  assert.deepEqual(skillVersionsOfRun({ manifest: null, run: finishedRun(), invoked: new Set(), bodyDigest: null }), []);
});
