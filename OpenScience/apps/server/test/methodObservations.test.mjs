// Turning a finished run into counter movements.
//
// The rule this file holds is that attribution is per deliverable and refuses
// anything it cannot stand behind: no verdict, no evidence; a digest that moved,
// no evidence; a name that belongs to something else's mount, not ours to count.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { toSkillName } from "@evimed/harness-port";

import { deliverableOutcome, invokedSkillsBySession, methodFilesReadByCommand, runMethodObservations } from "../src/methodObservations.mjs";

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

test("a method read without a delegation is reported, attributed to nothing, and not 'passed over'", () => {
  // The open-domain answer line never delegates, so it has no subagent receipt
  // and every loop keyed to one skips it. Before this the module said the run
  // used no methods *and* that both approved methods had been available and
  // passed over — a denominator moving in the wrong direction on every run of a
  // whole product line.
  const skill = toSkillName("triage", "capsule");
  const derived = runMethodObservations({
    run,
    projection: { plan: { items: [] }, subagents: [] },
    methods: METHODS,
    sessions: [session("root", [skill])],
  });
  assert.deepEqual(derived.observations, [], "no mounted digest and no verdict is no attribution");
  assert.deepEqual(derived.methodsLoaded, [], "the receipt records the mount, and there was none");
  assert.deepEqual(derived.invokedWithoutMount, [{ id: "method:learned:triage", name: "triage" }],
    "the id is what the ledger is keyed by; a name alone cannot be written back");
  assert.deepEqual(derived.eligible, ["method:learned:quoting"],
    "quoting was passed over; triage was read, so counting it as passed over is a false denominator");
});

test("a run that ends early still counts every verdict it reached, and invents none", () => {
  // The guarantee MemOS's plugins get from writing only on a completed turn,
  // this module gets per deliverable instead — and more strictly, because a
  // deliverable's verdict is recorded by the gate rather than inferred from how
  // the run ended. Nothing pinned it, so it was one `deliverableOutcome` branch
  // away from a cancelled run becoming evidence against every mounted method.
  const cancelled = projection({
    plan: {
      items: [
        { id: "d1", status: "accepted", attempts: 1 },   // adjudicated before the stop
        { id: "d2", status: "delegated", attempts: 0 },  // in flight when it stopped
        { id: "d3", status: "planned", attempts: 0 },    // never started
      ],
    },
  });
  for (const status of ["cancelled", "failed", "succeeded"]) {
    const derived = runMethodObservations({ run: { ...run, status }, projection: cancelled, methods: METHODS });
    assert.deepEqual(
      derived.observations.map((entry) => [entry.observation.family, entry.observation.outcome]),
      [["run_1:d1", "accepted"]],
      `${status}: only the deliverable that reached a verdict is evidence`,
    );
  }
});

test("reading a mounted method's own file is a use of it, the same as calling it through the skill tool", async () => {
  // 2026-09-21: the capsule plugin lists mounted methods in a prompt section
  // and the model reads the one that applies, because an agent-scoped row
  // cannot register a skill at this pin. Counting only `skill` calls would
  // have called every read method idle.
  const { learnedMethodDirectoryName } = await import("../src/learnedMethodMount.mjs");
  const directory = learnedMethodDirectoryName("method:learned:triage");
  const readSession = {
    sessionId: "root",
    transcript: { messages: [{ role: "tool", turn: 0, parts: [
      { type: "tool", tool: "read", callId: "c0", status: "completed", input: { path: `/runtime/capsule-methods/${directory}/SKILL.md` }, output: "", error: null },
      { type: "tool", tool: "read", callId: "c1", status: "completed", input: { path: "/workspace/notes/SKILL.md" }, output: "", error: null },
    ] }] },
  };
  const derived = runMethodObservations({ run, projection: { plan: { items: [] }, subagents: [] }, methods: METHODS, sessions: [readSession] });
  assert.deepEqual(derived.invokedWithoutMount, [{ id: "method:learned:triage", name: "triage" }]);
  assert.deepEqual(derived.eligible, ["method:learned:quoting"], "a file that is not a mounted method's names nothing");
});

test("a run that delegated nothing still records the methods its runtime carried, and chooses none of them by carrying", () => {
  // 2026-09-21: with work done inline, no delegation receipt existed, so a
  // run's `methodsLoaded` was empty and every paired-evaluation cell was
  // excluded as `arm_not_applied`.
  const derived = runMethodObservations({
    run,
    projection: { plan: { items: [] }, subagents: [], mountedMethods: [{ name: "triage", digest: DIGEST_A }, { name: "quoting", digest: DIGEST_B }] },
    methods: METHODS,
    sessions: [],
  });
  assert.deepEqual(derived.methodsLoaded, [{ name: "triage", digest: DIGEST_A }, { name: "quoting", digest: DIGEST_B }]);
  assert.deepEqual(derived.observations, [], "carrying a method is not a verdict about it");
  assert.deepEqual(derived.eligible, ["method:learned:triage", "method:learned:quoting"], "carried and never read is still passed over");
});

test("a deliverable the root session made itself is attributed to the methods its runtime carried", () => {
  // 2026-09-26 audit (L-G2): the meta-analysis runs the loop learnt from did
  // their work without delegating, so they left no receipt and earned their
  // methods no observation at all. The runtime's own mount report and the
  // deliverable's verdict are enough to attribute them.
  const derived = runMethodObservations({
    run: { id: "run_root", sessionId: "root" },
    projection: {
      plan: { items: [
        { id: "report", status: "accepted", attempts: 2 },
        { id: "matrix", status: "submitted", attempts: 1 },
        { id: "later", status: "planned", attempts: 0 },
        { id: "delegated", status: "accepted", attempts: 1 },
      ] },
      subagents: [{ deliverableId: "delegated", childSessionId: "child", methods: [{ name: "quoting", digest: DIGEST_B }] }],
      mountedMethods: [{ name: "triage", digest: DIGEST_A }, { name: "quoting", digest: DIGEST_B }],
    },
    methods: METHODS,
    sessions: [session("root", [toSkillName("triage", "capsule")]), session("child", [])],
    at: "2026-09-27T00:00:00.000Z",
  });
  const byFamily = (/** @type {string} */ family) => derived.observations.filter((entry) => entry.observation.family === family)
    .map((entry) => [entry.methodId, entry.observation.outcome, entry.observation.invoked]);
  assert.deepEqual(byFamily("run_root:report"), [
    ["method:learned:triage", "repaired", true],
    ["method:learned:quoting", "repaired", false],
  ], "each carried method gets the root's verdict, and 'used' is read off the root session");
  assert.deepEqual(byFamily("run_root:matrix"), [
    ["method:learned:triage", "rejected", true],
    ["method:learned:quoting", "rejected", false],
  ]);
  assert.deepEqual(byFamily("run_root:later"), [], "no verdict, no evidence");
  assert.deepEqual(byFamily("run_root:delegated"), [["method:learned:quoting", "accepted", false]],
    "a delegated deliverable keeps its receipt's methods and is not attributed twice");
  assert.deepEqual(derived.methodsInvoked, [{ name: "triage", digest: DIGEST_A }]);
  assert.deepEqual(derived.eligible, [], "a method the run's own deliverables carried was not passed over");
  assert.deepEqual(derived.invokedWithoutMount, [], "a use with a verdict is an observation, not a bare reading");

  // A carried method whose text moved since the mount is reported, never credited.
  const moved = runMethodObservations({
    run: { id: "run_moved", sessionId: "root" },
    projection: { plan: { items: [{ id: "report", status: "accepted", attempts: 1 }] }, subagents: [],
      mountedMethods: [{ name: "triage", digest: DIGEST_B }] },
    methods: METHODS,
    sessions: [session("root", [toSkillName("triage", "capsule")])],
  });
  assert.deepEqual(moved.observations, []);
  assert.deepEqual(moved.mismatched, [{ name: "triage", mounted: DIGEST_B, current: DIGEST_A }]);
});

test("a method file printed through the shell is opened; one only listed, counted or hashed is not", () => {
  const dir = `_lm${"a".repeat(32)}`;
  const other = `_lm${"b".repeat(32)}`;
  const file = `/runtime/capsule-methods/${dir}/SKILL.md`;
  for (const command of [
    `cat ${file}`,
    `sed -n '1,120p' ${file}`,
    `head -200 "${file}"`,
    `sudo cat ${file} | head -50`,
    `cd /runtime/capsule-methods && cat ${dir}/SKILL.md`,
    `LC_ALL=C grep -n Workflow ${file}`,
    `python3 -c "print(open('${file}').read())"`,
  ]) {
    assert.deepEqual(methodFilesReadByCommand(command), [dir], command);
  }
  for (const command of [
    `wc -l ${file}`,
    `ls -la /runtime/capsule-methods/${dir}/`,
    `stat ${file}`,
    `sha256sum ${file}`,
    "cat /workspace/notes/SKILL.md",
    `cat /runtime/capsule-methods/${dir}/SKILL.md.bak`,
    "",
    undefined,
  ]) {
    assert.deepEqual(methodFilesReadByCommand(command), [], String(command));
  }
  assert.deepEqual(methodFilesReadByCommand(`wc -l ${file} && cat /runtime/capsule-methods/${other}/SKILL.md`), [other],
    "each segment is judged by the program it runs");
});

test("the 2026-09-28 incident: carrying is not using, and opening the card's file is", async () => {
  // evals/method-quality/incidents/2026-09-28-learned-method-invoked-zero.json:
  // production recorded `loaded` 34 and `invoked` 0 while the model visibly
  // worked by the inlined methods. The case's scenarios are the production
  // shape and the card shape; each must attribute exactly what it says.
  const { learnedMethodDirectoryName } = await import("../src/learnedMethodMount.mjs");
  const incident = JSON.parse(await readFile(new URL("../../../evals/method-quality/incidents/2026-09-28-learned-method-invoked-zero.json", import.meta.url), "utf8"));
  assert.ok(incident.scenarios.length >= 3, "the case carries its scenarios");
  const digestOf = (/** @type {string} */ name) => `sha256:${Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64)}`;
  const idOf = (/** @type {string} */ name) => `method:learned:${name}`;
  const fill = (/** @type {string} */ text) => text.replace(/\{([a-z0-9-]+)\}/g, (_, name) => learnedMethodDirectoryName(idOf(name)));
  for (const scenario of incident.scenarios) {
    const names = [...new Set([...scenario.mounted, ...(scenario.delegations ?? []).flatMap((/** @type {any} */ entry) => entry.methods)])];
    const methods = names.map((name) => ({ id: idOf(name), name, digest: digestOf(name) }));
    const sessions = scenario.sessions.map((/** @type {any} */ entry) => ({
      sessionId: entry.sessionId,
      transcript: { messages: entry.tools.map((/** @type {any} */ call, /** @type {number} */ index) => ({ role: "tool", turn: 0, parts: [{
        type: "tool", tool: call.tool, callId: `c${index}`, status: "completed",
        input: JSON.parse(fill(JSON.stringify(call.input))), output: "", error: null,
      }] })) },
    }));
    const derived = runMethodObservations({
      run: { id: "run_incident", sessionId: "root" },
      projection: {
        plan: { items: scenario.deliverables },
        subagents: (scenario.delegations ?? []).map((/** @type {any} */ entry) => ({ deliverableId: entry.deliverableId, childSessionId: entry.childSessionId,
          methods: entry.methods.map((/** @type {string} */ name) => ({ name, digest: digestOf(name) })) })),
        mountedMethods: scenario.mounted.map((/** @type {string} */ name) => ({ name, digest: digestOf(name) })),
      },
      methods,
      sessions,
    });
    assert.deepEqual(derived.methodsInvoked.map((entry) => entry.name).sort(), [...scenario.expect.invoked].sort(), scenario.name);
    for (const [name, expected] of Object.entries(scenario.expect.observations)) {
      const found = derived.observations.filter((entry) => entry.methodId === idOf(name));
      assert.equal(found.length, 1, `${scenario.name}: one observation for ${name}`);
      assert.equal(found[0].observation.outcome, /** @type {any} */ (expected).outcome, `${scenario.name}: ${name} outcome`);
      assert.equal(found[0].observation.invoked, /** @type {any} */ (expected).invoked, `${scenario.name}: ${name} invoked`);
    }
  }
});
