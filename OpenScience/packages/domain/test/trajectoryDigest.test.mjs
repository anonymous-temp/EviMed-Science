import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_CHOREOGRAPHY_TOOL_NAMES, SOCKET_TOOL_NAME_LIST, TRAJECTORY_DIGEST_LIMITS, artifactShapesMatch, cleanArtifactShapes,
  isPlatformChoreographyTool, trajectoryDigest,
} from "@evimed/domain";

const ROOT = "ses_root";
const CHILD = "ses_child";

/** @param {number} seq @param {string} text @param {Record<string, any>} [extra] */
const user = (seq, text, extra = {}) => ({
  sessionId: ROOT, role: "user", source: "user", seq, turn: 1, turnStartSeq: 1, sourceRequestId: "req_1", parts: [{ type: "text", text }], ...extra,
});
/** @param {number} seq @param {string} tool @param {string} [sessionId] */
const call = (seq, tool, sessionId = ROOT) => ({
  sessionId, role: "assistant", source: "user", seq, turn: 1, turnStartSeq: 1, parts: [{ type: "tool", tool, callId: `c${seq}`, status: "completed", input: {}, output: "ok" }],
});
const run = { id: "run_1", sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded", artifacts: ["report/weekly.docx"], unverifiedArtifacts: [], outputFiles: [] };

test("the digest keeps the first request of the run's turn and the intervention, with its place, in the person's own words", () => {
  const transcript = {
    header: { sessions: [{ sessionId: ROOT, parentSessionId: null }] },
    messages: [
      user(2, "帮我把本周的随访数据整理成周报，按科室分三节"),
      call(3, "read"),
      user(9, "不对，每一节只要三行", { sourceRequestId: "req_2" }),
      call(10, "write"),
    ],
  };
  const digest = trajectoryDigest(transcript, run);
  assert.deepEqual(digest.requests.map((entry) => [entry.seq, entry.text]), [[2, "帮我把本周的随访数据整理成周报，按科室分三节"]]);
  assert.deepEqual(digest.interventions.map((entry) => [entry.kind, entry.seq, entry.text]), [["steer", 9, "不对，每一节只要三行"]]);
  assert.deepEqual(digest.outcome, { status: "succeeded", repaired: false });
});

test("the platform's choreography is removed from the tool order in code, the work's tools stay in order, repeats fold", () => {
  const names = ["evimed_plan", "evimed_delegate", "read", "read", "mcp__evimed__literature_search", "evimed_await", "bash", "evimed_submit_deliverable",
    "evimed_package_check", "evimed_revise_deliverable", "evimed_render_report", "present", "todo_write", "ask_user_question", "subagent", "write"];
  const transcript = {
    messages: [user(1, "run it"), ...names.map((name, index) => call(10 + index, name, index % 2 ? CHILD : ROOT))],
  };
  assert.deepEqual(trajectoryDigest(transcript, run).tools, ["read", "literature_search", "bash", "write"]);
  for (const name of SOCKET_TOOL_NAME_LIST) assert.equal(isPlatformChoreographyTool(name), true, name);
  for (const name of ["present", "todo_write", "ask_user_question", "subagent"]) assert.ok(PLATFORM_CHOREOGRAPHY_TOOL_NAMES.includes(name));
  assert.equal(isPlatformChoreographyTool("bash"), false);
});

test("a run that is not a native turn reads every turn; the turns another run owns are not its own", () => {
  const messages = [
    user(1, "earlier question", { turnStartSeq: 1, sourceRequestId: "req_0" }),
    user(20, "this run's question", { turnStartSeq: 20, sourceRequestId: "req_1" }),
    user(25, "and another thing", { turnStartSeq: 20, sourceRequestId: "req_3" }),
  ];
  const own = trajectoryDigest({ messages }, run);
  assert.deepEqual(own.requests.map((entry) => entry.text), ["this run's question"]);
  assert.deepEqual(own.interventions.map((entry) => entry.text), ["and another thing"]);
  const legacy = trajectoryDigest({ messages }, { id: "run_old", sessionId: ROOT, status: "succeeded" });
  assert.deepEqual(legacy.requests.map((entry) => entry.text), ["earlier question", "this run's question"]);
});

test("platform envelopes are not what the person typed, and a message with a credential is dropped and counted", () => {
  const transcript = {
    messages: [
      user(1, "<evimed-brief>context the platform wrote</evimed-brief>\n整理这份表"),
      user(5, "key 是 sk-abcdefghijklmnopqrstuvwxyz0123456789 用这个", { sourceRequestId: "req_2" }),
      user(6, "<evimed-memory>recalled text</evimed-memory>", { sourceRequestId: "req_3" }),
    ],
  };
  const digest = trajectoryDigest(transcript, run);
  assert.equal(digest.requests[0].text, "整理这份表");
  assert.deepEqual(digest.interventions, [], "neither the credential nor the platform's injected text is an intervention");
  assert.equal(digest.dropped.sensitive, 1);
});

test("reactions the caller hands in join the transcript's own, in order, and a steer already in the transcript is not listed twice", () => {
  const transcript = { messages: [user(1, "写一份摘要"), user(8, "再短一点", { sourceRequestId: "req_2" })] };
  const digest = trajectoryDigest(transcript, run, {
    reactions: [
      { kind: "steer", text: "再短一点" },
      { kind: "follow-up", text: "不对，要英文", rule: "摘要写英文", verdict: "correction" },
      { kind: "result-corrected", seq: 4, text: "把第二段删掉" },
    ],
  });
  assert.deepEqual(digest.interventions.map((entry) => [entry.kind, entry.seq]), [["result-corrected", 4], ["steer", 8], ["follow-up", null]]);
  assert.equal(digest.interventions.find((entry) => entry.kind === "follow-up")?.rule, "摘要写英文");
});

test("artifacts carry the format and the shape that was read, and only a shape of the file's own format", () => {
  const transcript = { messages: [user(1, "x")] };
  const shapes = {
    "report/weekly.docx": { format: "docx", labels: ["Summary", "Findings 3", "Findings 3", "Next steps"] },
    "data/other.csv": { format: "docx", labels: ["wrong"] },
  };
  const digest = trajectoryDigest(transcript, { ...run, artifacts: ["report/weekly.docx"], outputFiles: ["data/other.csv", "notes"] }, { shapes });
  assert.deepEqual(digest.artifacts.map((entry) => [entry.path, entry.format, entry.shape?.labels ?? null]), [
    ["report/weekly.docx", "docx", ["summary", "findings #", "next steps"]],
    ["data/other.csv", "csv", null],
    ["notes", "other", null],
  ]);
});

test("the digest is bounded", () => {
  const messages = [user(1, "q")];
  for (let index = 0; index < 200; index += 1) messages.push(call(100 + index, `tool_${index}`));
  const digest = trajectoryDigest({ messages }, { ...run, artifacts: Array.from({ length: 40 }, (_, index) => `f${index}.md`) });
  assert.equal(digest.tools.length, TRAJECTORY_DIGEST_LIMITS.tools);
  assert.equal(digest.artifacts.length, TRAJECTORY_DIGEST_LIMITS.artifacts);
});

test("repaired says the deliverable was submitted more than once, from either record of it", () => {
  const transcript = { messages: [user(1, "q")] };
  assert.equal(trajectoryDigest(transcript, { ...run, repairRounds: { content: 1, structural: 0 } }).outcome.repaired, true);
  assert.equal(trajectoryDigest(transcript, run, { attempts: 2 }).outcome.repaired, true);
  assert.equal(trajectoryDigest(transcript, run, { attempts: 1 }).outcome.repaired, false);
});

test("two files are the same shape when their format and structure agree, and a format with no structure matches on the format", () => {
  const weekly = [{ format: "docx", labels: ["Summary", "Findings", "Next steps"] }];
  assert.equal(artifactShapesMatch(weekly, [{ format: "docx", labels: ["summary", "findings", "next steps", "appendix"] }]), true);
  assert.equal(artifactShapesMatch(weekly, [{ format: "docx", labels: ["Budget", "Risks", "Timeline"] }]), false);
  assert.equal(artifactShapesMatch(weekly, [{ format: "xlsx", labels: ["Summary", "Findings", "Next steps"] }]), false, "another format");
  assert.equal(artifactShapesMatch([{ format: "pdf", labels: [] }], [{ format: "pdf", labels: [] }]), true);
  assert.equal(artifactShapesMatch(weekly, [{ format: "docx", labels: ["Only"] }]), true, "one label is too little structure to disagree");
  assert.equal(artifactShapesMatch([], []), false, "a run with no file has no shape");
  assert.equal(artifactShapesMatch([{ format: "md", labels: ["a", "b"] }, { format: "csv", labels: [] }], [{ format: "csv", labels: [] }, { format: "md", labels: ["a", "b"] }]), true, "the order the files were made in does not matter");
});

test("a shape is cleaned and bounded where it enters the ledger", () => {
  const shapes = cleanArtifactShapes([
    { format: "DOCX", labels: Array.from({ length: 40 }, (_, index) => `Section ${index}${"x".repeat(60)}`) },
    { format: "", labels: ["dropped"] }, null, "nope",
  ]);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].format, "docx");
  assert.ok(shapes[0].labels.length <= 16);
  assert.ok(shapes[0].labels.every((label) => label.length <= 40));
});
