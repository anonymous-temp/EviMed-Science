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
import {
  MAX_MOUNTED_LEARNED_METHODS,
  learnedMethodDirectoryName,
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
    async approvedMethods(_userId, { projectId } = {}) {
      return documents.filter((document) => (projectId === null ? document.projectId === null : document.projectId === projectId));
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

test("project methods come before account-wide ones and nothing is listed twice", async () => {
  const shared = doc("method:learned:shared", "shared", { projectId: null });
  const learning = fakeLearning([doc("method:learned:local", "local"), shared]);
  const selected = await selectLearnedMethods(learning, { userId: "u1", projectId: "p1" });
  assert.deepEqual(selected.map((method) => method.id), ["method:learned:local", "method:learned:shared"],
    "same createdAt, so the tie breaks on id and the project scope was read first");
  assert.equal(new Set(selected.map((method) => method.id)).size, selected.length);
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
