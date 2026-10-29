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

  // No argument names a method to mount: the paired evaluation named the one it measured, whatever its family, and was deleted on
  // 2026-10-10. A caller still passing `trialMethodIds` gets what everyone gets, so the platform's own work still carries none.
  const lookup = { ...fakeLearning(documents), async getMethod(/** @type {string} */ _userId, /** @type {string} */ id) { return documents.find((document) => document.id === id); } };
  const named = await selectLearnedMethods(lookup, { userId: "u1", projectId: "p1", family: null, trialMethodIds: ["method:learned:geo"] });
  assert.deepEqual(named, []);
});

/* ------------------------------------------------- the mount follows the question (2026-10-23) */

import { createMethodSimilarity } from "../src/methodSimilarity.mjs";
import { CONVERSATION_SCOPE, methodFitsScope, methodScopeId, runScopeOf } from "../src/learnedMethodMount.mjs";

/** A method with its own words, so closeness to a question is decided by what the question says. */
const topical = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ extra = {}) => ({
  id: `method:learned:${id}`,
  payload: payloadFor(name, {
    frontmatter: { name, description, whenToUse: description, metadata: { role: "functional", evimed_schema: METHOD_SKILL_SCHEMA, applies_when: description } },
    statusChangedAt: extra.approvedAt ?? "2026-09-01T00:00:00.000Z",
    ...(extra.payload ?? {}),
  }),
});
const lexical = () => createMethodSimilarity();
const ask = (/** @type {any[]} */ documents, /** @type {any} */ scope) => selectLearnedMethods(fakeLearning(documents), { userId: "u1", projectId: "p1", similarity: lexical(), ...scope });

test("a topical first message mounts the nearest method and what it reuses, and says why", async () => {
  const pin = `sha256:${"a".repeat(64)}`;
  const grade = topical("grade", "grade-first", "Report GRADE certainty of evidence before effect sizes in every evidence summary table");
  grade.payload.dependencies = [{ name: "tidy-numbers", digest: pin }];
  grade.payload.frontmatter.metadata.depends_on = `tidy-numbers@${pin}`;
  const documents = [
    grade,
    topical("slides", "slide-titles", "Write slide titles as full sentences stating the conclusion of each slide"),
    // Nothing in what it says is near the question; the nearest one reuses it.
    topical("tidy", "tidy-numbers", "Round every figure to the precision the source gives and keep one decimal convention"),
  ];
  const selected = await ask(documents, { scopeId: CONVERSATION_SCOPE, query: "Summarize GRADE certainty of evidence and effect sizes for the evidence summary table" });
  assert.deepEqual(selected.map((method) => [method.name, method.reason]), [
    ["grade-first", "similarity"], ["tidy-numbers", "dependency"], ["slide-titles", "explore"],
  ], "the nearest, what it reuses whatever its own closeness, and the one slot of exposure for what nothing picked");
  assert.equal(selected.mode, "lexical", "no embedder was composed: the shared words ranked it, and the mount says so");
  assert.ok(selected.topScore !== null && selected.topScore > 0);
  // A message none of them is near leaves only the exposure.
  const unrelated = await ask(documents, { scopeId: CONVERSATION_SCOPE, query: "Plan a weekend kayak trip down the river" });
  assert.deepEqual(unrelated.map((method) => method.reason), ["explore"]);
  assert.equal(unrelated.topScore, null);
});

test("what the nearest reuse is capped by level, the highest first: one abstract, three functional, every atomic", async () => {
  const dep = (/** @type {string} */ name) => ({ name, digest: `sha256:${"a".repeat(64)}` });
  const make = (/** @type {string} */ name, /** @type {string[]} */ uses, /** @type {string} */ words) => {
    const document = topical(name, name, words);
    document.payload.dependencies = uses.map(dep);
    return document;
  };
  // Levels come from the graph: atoms and func-3 / func-4 (which reuse nothing) 0, func-1 / func-2 1, the abstracts 2, top 3.
  const documents = [
    make("top", ["abstract-a", "abstract-b", "func-1", "func-2", "func-3", "func-4", "atom-1", "atom-2"], "unmatched zebra quartz vineyard topology"),
    make("abstract-a", ["func-1"], "alpha"), make("abstract-b", ["func-2"], "beta"),
    make("func-1", ["atom-1"], "gamma"), make("func-2", ["atom-2"], "delta"), make("func-3", [], "epsilon"), make("func-4", [], "zeta"),
    make("atom-1", [], "eta"), make("atom-2", [], "theta"),
  ];
  const selected = await ask(documents, { scopeId: CONVERSATION_SCOPE, query: "unmatched zebra quartz vineyard topology" });
  const reasons = Object.fromEntries(selected.map((method) => [method.name, method.reason]));
  assert.deepEqual(reasons, {
    top: "similarity", "abstract-a": "dependency", "func-1": "dependency", "func-2": "dependency", "func-3": "dependency", "func-4": "dependency",
    "atom-1": "dependency", "atom-2": "dependency", "abstract-b": "explore",
  }, "the second abstract method is left out of the dependencies, and only the exposure slot can still take it");
  // And the functional cap: four functional methods reused, three pulled in.
  const wide = [make("wide-top", ["f1", "f2", "f3", "f4"], "quokka marmalade zeppelin nebula"),
    ...["f1", "f2", "f3", "f4"].map((name) => make(name, [`${name}-atom`], `${name} words`)), ...["f1", "f2", "f3", "f4"].map((name) => make(`${name}-atom`, [], `${name} atom words`))];
  const pulled = (await ask(wide, { scopeId: CONVERSATION_SCOPE, query: "quokka marmalade zeppelin nebula" })).filter((method) => method.reason === "dependency").map((method) => method.name);
  assert.equal(pulled.filter((name) => /^f\d$/.test(name)).length, 3, "three functional methods, and the atoms they reuse");
  assert.equal(pulled.filter((name) => name.endsWith("-atom")).length, 3);
});

test("the exposure slot goes round: the method that has been in front of a model least, then the next", async () => {
  const documents = ["one", "two", "three"].map((name, index) => topical(name, `${name}-method`, `Unrelated topic number ${name} widget`, { approvedAt: `2026-09-0${index + 1}T00:00:00.000Z` }));
  const query = "completely different words about kayaks and rivers";
  /** @param {any[]} docs */
  const explored = async (docs) => (await ask(docs, { scopeId: CONVERSATION_SCOPE, query })).filter((method) => method.reason === "explore").map((method) => method.name);
  assert.deepEqual(await explored(documents), ["one-method"], "nothing is near the question: one card of exposure, the oldest first");
  documents[0].payload.learning = { counts: { carried: 4, explored: 1 } };
  assert.deepEqual(await explored(documents), ["two-method"], "the one carried most is passed over for the one carried least");
  documents[1].payload.learning = { counts: { explored: 3 } };
  documents[2].payload.learning = { counts: { carried: 9 } };
  assert.deepEqual(await explored(documents), ["two-method"], "carried and explored are both exposure");
  documents[1].payload.learning = { counts: { explored: 30 } };
  assert.deepEqual(await explored(documents), ["one-method"], "and it goes to the next one once the least has had its share");
});

test("without a question there is nothing to rank by: the most recently approved, as before, and no slot of exposure", async () => {
  const documents = ["one", "two", "three"].map((name, index) => topical(name, `${name}-method`, `Topic ${name}`, { approvedAt: `2026-09-0${index + 1}T00:00:00.000Z` }));
  const selected = await ask(documents, { scopeId: CONVERSATION_SCOPE });
  assert.deepEqual(selected.map((method) => [method.name, method.reason]), [["three-method", "recent"], ["two-method", "recent"], ["one-method", "recent"]]);
  assert.equal(selected.mode, "recent");
  // A similarity module that cannot answer is the same mount, never a run without its methods.
  const broken = await selectLearnedMethods(fakeLearning(documents), { userId: "u1", projectId: "p1", scopeId: CONVERSATION_SCOPE, query: "anything at all",
    similarity: { nearest: async () => { throw new Error("embedding down"); } } });
  assert.deepEqual(broken.map((method) => method.reason), ["recent", "recent", "recent"]);
});

test("a method is mounted for the runs of the scope it declares, the family reading stays for the ones that declare none", async () => {
  const declared = (/** @type {string} */ scope, /** @type {string} */ name) => topical(name, name, `Words for ${name}`, { payload: { provenance: { origin: "inferred", scope } } });
  const documents = [
    declared("meta-analysis", "meta-method"), declared("conversation", "chat-method"), declared("geo-content", "geo-method"),
    topical("legacy-research", "legacy-research", "Words for legacy research", { payload: { provenance: { origin: "inferred", capabilityId: "meta-analysis" } } }),
    topical("legacy-geo", "legacy-geo", "Words for legacy geo", { payload: { provenance: { origin: "inferred", capabilityId: "geo-content" } } }),
  ];
  const names = async (/** @type {any} */ scope) => (await ask(documents, scope)).map((method) => method.name).sort();
  assert.deepEqual(await names({ scopeId: "meta-analysis" }), ["legacy-research", "meta-method"], "a capability's run carries its own and the unscoped research ones");
  assert.deepEqual(await names({ scopeId: CONVERSATION_SCOPE }), ["chat-method", "legacy-research"]);
  assert.deepEqual(await names({ scopeId: "geo-content" }), ["geo-method", "legacy-geo"], "a GEO run never carries a research method, nor a research run a GEO one");
  assert.deepEqual(await names({ scopeId: null }), ["chat-method", "legacy-research"], "a start with no run in view is the conversation's");
  assert.deepEqual(await names({ scopeId: null, family: "geo" }), ["geo-method", "legacy-geo"]);
  assert.deepEqual(await names({ family: null }), [], "the platform's own work carries none");
  assert.deepEqual(await names({}), ["chat-method", "geo-method", "legacy-geo", "legacy-research", "meta-method"], "no scope and no family named is the whole library, as before");
  assert.equal(methodScopeId(documents[0].payload), "meta-analysis");
  assert.equal(methodScopeId({ provenance: { scope: "Not A Scope!" } }), null);
  assert.equal(runScopeOf("meta-analysis"), "meta-analysis");
  assert.equal(runScopeOf("open-domain-answer"), CONVERSATION_SCOPE);
  assert.equal(runScopeOf(null), CONVERSATION_SCOPE);
  assert.equal(methodFitsScope({ provenance: { scope: "meta-analysis" } }, { scopeId: "meta-analysis", family: "research" }), true);
});

test("a tight budget drops the exposure first and the nearest last, and counts what it left out", async () => {
  const documents = [
    topical("near", "grade-first", "Report GRADE certainty of evidence before effect sizes in every evidence summary table"),
    topical("far", "kayak-notes", "Kayak river rafting notes for the weekend"),
  ];
  const query = "GRADE certainty of evidence before effect sizes in the evidence summary table";
  const all = await ask(documents, { scopeId: CONVERSATION_SCOPE, query, cardDirectory: "/runtime/capsule-methods" });
  assert.deepEqual(all.map((method) => method.reason), ["similarity", "explore"]);
  const nearCard = all[0].promptBytes;
  /** @type {string[]} */
  const left = [];
  const tight = await ask(documents, { scopeId: CONVERSATION_SCOPE, query, cardDirectory: "/runtime/capsule-methods", maxBytes: nearCard, onLeftOut: (/** @type {string} */ id) => left.push(id) });
  assert.deepEqual(tight.map((method) => method.name), ["grade-first"]);
  assert.deepEqual(left, ["method:learned:far"]);
});
