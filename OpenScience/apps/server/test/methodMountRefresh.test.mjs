// A live runtime is given its methods again without a restart: for the conversation about to start in it, and when a method
// is approved or retired. What the runtime carried was fixed at its start, so a method learnt at noon waited for the next
// launch and a retired one stayed in every prompt until then (audit 2026-10-23, B defect 7).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { SELECTION_FILE, capsuleMethodsDirName } from "../src/capsuleMethods.mjs";
import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import { learnedMethodDirectoryName } from "../src/learnedMethodMount.mjs";
import { LearningMetrics } from "../src/learningMetrics.mjs";
import { createMethodSimilarity } from "../src/methodSimilarity.mjs";
import { RUNTIME_KERNEL_NAME, RuntimeManager } from "../src/runtimeManager.mjs";

const learned = (/** @type {string} */ name, /** @type {string} */ words) => ({
  id: `method:learned:${name}`,
  payload: {
    status: "approved", statusChangedAt: "2026-09-01T00:00:00.000Z",
    frontmatter: { name, description: words, whenToUse: words, metadata: { role: "functional", evimed_schema: METHOD_SKILL_SCHEMA } },
    body: "## Purpose\nDo it.\n\n## Workflow\n1. Do it.",
  },
});

async function fixture({ projectId = "paper1", documents = [], sandboxMode = "docker", kind = RUNTIME_KERNEL_NAME } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-method-refresh-"));
  const project = { id: projectId, userId: "alice", rootDir: root, runtimeDir: path.join(root, "runtime") };
  await mkdir(project.runtimeDir, { recursive: true });
  const learning = { documents, async approvedMethods() { return this.documents; } };
  const manager = new RuntimeManager({ mountedMethodPromptBytes: 32 * 1024 });
  manager.learningService = learning;
  manager.methodSimilarity = createMethodSimilarity();
  manager.learningMetrics = new LearningMetrics();
  const runtime = { kind, sandboxMode, project, capsuleMethodsMounted: 0, mountedMethodPromptBytes: 0, methodSessions: new Set() };
  manager.runtimes.set(manager.key(project), runtime);
  const directory = path.join(project.runtimeDir, capsuleMethodsDirName);
  return { root, project, learning, manager, runtime, directory,
    async mountedNames() { return existsSync(directory) ? (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : []; } };
}

test("a conversation's first message chooses what the running runtime carries, and a second message of it does not", async () => {
  const f = await fixture({ documents: [
    learned("grade-first", "Report GRADE certainty of evidence before effect sizes"),
    learned("slide-titles", "Write slide titles as full sentences stating the conclusion"),
  ] });
  try {
    const result = await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1", sessionId: "s1", query: "Report GRADE certainty of evidence before the effect sizes", scopeId: "conversation" });
    assert.deepEqual(result, { refreshed: 1, skipped: [] });
    const gradeDir = learnedMethodDirectoryName("method:learned:grade-first");
    const selection = JSON.parse(await readFile(path.join(f.directory, SELECTION_FILE), "utf8"));
    assert.deepEqual(selection.methods.find((entry) => entry.directory === gradeDir)?.reason, "similarity");
    assert.equal(f.runtime.capsuleMethodsMounted, 2);
    assert.equal(f.runtime.methodsVersion, selection.version);
    assert.equal(f.manager.lastMountedLearnedMethods.get(f.manager.key(f.project)).find((method) => method.name === "grade-first").reason, "similarity");
    // What the conversation was given is its receipt when the runtime left none: the answer line plans and delegates nothing.
    const given = f.manager.methodsGivenTo(f.project, "s1");
    assert.deepEqual(given.map((method) => [method.name, method.reason]).sort(), [["grade-first", "similarity"], ["slide-titles", "explore"]]);
    assert.match(given[0].digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(f.manager.methodsGivenTo(f.project, "another-session"), []);
    // The same conversation again is not prepared again, and a force does it.
    assert.deepEqual(await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1", sessionId: "s1", query: "and now something else" }), { refreshed: 0, skipped: ["session_prepared"] });
    assert.deepEqual(await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1", sessionId: "s1", query: "and now something else", force: true }), { refreshed: 1, skipped: [] });
    assert.equal(f.manager.methodMounts.refreshes, 2);
    // The metrics saw the reasons.
    const family = f.manager.learningMetrics.families().find((entry) => entry.name === "open_science_learning_mount_selected_total");
    assert.ok(family.series.find((entry) => entry.labels.reason === "similarity").value >= 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("an approved method reaches a runtime that was launched with none, and a retired one leaves it, without a restart", async () => {
  const f = await fixture();
  try {
    const inode = async () => (await stat(f.directory)).ino;
    // A launch with nothing to mount keeps the directory.
    await f.manager.syncCapsuleMethods(f.project);
    assert.deepEqual(await f.mountedNames(), []);
    const held = await inode();
    f.learning.documents = [learned("late-arrival", "A method learnt at noon")];
    assert.deepEqual(await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1" }), { refreshed: 1, skipped: [] });
    assert.deepEqual(await f.mountedNames(), [learnedMethodDirectoryName("method:learned:late-arrival")]);
    assert.equal(await inode(), held, "the directory a running container mounts is the one that was written");
    assert.equal(f.runtime.capsuleMethodsMounted, 1);
    f.learning.documents = [];
    await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1" });
    assert.deepEqual(await f.mountedNames(), []);
    assert.equal(f.runtime.capsuleMethodsMounted, 0);
    // With no project named, every live runtime of the account is refreshed; another account's is not.
    f.learning.documents = [learned("again", "Words")];
    const other = { id: "paper2", userId: "bob", rootDir: f.root, runtimeDir: path.join(f.root, "runtime-bob") };
    f.manager.runtimes.set(f.manager.key(other), { kind: RUNTIME_KERNEL_NAME, sandboxMode: "docker", project: other, methodSessions: new Set() });
    assert.deepEqual(await f.manager.refreshCapsuleMethods({ userId: "alice" }), { refreshed: 1, skipped: [] });
    assert.equal(existsSync(path.join(other.runtimeDir, capsuleMethodsDirName)), false, "another researcher's runtime is not touched");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a runtime that is not a container on this host, the platform's own project and a stopped runtime are left as they are, and nothing throws", async () => {
  const remote = await fixture({ sandboxMode: "agentbay", documents: [learned("m", "Words")] });
  const internal = await fixture({ projectId: LEARNING_PROJECT_ID, documents: [learned("m", "Words")] });
  const mock = await fixture({ kind: "mock", documents: [learned("m", "Words")] });
  try {
    assert.deepEqual(await remote.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1" }), { refreshed: 0, skipped: ["not_a_live_container"] });
    assert.deepEqual(await mock.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1" }), { refreshed: 0, skipped: ["not_a_live_container"] });
    assert.deepEqual(await internal.manager.refreshCapsuleMethods({ userId: "alice", projectId: LEARNING_PROJECT_ID }), { refreshed: 0, skipped: ["internal_project"] });
    for (const f of [remote, internal, mock]) assert.equal(existsSync(f.directory), false);
    // Nothing running at all.
    const none = new RuntimeManager({});
    assert.deepEqual(await none.refreshCapsuleMethods({ userId: "alice", projectId: "paper1" }), { refreshed: 0, skipped: [] });
    // A read that fails is counted and skipped, and the dispatch that asked goes on.
    const broken = await fixture();
    try {
      broken.learning.approvedMethods = async () => { throw Object.assign(new Error("ledger down"), { code: "product_state_unavailable" }); };
      assert.deepEqual(await broken.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1" }), { refreshed: 0, skipped: ["product_state_unavailable"] });
      assert.equal(broken.manager.methodMounts.refreshFailures, 1);
    } finally { await rm(broken.root, { recursive: true, force: true }); }
  } finally { for (const f of [remote, internal, mock]) await rm(f.root, { recursive: true, force: true }); }
});

test("two refreshes of one project run one after the other, never together", async () => {
  const f = await fixture({ documents: [learned("m", "Words")] });
  try {
    let running = 0;
    let overlapped = false;
    const original = f.manager.syncCapsuleMethods.bind(f.manager);
    f.manager.syncCapsuleMethods = async (/** @type {any} */ project, /** @type {any} */ options) => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 15));
      try { return await original(project, options); } finally { running -= 1; }
    };
    await Promise.all([1, 2, 3].map((index) => f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1", sessionId: `s${index}`, query: "words" })));
    assert.equal(overlapped, false);
    assert.equal(f.manager.methodMounts.refreshes, 3);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("the first prompt of a session refreshes the runtime before it is sent, and a steer or an empty prompt does not", async () => {
  const f = await fixture({ documents: [learned("grade-first", "Report GRADE certainty of evidence")] });
  try {
    const calls = [];
    f.manager.refreshCapsuleMethods = async (/** @type {any} */ input) => { calls.push(input); return { refreshed: 0, skipped: [] }; };
    f.manager.assertInteractiveRuntimeAvailable = () => {};
    f.manager.assertPersonalSkillPromptGeneration = async () => {};
    f.manager.writeRunBriefIndex = async () => {};
    f.manager.enforceProjectQuota = async () => {};
    f.manager.callKernel = async () => ({});
    f.manager.beginProxy = () => {};
    f.manager.endProxy = () => {};
    f.manager.withRuntimeDeadline = async (/** @type {any} */ run) => run(new AbortController().signal);
    await f.manager.dispatchAdmittedPrompt(f.project, "s1", { text: "Report GRADE certainty first", routedCapability: "meta-analysis", runId: null });
    await f.manager.dispatchAdmittedPrompt(f.project, "s1", { text: "Report GRADE certainty first", routedCapability: null });
    await f.manager.dispatchAdmittedPrompt(f.project, "s1", { text: "a steer", mode: "steer" });
    await f.manager.dispatchAdmittedPrompt(f.project, "s1", { text: "   " });
    assert.deepEqual(calls.map((call) => [call.sessionId, call.query, call.scopeId]), [
      ["s1", "Report GRADE certainty first", "meta-analysis"],
      ["s1", "Report GRADE certainty first", "conversation"],
    ], "a routed run is of its capability's scope, an unrouted one of the conversation's");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("what a runtime was given stays readable while it is approved, so a conversation that began earlier keeps its files", async () => {
  const f = await fixture({ documents: [
    learned("grade-first", "Report GRADE certainty of evidence before effect sizes"),
    learned("slide-titles", "Write slide titles as full sentences stating the conclusion"),
    learned("kayak-notes", "Kayak river rafting weekend notes"),
  ] });
  try {
    const dir = (/** @type {string} */ name) => learnedMethodDirectoryName(`method:learned:${name}`);
    const listed = async () => JSON.parse(await readFile(path.join(f.directory, SELECTION_FILE), "utf8")).methods.map((/** @type {any} */ entry) => entry.directory);
    // One conversation begins about GRADE: it is shown grade-first, and one card of exposure.
    await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1", sessionId: "s1", scopeId: "conversation", query: "Report GRADE certainty of evidence before effect sizes" });
    const first = await listed();
    assert.deepEqual(first, [dir("grade-first"), dir("kayak-notes")]);
    // Another begins about slides: what a new conversation is listed moves, and nothing the first was shown is taken from it.
    await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1", sessionId: "s2", scopeId: "conversation", query: "Write slide titles as full sentences stating the conclusion" });
    const second = await listed();
    assert.ok(second.includes(dir("slide-titles")) && !second.includes(dir("kayak-notes")), "the new conversation is shown the new selection");
    for (const name of first) assert.ok(existsSync(path.join(f.directory, name, "SKILL.md")), `${name} is still readable by the conversation that was shown it`);
    assert.deepEqual((await f.mountedNames()).sort(), [dir("grade-first"), dir("kayak-notes"), dir("slide-titles")].sort());
    assert.equal(f.runtime.capsuleMethodsMounted, second.length, "the count is the selection, not what is kept");
    // The method the first was shown is retired: that file goes at once, whatever conversation holds its card.
    f.learning.documents = f.learning.documents.filter((document) => document.id !== "method:learned:kayak-notes");
    await f.manager.refreshCapsuleMethods({ userId: "alice", projectId: "paper1" });
    assert.equal(existsSync(path.join(f.directory, dir("kayak-notes"))), false, "a rule the researcher removed is not kept for anyone");
    assert.ok(existsSync(path.join(f.directory, dir("grade-first"))));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
