// The platform's tier in the mount: official methods are offered below everything of the person's own, chosen by the question, and left out
// where a method of the person's says the same thing — and nothing is left out on a guess.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeCapsuleMethods, runtimeCapsuleMethodsDir, SELECTION_FILE } from "../src/capsuleMethods.mjs";
import {
  OFFICIAL_METHOD_MOUNT, OFFICIAL_PERSONAL_DELTA_COSINE, officialMethodDirectoryName, officialMethodDocument, selectOfficialMethods,
} from "../src/learnedMethodMount.mjs";

/** @param {string} key @param {Partial<Record<string, any>>} [over] */
function method(key, over = {}) {
  const methodId = key.split(":")[2];
  return { key, packId: key.split(":")[1], methodId, name: `official-${key.split(":")[1]}-${methodId}`, description: `${methodId} 的做法`, whenToUse: `做${methodId}的时候`,
    scope: ["conversation"], body: `${methodId}：没给的留空。`, sha: `${methodId}`.padEnd(64, "0"), entryId: `fact-${methodId}`, capsuleId: "official-copy:daily", ...over };
}

/** A similarity module with the answers written down: the nearest are the first of the list, and the pairs are the scores given. */
function similarityWith({ mode = "embedding", scores = {}, fail = false } = {}) {
  /** @template T @param {T[]} list @param {string} m */
  const withMode = (list, m) => { Object.defineProperty(list, "mode", { value: m, enumerable: false }); return list; };
  return {
    nearest: async (/** @type {string} */ _query, /** @type {any[]} */ docs, { limit = 8 } = {}) => withMode(docs.slice(0, limit).map((doc) => ({ method: doc, score: 0.9 })), mode),
    pairs: async (/** @type {any[]} */ docs, { floor = 0 } = {}) => {
      if (fail) throw new Error("embedding unavailable");
      const found = [];
      for (let left = 0; left < docs.length; left += 1) for (let right = left + 1; right < docs.length; right += 1) {
        const score = scores[`${docs[left].id}|${docs[right].id}`] ?? scores[`${docs[right].id}|${docs[left].id}`];
        if (score !== undefined && score >= floor) found.push({ a: docs[left].id, b: docs[right].id, score, overlap: score });
      }
      return withMode(found, mode);
    },
  };
}
/** @param {string} id @param {string} name */
const personalDoc = (id, name) => ({ id, payload: { frontmatter: { name, description: `${name} 的说明` }, contentDigest: `sha256:${id}`.padEnd(71, "0") } });

const ASK = "帮我写这周的周报";
const methods = [method("official:daily:weekly"), method("official:daily:mail"), method("official:daily:minutes"), method("official:daily:extra")];

test("without a question, or in a runtime that is not for research, nothing is offered", async () => {
  const similarity = similarityWith();
  assert.equal((await selectOfficialMethods(methods, { query: "", similarity })).length, 0);
  assert.equal((await selectOfficialMethods(methods, { query: ASK, similarity: null })).length, 0);
  assert.equal((await selectOfficialMethods(methods, { query: ASK, similarity, family: "geo" })).length, 0);
  assert.equal((await selectOfficialMethods(methods, { query: ASK, similarity, family: null })).length, 0);
});

test("the nearest few of the run's scope are offered as cards below the person's own, and a method of another scope never is", async () => {
  const picked = await selectOfficialMethods([...methods, method("official:review:pooling", { scope: ["meta-analysis"] })], {
    query: ASK, similarity: similarityWith(), scopeId: null, cardDirectory: runtimeCapsuleMethodsDir, maxBytes: 100_000 });
  assert.equal(picked.length, OFFICIAL_METHOD_MOUNT.nearest);
  assert.ok(picked.every((entry) => entry.official === true && entry.reason === "similarity" && entry.directoryName === officialMethodDirectoryName(entry.id)));
  assert.ok(picked.every((entry) => /^_om[0-9a-f]{32}$/.test(entry.directoryName)));
  const inCapability = await selectOfficialMethods([method("official:review:pooling", { scope: ["conversation", "meta-analysis"] }), method("official:review:only", { scope: ["meta-analysis"] })], {
    query: ASK, similarity: similarityWith(), scopeId: "meta-analysis", cardDirectory: runtimeCapsuleMethodsDir });
  assert.deepEqual(inCapability.map((entry) => entry.id).sort(), ["official:review:only", "official:review:pooling"]);
  const inConversation = await selectOfficialMethods([method("official:review:only", { scope: ["meta-analysis"] })], { query: ASK, similarity: similarityWith(), scopeId: null });
  assert.equal(inConversation.length, 0, "a capability's method is not offered to the plain conversation");
});

test("a method of the person's about the same thing wins, the receipt says which and how near, and nothing else is left out", async () => {
  const mine = personalDoc("method:learned:weekly-habit", "我的周报写法");
  const near = OFFICIAL_PERSONAL_DELTA_COSINE + 0.05;
  const picked = await selectOfficialMethods(methods, { query: ASK, personal: [mine], cardDirectory: runtimeCapsuleMethodsDir,
    similarity: similarityWith({ scores: { "official:daily:weekly|method:learned:weekly-habit": near, "official:daily:mail|method:learned:weekly-habit": OFFICIAL_PERSONAL_DELTA_COSINE - 0.1 } }) });
  assert.deepEqual(picked.map((entry) => entry.id).sort(), ["official:daily:mail", "official:daily:minutes"]);
  assert.deepEqual(picked.leftOut, [{ id: "official:daily:weekly", name: "official-daily-weekly", reason: "personal_method",
    twin: { id: "method:learned:weekly-habit", name: "我的周报写法" }, score: near }]);
  assert.equal(picked.deltaMode, "embedding");
});

test("two official methods near each other are not a delta: only the person's own is read against", async () => {
  const picked = await selectOfficialMethods(methods, { query: ASK, personal: [personalDoc("mine", "无关")], cardDirectory: runtimeCapsuleMethodsDir,
    similarity: similarityWith({ scores: { "official:daily:weekly|official:daily:mail": 0.99 } }) });
  assert.equal(picked.leftOut.length, 0);
  assert.equal(picked.length, 3);
});

test("with no embedder, or one that fails, the delta is not decided and both stay", async () => {
  const mine = personalDoc("mine", "我的周报写法");
  const scores = { "official:daily:weekly|mine": 0.99 };
  const lexical = await selectOfficialMethods(methods, { query: ASK, personal: [mine], similarity: similarityWith({ mode: "lexical", scores }) });
  assert.equal(lexical.length, 3);
  assert.equal(lexical.leftOut.length, 0);
  assert.equal(lexical.deltaMode, "lexical");
  const failing = await selectOfficialMethods(methods, { query: ASK, personal: [mine], similarity: similarityWith({ fail: true, scores }) });
  assert.equal(failing.length, 3, "a nearness that cannot be read withholds nothing");
  assert.equal(failing.deltaMode, "lexical");
});

test("the byte budget is spent on cards, and what does not fit is counted as left out", async () => {
  const one = (await selectOfficialMethods([methods[0]], { query: ASK, similarity: similarityWith(), cardDirectory: runtimeCapsuleMethodsDir }))[0];
  const left = [];
  const picked = await selectOfficialMethods(methods, { query: ASK, similarity: similarityWith(), cardDirectory: runtimeCapsuleMethodsDir, maxBytes: one.promptBytes * 2 + 1, onLeftOut: (id) => left.push(id) });
  assert.equal(picked.length, 2);
  assert.equal(left.length, 1);
  const none = await selectOfficialMethods(methods, { query: ASK, similarity: similarityWith(), cardDirectory: runtimeCapsuleMethodsDir, maxBytes: -1 });
  assert.equal(none.length, 0);
});

test("a conversation that began earlier can still read the file its card named: what a runtime was given and is still in force is kept", async () => {
  const served = officialMethodDirectoryName("official:daily:minutes");
  const picked = await selectOfficialMethods(methods, { query: ASK, similarity: similarityWith(), keep: [served, "_omnothing"], maxCount: 1 });
  assert.equal(picked.length, 1);
  assert.deepEqual(picked.kept.map((entry) => entry.directoryName), picked[0].directoryName === served ? [] : [served]);
  const nothingAsked = await selectOfficialMethods(methods, { query: "", similarity: similarityWith(), keep: [served] });
  assert.deepEqual(nothingAsked.kept.map((entry) => entry.id), ["official:daily:minutes"], "even when this selection holds none");
});

test("the mounted file is the method's own frontmatter and body, and its digest is the one the receipts compute", () => {
  const { document, digest } = officialMethodDocument(methods[0]);
  assert.match(document, /^---\nname: "official-daily-weekly"\ndescription: "weekly 的做法"\nwhenToUse: "做weekly的时候"\n---\n\nweekly：没给的留空。\n$/);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
});

// ------------------------------------------------------------------------------------------------ the whole mount, on disk

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-official-mount-"));
  const project = { id: "paper1", userId: "alice", rootDir: root, runtimeDir: path.join(root, "runtime") };
  await mkdir(project.runtimeDir, { recursive: true });
  return { project, directory: path.join(project.runtimeDir, "capsule-methods"), root };
}
const noCapsules = (/** @type {any[]} */ official) => ({
  async active() { return { record: null, items: [] }; },
  async entries() { return { items: [], nextCursor: null }; },
  async officialMethods() { return official; },
  official: { noted: /** @type {string[]} */ ([]), noteMount(/** @type {string} */ what, /** @type {number} */ count) { this.noted.push(`${what}:${count}`); } },
});

test("official methods are written as read-only cards beside the selection, and the selection says the person's method kept one out", async () => {
  const { project, directory, root } = await scratch();
  try {
    const capsules = noCapsules(methods);
    const learned = personalDoc("method:learned:weekly-habit", "我的周报写法");
    const learning = { async approvedMethods() { return [{ id: learned.id, payload: { ...learned.payload, status: "approved", frontmatter: { name: "my-weekly", description: "我的周报写法", whenToUse: "写周报" },
      body: "我的做法。", provenance: { scope: "conversation" }, statusChangedAt: "2026-10-01T00:00:00Z" } }]; } };
    const similarity = {
      nearest: async (/** @type {string} */ _q, /** @type {any[]} */ docs, { limit = 8 } = {}) => { const list = docs.slice(0, limit).map((doc) => ({ method: doc, score: 0.9 })); Object.defineProperty(list, "mode", { value: "embedding" }); return list; },
      pairs: async (/** @type {any[]} */ docs) => { const list = docs.some((doc) => doc.id === "official:daily:weekly") && docs.some((doc) => doc.id === learned.id) ? [{ a: "official:daily:weekly", b: learned.id, score: 0.9, overlap: 0.9 }] : []; Object.defineProperty(list, "mode", { value: "embedding" }); return list; },
    };
    const result = await materializeCapsuleMethods({ capsules, learning, project, directory, query: ASK, scopeId: undefined, similarity, learnedFamily: "research", keepDirectory: true, maxPromptBytes: 32 * 1024 });
    // The nearest three were weekly, mail and minutes; the person's own method took weekly's place and nothing backfilled it.
    assert.equal(result.official.length, 2);
    assert.equal(result.officialLeftOut.length, 1);
    assert.equal(result.officialLeftOut[0].twin.id, learned.id);
    const dirs = (await readdir(directory)).filter((name) => name.startsWith("_om")).sort();
    assert.equal(dirs.length, 2);
    const file = await readFile(path.join(directory, dirs[0], "SKILL.md"), "utf8");
    assert.match(file, /^---\nname: "official-daily-/);
    const selection = JSON.parse(await readFile(path.join(directory, SELECTION_FILE), "utf8"));
    assert.equal(selection.methods.filter((entry) => entry.directory.startsWith("_om")).length, 2);
    assert.ok(selection.methods.every((entry) => entry.reason !== null || !entry.directory.startsWith("_om")));
    assert.equal(selection.leftOut[0].reason, "personal_method");
    assert.deepEqual(capsules.official.noted, ["offered:2", "leftOutPersonal:1"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a deployment with no official packs mounts exactly what it always did", async () => {
  const { project, directory, root } = await scratch();
  try {
    const capsules = { async active() { return { record: null, items: [] }; }, async entries() { return { items: [], nextCursor: null }; } };
    const result = await materializeCapsuleMethods({ capsules, project, directory, query: ASK, similarity: similarityWith() });
    assert.equal(result.count, 0);
    assert.deepEqual(result.official, []);
    assert.equal(existsSync(directory), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
