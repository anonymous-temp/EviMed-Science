// Turning a finished run into counter movements.
//
// The rule this file holds is that attribution is per deliverable and refuses
// anything it cannot stand behind: no verdict, no evidence; a digest that moved,
// no evidence; a name that belongs to something else's mount, not ours to count.
import assert from "node:assert/strict";
import test from "node:test";

import { toSkillName } from "@evimed/harness-port";

import { deliverableOutcome, invokedSkillsBySession, runMethodObservations } from "../src/methodObservations.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const METHODS = [
  { id: "method:learned:triage", name: "triage", digest: DIGEST_A },
  { id: "method:learned:quoting", name: "quoting", digest: DIGEST_B },
];

/** @param {any} [overrides] */
const projection = (overrides = {}) => ({
  plan: {
    items: [
      { id: "d1", status: "accepted", attempts: 1 },
      { id: "d2", status: "accepted", attempts: 3 },
      { id: "d3", status: "submitted", attempts: 2 },
      { id: "d4", status: "delegated", attempts: 0 },
    ],
  },
  subagents: [
    { deliverableId: "d1", childSessionId: "s1", methods: [{ name: "triage", digest: DIGEST_A }] },
    { deliverableId: "d2", childSessionId: "s2", methods: [{ name: "triage", digest: DIGEST_A }] },
    { deliverableId: "d3", childSessionId: "s3", methods: [{ name: "triage", digest: DIGEST_A }] },
    { deliverableId: "d4", childSessionId: "s4", methods: [{ name: "triage", digest: DIGEST_A }] },
  ],
  ...overrides,
});

/** One session's transcript in the normalized `RunTranscript` vocabulary.
 *  Not `part.state.*`: that is the ledger's spelling of the same facts, and
 *  reading it here matched nothing in any real run while these tests, written
 *  to the same assumption, stayed green. The last test drives the real
 *  normalizer so the shape is proven rather than restated.
 *  @param {string} sessionId @param {string[]} skills */
const session = (sessionId, skills) => ({
  sessionId,
  transcript: {
    messages: skills.map((name, index) => ({
      role: "tool",
      turn: index,
      parts: [{ type: "tool", tool: "skill", callId: `c${index}`, status: "completed", input: { name }, output: "", error: null }],
    })),
  },
});

const run = { id: "run_1" };

test("a verdict becomes an outcome, and no verdict becomes nothing", () => {
  assert.equal(deliverableOutcome({ status: "accepted", attempts: 1 }), "accepted");
  assert.equal(deliverableOutcome({ status: "accepted", attempts: 0 }), "accepted");
  // Accepted after repairs is still a success and is still a different fact.
  assert.equal(deliverableOutcome({ status: "accepted", attempts: 4 }), "repaired");
  assert.equal(deliverableOutcome({ status: "submitted", attempts: 2 }), "rejected");
  assert.equal(deliverableOutcome({ status: "rejected", attempts: 1 }), "rejected");
  for (const item of [{ status: "planned" }, { status: "delegated" }, null, undefined, {}]) {
    assert.equal(deliverableOutcome(item), null, JSON.stringify(item));
  }
});

test("each deliverable is its own trajectory, keyed so a retry cannot double count", () => {
  const derived = runMethodObservations({ run, projection: projection(), methods: METHODS, at: "2026-09-07T00:00:00.000Z" });
  assert.deepEqual(derived.observations.map((entry) => [entry.observation.family, entry.observation.outcome]), [
    ["run_1:d1", "accepted"],
    ["run_1:d2", "repaired"],
    ["run_1:d3", "rejected"],
  ], "d4 never asked for a verdict, so it is not evidence either way");
  for (const entry of derived.observations) {
    assert.equal(entry.methodId, "method:learned:triage");
    assert.equal(entry.observation.runId, "run_1");
    assert.equal(entry.observation.at, "2026-09-07T00:00:00.000Z");
  }
});

test("invoked is read per session, so one child's reading is not credited to its sibling", () => {
  const skill = toSkillName("triage", "capsule");
  const derived = runMethodObservations({
    run, projection: projection(), methods: METHODS,
    sessions: [session("s1", [skill]), session("s2", ["some-other-skill"]), session("s3", [])],
  });
  const byFamily = new Map(derived.observations.map((entry) => [entry.observation.family, entry.observation.invoked]));
  assert.equal(byFamily.get("run_1:d1"), true);
  assert.equal(byFamily.get("run_1:d2"), false);
  assert.equal(byFamily.get("run_1:d3"), false);
  assert.deepEqual(derived.methodsInvoked, [{ name: "triage", digest: DIGEST_A }]);
});

test("a method amended since the mount is reported, never attributed", () => {
  // The whole point of keying counters to (method, digest): crediting new text
  // with old text's outcome is worse than counting nothing.
  const moved = [{ id: "method:learned:triage", name: "triage", digest: DIGEST_B }];
  const derived = runMethodObservations({ run, projection: projection(), methods: moved });
  assert.deepEqual(derived.observations, []);
  assert.deepEqual(derived.mismatched, [{ name: "triage", mounted: DIGEST_A, current: DIGEST_B }]);
  // Still recorded as what was in the room — the ledger's receipt is unchanged.
  assert.deepEqual(derived.methodsLoaded, [{ name: "triage", digest: DIGEST_A }]);
});

test("a name from another source's mount is passed through and counted as nothing", () => {
  // `capsuleMethods.mjs` writes capsule work-style entries into the same
  // directory under names like `method-_abc`. They are real mounted text and
  // belong in the receipt; they are not learned methods and have no counters.
  const shared = projection({
    subagents: [{ deliverableId: "d1", childSessionId: "s1", methods: [
      { name: "triage", digest: DIGEST_A },
      { name: "method-_deadbeef", digest: DIGEST_B },
    ] }],
  });
  const derived = runMethodObservations({ run, projection: shared, methods: METHODS });
  assert.deepEqual(derived.observations.map((entry) => entry.methodId), ["method:learned:triage"]);
  assert.deepEqual(derived.methodsLoaded.map((entry) => entry.name).sort(), ["method-_deadbeef", "triage"]);
  assert.deepEqual(derived.mismatched, [], "an unknown name is not a stale digest");
});

test("available and not mounted is the denominator, and it is counted once for the run", () => {
  const derived = runMethodObservations({ run, projection: projection(), methods: METHODS });
  assert.deepEqual(derived.eligible, ["method:learned:quoting"],
    "quoting was approved and never reached the mount");
  assert.ok(!derived.eligible.includes("method:learned:triage"));
});

test("a run with no delegation and no projection yields nothing rather than guessing", () => {
  for (const input of [
    { run, projection: {}, methods: METHODS },
    { run, projection: { plan: { items: [] }, subagents: [] }, methods: METHODS },
    { run, projection: projection(), methods: [] },
  ]) {
    const derived = runMethodObservations(input);
    assert.deepEqual(derived.observations, []);
  }
  // With no known methods there is no denominator either.
  assert.deepEqual(runMethodObservations({ run, projection: projection(), methods: [] }).eligible, []);
});

test("only a completed skill call counts as an invocation", () => {
  const messages = [
    { parts: [{ type: "tool", tool: "skill", callId: "a", status: "pending", input: { name: "capsule-a" }, output: "", error: null }] },
    { parts: [{ type: "tool", tool: "read", callId: "b", status: "completed", input: { name: "capsule-b" }, output: "", error: null }] },
    { parts: [{ type: "text", text: "capsule-c" }] },
    { parts: [{ type: "tool", tool: "skill", callId: "d", status: "completed", input: { name: " capsule-d " }, output: "", error: null }] },
  ];
  const found = invokedSkillsBySession([{ sessionId: "s1", transcript: { messages } }]);
  assert.deepEqual([...(found.get("s1") ?? [])], ["capsule-d"]);
  assert.deepEqual([...invokedSkillsBySession([{ transcript: { messages } }]).keys()], [], "a session with no id is not a session");
});

test("the shape is the one the real normalizer produces, not the one this file assumed", async () => {
  // Same tooth as `toolExecutionEdges.test.mjs`, for the same reason: this
  // module read the ledger's `part.state.input.name` while
  // `collectRunTranscripts` hands it the normalized transcript, so `invoked`
  // would have been false for every method in every run and nothing would have
  // said so.
  const { normalizeTranscript } = await import("../src/dshRuntimeAdapter.mjs");
  const skill = toSkillName("triage", "capsule");
  const transcript = normalizeTranscript("s1", [
    { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 0 } } },
    { event: { type: "tool/call", seq: 2, time: 2, data: { turn: 0, name: "skill", callId: "c1", arguments: { name: skill } } } },
    { event: { type: "tool/result", seq: 3, time: 3, data: { turn: 0, callId: "c1", message: { callId: "c1", name: "skill", content: [{ type: "text", text: "loaded" }] } } } },
  ]);
  const found = invokedSkillsBySession([{ sessionId: "s1", transcript }]);
  assert.deepEqual([...(found.get("s1") ?? [])], [skill], "the normalizer's own output must be readable here");
});
