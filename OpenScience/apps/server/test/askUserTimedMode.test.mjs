// The question tool's second way of waiting, from the deployment's switch to what the control plane lets through and records.
//
// `OPEN_SCIENCE_RUNTIME_ASK_USER_MODE` is `attended` (the kernel's blocking tool: the turn holds until the person answers) or
// `timed` (after the tool's own deadline the model is told "pending", carries on with the work that does not depend on the answer,
// and the answer arrives later as a message). It was measured on a real kernel before it was offered
// (`.evimed-local/acceptance/course-correction-20261012/live/r19-upstream2a/`); the default stays `attended`.
//
// Three halves are held here. The lever reaches the preset row that reads it, and every container is told. The two kernel methods
// the page needs to answer a question after the turn moved on are not refused by the proxy. And what the ledger sees of a timed
// question — a result that is "pending", not an error and not an answer — is not a failure of the run, and the late answer is
// workload (`nativeTurns.test.mjs` holds the adoption itself).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { isDeniedRuntimeUiMethod, RUNTIME_UI_DENIED_NAMESPACES } from "@evimed/domain";
import { loadConfig, parseAskUserMode } from "../src/config.mjs";
import { normalizeTranscript } from "../src/dshRuntimeAdapter.mjs";
import { runtimeEnvironment } from "../src/dshProfilePatch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file) => readFile(path.join(repoRoot, file), "utf8");

test("the mode is read by name, defaults to the blocking tool, and a name that is neither is refused", () => {
  assert.equal(parseAskUserMode(undefined), "attended");
  assert.equal(parseAskUserMode(""), "attended", "a value-less compose entry delivers an empty string");
  assert.equal(parseAskUserMode("attended"), "attended");
  assert.equal(parseAskUserMode(" TIMED "), "timed");
  assert.throws(() => parseAskUserMode("legacy"), /must be attended or timed/, "the kernel's own word is not the deployment's");
  assert.throws(() => parseAskUserMode("120"), /must be attended or timed/);
  assert.equal(loadConfig({}).runtimeAskUserMode, "attended");
});

test("every container is told the mode, and the one that was not told it is the blocking tool", () => {
  const base = { presetSkillsDir: "", capabilitiesDir: "", capabilitySkillsDir: "", capsuleMethodsDir: "", capsuleGatewayUrl: "",
    workloadTokenFile: "", bundleVersion: "0", limits: { deliveryAttemptLimit: 3, maxSteps: 10, maxTokens: 1000, evidenceStaleMinutes: 10 } };
  const flags = (extra) => ({ hosted: true, askUser: true, review: false, capsule: false, requiredEnforcement: "full", ...extra });
  assert.equal(runtimeEnvironment({ ...base, flags: flags({ askUserMode: "timed" }) }).EVIMED_ASK_USER_MODE, "timed");
  assert.equal(runtimeEnvironment({ ...base, flags: flags({ askUserMode: "attended" }) }).EVIMED_ASK_USER_MODE, "attended");
  assert.equal(runtimeEnvironment({ ...base, flags: flags({}) }).EVIMED_ASK_USER_MODE, "attended", "a caller that says nothing never turns it on");
  assert.equal(runtimeEnvironment({ ...base, flags: flags({ askUserMode: "legacy" }) }).EVIMED_ASK_USER_MODE, "attended", "only `timed` is timed");
});

test("the preset row reads the mode and carries the deadline; any other value leaves the kernel's blocking tool", async () => {
  for (const file of ["packages/socket/presets/evimed-universal/agent.cordis.yml", "packages/socket/presets/evimed-universal.patch.yml"]) {
    const text = await read(file);
    const at = text.indexOf("id: tool-ask-user");
    assert.ok(at > 0, `${file} has no tool-ask-user row`);
    const row = text.slice(at, text.indexOf("- id: compaction", at));
    assert.match(row, /disabled: !!js process\.env\.EVIMED_ASK_USER !== '1'/, "the existing switch still turns the whole tool off");
    assert.match(row, /mode: !!js \(process\.env\.EVIMED_ASK_USER_MODE === 'timed' && 'timed'\) \|\| 'legacy'/,
      "no value but `timed` may reach the kernel's own `mode`, which refuses a name it does not know");
    assert.match(row, /timeout: 120\b/, "the foreground wait is the kernel's own default, written down");
  }
  // The expression has no ternary colon: a plain YAML scalar cannot carry one, and a row that fails to parse takes the kernel down.
  assert.doesNotMatch(await read("packages/socket/presets/evimed-universal/agent.cordis.yml"), /EVIMED_ASK_USER_MODE[^\n]*\?[^\n]*:/);
});

test("the lever reaches the web API and the runtime controller, which builds each runtime's launch plan, and is documented", async () => {
  const compose = YAML.parse(await read("deploy/web/docker-compose.yml"), { merge: true });
  for (const service of ["open-science-web", "open-science-runtime-controller"]) {
    const environment = compose.services[service].environment;
    assert.ok(Object.hasOwn(environment, "OPEN_SCIENCE_RUNTIME_ASK_USER_MODE"), `${service} is not given OPEN_SCIENCE_RUNTIME_ASK_USER_MODE`);
    assert.ok(Object.hasOwn(environment, "OPEN_SCIENCE_RUNTIME_ASK_USER"), "the lever travels beside the switch it refines");
  }
  assert.match(await read("deploy/web/.env.example"), /^# OPEN_SCIENCE_RUNTIME_ASK_USER_MODE=attended$/m);
});

test("the page answers a question the turn has moved past through two methods, and the proxy lets both through", () => {
  // `answer` settles a continued question and `attachWait` holds the foreground wait while the card is open. The control plane's
  // own adapter never calls them (the seam manifest lists them as denied to it), the page does.
  assert.equal(isDeniedRuntimeUiMethod("userQuestions/answer"), false);
  assert.equal(isDeniedRuntimeUiMethod("userQuestions/attachWait"), false);
  assert.ok(!RUNTIME_UI_DENIED_NAMESPACES.includes("userQuestions"), "the namespace is the page's, not the deployment's to hide");
  // The other new namespaces of the same release stay refused, so this is a decision about this one.
  assert.equal(isDeniedRuntimeUiMethod("productAnalytics/report"), true);
});

test("a pending result is a finished tool call, neither a failure nor an answer, and a late answer is workload", () => {
  const callId = "call_pending_1";
  const frames = [
    { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
    { type: "user/message", seq: 2, time: 1001, data: { content: [{ type: "text", text: "ask me, then go on" }], source: { kind: "user", rpcId: "r1" } } },
    { type: "tool/call", seq: 3, time: 1002, data: { turn: 1, step: 1, callId, name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q", question: "Which?" }], timeout: 120 }) } },
    { type: "tool/result", seq: 4, time: 121_002, data: { turn: 1, step: 1, toolCallId: callId,
      message: { toolCallId: callId, content: [{ type: "text", text: JSON.stringify({ pending: true, callId, message: "No answer batch arrived before the timeout." }) }] } } },
    { type: "assistant/message", seq: 5, time: 121_500, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "Going on without it." }] } } },
    { type: "turn/end", seq: 6, time: 121_600, data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", seq: 7, time: 300_000, data: { turn: 2 } },
    { type: "user/message", seq: 8, time: 300_001, data: { content: [{ type: "text", text: JSON.stringify({ kind: "answer_to_pending_question", callId, answers: [{ id: "q", selected: ["A"] }] }) }],
      source: { kind: "user-question-reply", callId, outcome: "answered" } } },
    { type: "turn/end", seq: 9, time: 301_000, data: { turn: 2, reason: { kind: "completed" } } },
  ];
  const transcript = normalizeTranscript("session-timed", frames);
  const ask = transcript.messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.callId === callId);
  assert.equal(ask.status, "completed", "a pending result is a result");
  assert.equal(ask.error, null, "and not an error: nothing in the ledger may count it as a failed tool");
  assert.match(String(ask.output), /"pending":true/);
  const reply = transcript.messages.find((message) => message.source === "user-question-reply");
  assert.equal(reply.sourceRequestId, `reply:${callId}`);
  assert.equal(reply.answeredCallId, callId);
  assert.deepEqual(transcript.turns.map((turn) => turn.end?.kind), ["completed", "completed"]);
});
