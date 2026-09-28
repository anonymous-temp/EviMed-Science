// The bytes a learned method becomes, and the number three parties must agree on.
//
// The test that earns this file is the digest one. The mount writes a file, the
// capsule plugin hashes that file into the delegation receipt, and the control
// plane folds the receipt into `(method, digest)` counters. If the rendering
// here and the hashing there disagree by one byte, every observation is dropped
// as stale and the loop records nothing while every component reports success.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, mountedMethodDigest, normalizeSkillBody } from "@evimed/domain";

import { safeId } from "../src/security.mjs";
import { FRONTIER_PROJECT_ID, LEARNING_PROJECT_ID, SOURCES_PROJECT_ID } from "../src/internalProjects.mjs";
import {
  MAX_MOUNTED_LEARNED_METHODS,
  learnedMethodCardBytes,
  learnedMethodDirectoryName,
  learnedMethodFamilyForRuntime,
  methodFamily,
  renderLearnedMethod,
  selectLearnedMethods,
} from "../src/learnedMethodMount.mjs";

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const BODY = [
  "## Purpose", "Do a thing.", "",
  "## When to Use", "When the thing is needed.", "",
  "## Workflow", "1. Do it.",
].join("\n");

/** @param {string} name @param {Record<string, unknown>} [extra] */
const payloadFor = (name, extra = {}) => ({
  status: "approved",
  frontmatter: {
    name,
    description: `Does ${name}.`,
    whenToUse: "When needed.",
    metadata: { role: "functional", evimed_schema: METHOD_SKILL_SCHEMA },
  },
  body: BODY,
  createdAt: "2026-09-01T00:00:00.000Z",
  ...extra,
});

/** @param {any[]} documents */
function fakeLearning(documents) {
  return {
    /** @type {any[]} */
    calls: [],
    async approvedMethods(_userId, options = {}) {
      this.calls.push(options);
      // The service's own rule: no project named reads the whole library.
      return options.projectId === undefined ? documents : documents.filter((document) => document.projectId === options.projectId);
    },
  };
}

/** @param {string} id @param {string} name @param {any} [options] */
const doc = (id, name, options = {}) => ({
  id,
  projectId: options.projectId === undefined ? "p1" : options.projectId,
  payload: payloadFor(name, options.payload ?? {}),
});

test("the rendered document is exactly what the receipt will hash", async () => {
  const payload = payloadFor("triage");
  const document = renderLearnedMethod(payload);
  // The control plane's number, from the payload.
  const stored = mountedMethodDigest(payload, sha256);
  // The plugin's number, from the file it read, computed the way the socket
  // computes it: normalise, then hash.
  const asRead = `sha256:${sha256(normalizeSkillBody(document))}`;
  assert.equal(stored, asRead, "the mount and the receipt must not be able to disagree");
  assert.match(document, /^---\n/);
  assert.match(document, /name: "triage"/);
  assert.match(document, /## Workflow/);
});

test("a directory name can never collide with the capsule half's", () => {
  const name = learnedMethodDirectoryName("method:learned:triage");
  assert.match(name, /^_lm[0-9a-f]{32}$/);
  // `safeId` can only return something starting with an alphanumeric, so a
  // leading underscore is the guarantee the two sources share the directory on.
  // Asserted against the real function rather than restated: this is the whole
  // basis for two independent writers sharing one directory.
  assert.throws(() => safeId(name, "directory"), (error) => error.code === "invalid_id");
  assert.equal(learnedMethodDirectoryName("method:learned:triage"), name, "stable across calls");
  assert.notEqual(learnedMethodDirectoryName("method:learned:quoting"), name);
});

test("a researcher's methods follow them: every project's are mounted, none twice", async () => {
  // 2026-09-21: a method learnt in one project reached no other, because the
  // mount read this project's methods plus account-wide ones and nothing ever
  // wrote an account-wide one.
  const elsewhere = doc("method:learned:elsewhere", "elsewhere", { projectId: "p2" });
  const learning = fakeLearning([doc("method:learned:local", "local"), elsewhere]);
  const selected = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1" });
  assert.deepEqual(selected.map((method) => method.id).sort(), ["method:learned:elsewhere", "method:learned:local"]);
  assert.equal(new Set(selected.map((method) => method.id)).size, selected.length);
  assert.deepEqual(learning.calls, [{}], "one read of the whole library, not one per scope");
});

test("the most recently made effective survives truncation", async () => {
  const documents = [
    doc("method:learned:old", "old", { payload: { statusChangedAt: "2026-09-01T00:00:00.000Z" } }),
    doc("method:learned:new", "new", { payload: { statusChangedAt: "2026-09-06T00:00:00.000Z" } }),
    doc("method:learned:mid", "mid", { payload: { statusChangedAt: "2026-09-03T00:00:00.000Z" } }),
  ];
  const selected = await selectLearnedMethods(fakeLearning(documents), { userId: "u1", projectId: "p1", maxCount: 2 });
  assert.deepEqual(selected.map((method) => method.name), ["new", "mid"]);
});

test("the byte budget is a real bound, including on the largest single method", async () => {
  const big = doc("method:learned:big", "big", { payload: { body: `${BODY}\n${"x".repeat(5000)}` } });
  const small = doc("method:learned:small", "small");
  const learning = fakeLearning([big, small]);
  const budget = Buffer.byteLength(renderLearnedMethod(small.payload), "utf8") + 10;
  const selected = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1", maxBytes: budget });
  assert.deepEqual(selected.map((method) => method.name), ["small"],
    "an inferred method that alone blows the prompt budget is a distillation defect, not a mount");
  assert.deepEqual(await selectLearnedMethods(learning, { userId: "u1", projectId: "p1", maxBytes: 1 }), []);
  assert.deepEqual(await selectLearnedMethods(learning, { userId: "u1", projectId: "p1", maxCount: 0 }), []);
});

test("given where the runtime sees them, methods are budgeted at their card and what is left out is named", async () => {
  // A mount hands a run each learned method's card and leaves the text in its
  // file; the recall API, which hands out the text, budgets the text.
  const long = (/** @type {string} */ name, /** @type {string} */ day) => doc(`method:learned:${name}`, name,
    { payload: { body: `${BODY}\n${"y".repeat(9_000)}`, statusChangedAt: `2026-09-${day}T00:00:00.000Z` } });
  const learning = fakeLearning([long("first", "20"), long("second", "21"), long("third", "22")]);
  const onText = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1", maxBytes: 12_000 });
  assert.deepEqual(onText.map((method) => method.name), ["third"], "on text only one 9 KB method fits in 12 KB");
  assert.ok(onText.every((method) => method.promptBytes === method.bytes));

  /** @type {string[]} */
  const leftOut = [];
  const cardDirectory = "/runtime/capsule-methods";
  const onCards = await selectLearnedMethods(learning, {
    userId: "u1", projectId: "p1", maxBytes: 12_000, cardDirectory, onLeftOut: (id) => leftOut.push(id),
  });
  assert.deepEqual(onCards.map((method) => method.name), ["third", "second", "first"]);
  assert.deepEqual(leftOut, []);
  for (const method of onCards) {
    const payload = (await learning.approvedMethods("u1")).find((/** @type {any} */ document) => document.id === method.id)?.payload;
    assert.equal(method.promptBytes, learnedMethodCardBytes(payload, method.directoryName, cardDirectory));
    assert.ok(method.promptBytes < 300, `a card is short: ${method.promptBytes} bytes`);
    assert.ok(method.bytes > 9_000, "the text is still what is written to disk");
  }
  // A budget smaller than the cards leaves the oldest out, by name.
  const tight = await selectLearnedMethods(learning, {
    userId: "u1", projectId: "p1", maxBytes: onCards[0].promptBytes + onCards[1].promptBytes, cardDirectory,
    onLeftOut: (id) => leftOut.push(id),
  });
  assert.deepEqual(tight.map((method) => method.name), ["third", "second"]);
  assert.deepEqual(leftOut, ["method:learned:first"]);
});

test("a method with no name or no body is not mounted, because it could never be counted", async () => {
  const documents = [
    doc("method:learned:nameless", ""),
    doc("method:learned:empty", "empty", { payload: { body: "   \n" } }),
    doc("method:learned:fine", "fine"),
  ];
  const selected = await selectLearnedMethods(fakeLearning(documents), { userId: "u1", projectId: "p1" });
  assert.deepEqual(selected.map((method) => method.name), ["fine"]);
});

test("no service at all is an empty mount, not a throw", async () => {
  assert.deepEqual(await selectLearnedMethods(null, { userId: "u1", projectId: "p1" }), []);
  assert.equal(MAX_MOUNTED_LEARNED_METHODS, 16);
});

test("a runtime carries the learned methods of the work it is for, and the platform's own projects carry none", async () => {
  // 2026-09-25: `claim-verdict-audit`, learnt from a meta-analysis, was
  // mounted into every source-understanding run and every geo-content writing
  // run (audit 2026-09-26, L-G7).
  assert.equal(methodFamily("meta-analysis"), "research");
  assert.equal(methodFamily(undefined), "research", "a method learnt before the capability was recorded is research");
  assert.equal(methodFamily("open-domain-answer"), "research");
  assert.equal(methodFamily("geo-content"), "geo");
  assert.equal(methodFamily("geography-like"), "research", "a prefix of our own ids, not a word");

  assert.equal(learnedMethodFamilyForRuntime({ projectId: LEARNING_PROJECT_ID }), null);
  assert.equal(learnedMethodFamilyForRuntime({ projectId: SOURCES_PROJECT_ID, boundedRunId: "source-understanding-1" }), null);
  assert.equal(learnedMethodFamilyForRuntime({ projectId: FRONTIER_PROJECT_ID }), null);
  assert.equal(learnedMethodFamilyForRuntime({ projectId: "brand-x", boundedRunId: "geo-run-abc" }), "geo");
  assert.equal(learnedMethodFamilyForRuntime({ projectId: "brand-x" }), "research", "a conversation in a GEO project is research");
  assert.equal(learnedMethodFamilyForRuntime({ projectId: `methodeval-${"ab".repeat(12)}`, boundedRunId: "method-eval-1" }), "research",
    "an evaluation cell measures research methods");

  const documents = [
    doc("method:learned:research", "research-method", { payload: { provenance: { origin: "inferred", capabilityId: "meta-analysis" } } }),
    doc("method:learned:legacy", "legacy-method"),
    doc("method:learned:geo", "geo-method", { payload: { provenance: { origin: "inferred", capabilityId: "geo-content" } } }),
  ];
  const names = async (/** @type {any} */ scope) => (await selectLearnedMethods(fakeLearning(documents), { userId: "u1", projectId: "p1", ...scope }))
    .map((method) => method.name).sort();
  assert.deepEqual(await names({ family: "research" }), ["legacy-method", "research-method"]);
  assert.deepEqual(await names({ family: "geo" }), ["geo-method"]);
  assert.deepEqual(await names({ family: null }), [], "the platform's own work carries no researcher's method");
  assert.deepEqual(await names({}), ["geo-method", "legacy-method", "research-method"], "no family named is the whole library, as before");

  // An evaluation names the method it measures, and gets it whatever its family.
  const trialLearning = { ...fakeLearning(documents), async getMethod(/** @type {string} */ _userId, /** @type {string} */ id) {
    return documents.find((document) => document.id === id);
  } };
  const trial = await selectLearnedMethods(trialLearning, { userId: "u1", projectId: "p1", family: null, trialMethodIds: ["method:learned:geo"] });
  assert.deepEqual(trial.map((method) => [method.name, method.trial]), [["geo-method", true]]);
});
