// 2026-10-10 review M-1 / L-5: the memory page promises 「本项目不使用记忆」 and counts 做法 as part of 记忆, but
// the researcher's pause (`memoryPausedFor`) reached only the research-memory records. The resident capsule profile,
// the learned and capsule method cards a launch mounts, the capsule half of a recall and capsule notes ignored it.
// This file holds the runtime-manager half: what a launch mounts and what a dispatch writes into the workspace. The
// gateway half (recall and note) is in capsuleGateway.test.mjs.
//
// Semantics held here (see `memoryPausedFor`): `recall` paused = nothing is read into a run (profile, method cards,
// recall); `learning` paused = nothing is written (notes). A 「试用一次」 conversation is paused for both, for itself.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { workspaceLayout } from "@evimed/domain";
import { capsuleMethodsDirName } from "../src/capsuleMethods.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const USER = "u1";

/** A store's switches as `memoryPausedFor` composes them, from a plain description of what the researcher set. */
function pauseOf({ learning = false, recall = false, projects = [], trialSessions = [], unreadable = false } = {}) {
  const asked = [];
  const read = async (userId, projectId, sessionId) => {
    asked.push([userId, projectId, sessionId]);
    if (unreadable) throw Object.assign(new Error("settings store down"), { code: "product_state_unavailable" });
    const projectPaused = projects.includes(projectId);
    const trial = sessionId != null && trialSessions.includes(sessionId);
    return { learning: learning || projectPaused || trial, recall: recall || projectPaused || trial, trial };
  };
  return { read, asked };
}

async function projectFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "os-memory-pause-"));
  const workspaceDir = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  const project = { id: "p1", userId: USER, rootDir: root, runtimeDir, workspaceDir };
  return { root, project, profileFile: path.join(workspaceDir, workspaceLayout.capsuleProfileFile), methodsDir: path.join(runtimeDir, capsuleMethodsDirName) };
}

/** The researcher's own capsule in force for p1: one profile line and one approved work-style method. */
async function ownCapsule() {
  const capsules = new CapsuleService(/** @type {any} */ (productDocumentsDouble()));
  const own = await capsules.create(USER, { title: "我的记忆胶囊" });
  await capsules.addEntry(USER, own.id, { factKind: "profile", layer: "profile", content: "心内科临床药师" });
  await capsules.addEntry(USER, own.id, { factKind: "method_preference", layer: "methods", content: "先做敏感性分析再下结论" });
  await capsules.activate(USER, own.id, { mode: "own", projectId: "p1" });
  return capsules;
}

/** One approved learned method, in the shape the learning ledger serves. */
function learnedLibrary() {
  const document = {
    id: "method:learned:alpha",
    payload: {
      status: "approved", statusChangedAt: "2026-09-01T00:00:00.000Z",
      frontmatter: { name: "alpha", description: "Does alpha.", whenToUse: "When needed.", metadata: { role: "functional" } },
      body: "## Purpose\nDo it.\n\n## Workflow\n1. Do it.",
    },
  };
  const asked = [];
  return {
    asked,
    async approvedMethods() { asked.push("approvedMethods"); return [document]; },
    async methodTrial() { asked.push("methodTrial"); return { methodIds: [] }; },
  };
}

test("the resident profile is written empty while recall is paused for the account, the project or the conversation, and only then", async () => {
  const capsules = await ownCapsule();
  const f = await projectFixture();
  try {
    const manager = new RuntimeManager({ runtimeMode: "mock", dataDir: f.root });
    manager.capsuleService = capsules;
    const profileOn = async (/** @type {any} */ state, /** @type {any} */ options) => {
      manager.memoryPause = pauseOf(state).read;
      const result = await manager.syncCapsuleProfile(f.project, options);
      return { result, text: await readFile(f.profileFile, "utf8") };
    };

    const open = await profileOn({});
    assert.match(open.text, /- 身份：心内科临床药师/, "nothing paused: the profile is handed over, as it always was");

    // The account's recall pause. The stale block from the line above must go, not merely stop being refreshed.
    const account = await profileOn({ recall: true });
    assert.deepEqual(account.result, { written: true, chars: 0 });
    assert.equal(account.text, "", "a paused account's runs read no profile");

    assert.match((await profileOn({})).text, /心内科临床药师/, "and resuming brings it back");

    // 「本项目不使用记忆」: this project only.
    assert.equal((await profileOn({ projects: ["p1"] })).text, "");
    assert.match((await profileOn({ projects: ["another-project"] })).text, /心内科临床药师/, "pausing one project leaves the others alone");

    // A conversation trying someone else's capsule reads that pack alone: the dispatch names the conversation.
    assert.equal((await profileOn({ trialSessions: ["ses_trial"] }, { sessionId: "ses_trial" })).text, "");
    assert.match((await profileOn({ trialSessions: ["ses_trial"] }, { sessionId: "ses_plain" })).text, /心内科临床药师/,
      "an ordinary conversation of the same project is not a trial");

    // Pausing learning is not pausing recall: reading a profile writes nothing.
    assert.match((await profileOn({ learning: true })).text, /心内科临床药师/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a pause that cannot be read withholds the profile instead of leaving the last one in place", async () => {
  const capsules = await ownCapsule();
  const f = await projectFixture();
  try {
    const manager = new RuntimeManager({ runtimeMode: "mock", dataDir: f.root });
    manager.capsuleService = capsules;
    manager.memoryPause = pauseOf({}).read;
    await manager.syncCapsuleProfile(f.project);
    assert.match(await readFile(f.profileFile, "utf8"), /心内科临床药师/);
    manager.memoryPause = pauseOf({ unreadable: true }).read;
    // A researcher who asked for no memory is not given it because the switch could not be read; the failure is named.
    assert.deepEqual(await manager.syncCapsuleProfile(f.project), { written: true, chars: 0, error: "product_state_unavailable" });
    assert.equal(await readFile(f.profileFile, "utf8"), "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a deployment with no memory store has nothing to pause, and its profile is written as before", async () => {
  const capsules = await ownCapsule();
  const f = await projectFixture();
  try {
    const manager = new RuntimeManager({ runtimeMode: "mock", dataDir: f.root });
    manager.capsuleService = capsules;
    assert.equal(manager.memoryPause, null);
    assert.equal((await manager.syncCapsuleProfile(f.project)).written, true);
    assert.match(await readFile(f.profileFile, "utf8"), /心内科临床药师/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a dispatch names its conversation when it brings the profile up to date", async () => {
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 });
  const project = { userId: "owner", id: "project", workspaceDir: "/workspace" };
  manager.runtimes.set(manager.key(project), {});
  manager.assertInteractiveRuntimeAvailable = () => {};
  manager.assertPersonalSkillPromptGeneration = async () => {};
  manager.enforceProjectQuota = async () => {};
  manager.callKernel = async () => ({});
  const synced = [];
  manager.syncCapsuleProfile = async (_project, options) => { synced.push(options); return { written: false, chars: 0 }; };
  await manager.dispatchAdmittedPrompt(project, "ses_trial", { text: "hello", residentProfile: true });
  await manager.dispatchAdmittedPrompt(project, "ses_other", { text: "hello" });
  assert.deepEqual(synced, [{ sessionId: "ses_trial" }], "the profile is per dispatch and only where the dispatch asks for it");
});

test("a launch under a recall pause mounts no learned and no capsule method, and clears what an earlier launch left", async () => {
  const capsules = await ownCapsule();
  const learning = learnedLibrary();
  const f = await projectFixture();
  try {
    const manager = new RuntimeManager({ runtimeMode: "mock", dataDir: f.root });
    manager.capsuleService = capsules;
    manager.learningService = learning;

    manager.memoryPause = pauseOf({}).read;
    const open = await manager.syncCapsuleMethods(f.project);
    assert.equal(open.count, 2, "nothing paused: the researcher's own method and the learned one are mounted");
    assert.equal(existsSync(f.methodsDir), true);

    // The pause is read at the launch, for the project and for the account; the cards leave with it.
    for (const state of [{ recall: true }, { projects: ["p1"] }]) {
      learning.asked.length = 0;
      manager.memoryPause = pauseOf(state).read;
      const paused = await manager.syncCapsuleMethods(f.project);
      assert.equal(paused.count, 0, JSON.stringify(state));
      assert.deepEqual(paused.learned, []);
      assert.deepEqual(paused.capsule, []);
      assert.equal(existsSync(f.methodsDir), false, "the earlier launch's files are gone: a stale SKILL.md is a rule the researcher turned off");
      assert.deepEqual(learning.asked, [], "a paused account's library is not even read");
      // Reopened for the next arm of the loop.
      manager.memoryPause = pauseOf({}).read;
      assert.equal((await manager.syncCapsuleMethods(f.project)).count, 2);
    }

    // Learning paused alone stops what is written, not what is read.
    manager.memoryPause = pauseOf({ learning: true }).read;
    assert.equal((await manager.syncCapsuleMethods(f.project)).count, 2);

    // A switch that cannot be read refuses the launch by name: mounting nothing quietly is the failure the mount exists to end.
    manager.memoryPause = pauseOf({ unreadable: true }).read;
    await assert.rejects(manager.syncCapsuleMethods(f.project), { code: "product_state_unavailable" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the composition root gives the runtime manager the researcher's switches from the store it built", async () => {
  // Wired and unfed is how this class of defect hid before: a manager whose `memoryPause` is never assigned reads
  // "nothing paused" and looks exactly like a researcher who paused nothing.
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-memory-pause-app-"));
  const store = {
    configured: true,
    async status() { return { configured: true, connected: true, code: null, structured: true }; },
    async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: ["default"] }; },
    async sessionState(_userId, _projectId, sessionId) { return { trialCapsuleId: sessionId === "ses_trial" ? "pack-1" : null }; },
    async relevant() { return []; },
  };
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, memoryExtractionEnabled: false, researchMemory: store });
  try {
    await app.listen(0, "127.0.0.1");
    assert.equal(typeof app.runtimeManager.memoryPause, "function");
    assert.deepEqual(await app.runtimeManager.memoryPause("u1", "default", null), { learning: true, recall: true, trial: false });
    assert.deepEqual(await app.runtimeManager.memoryPause("u1", "other", null), { learning: false, recall: false, trial: false });
    assert.deepEqual(await app.runtimeManager.memoryPause("u1", "other", "ses_trial"), { learning: true, recall: true, trial: true });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// The pause is read at a launch, so a pause turned on under a runtime that is already up would otherwise wait for that
// runtime's next launch (up to its idle timeout) with the researcher's methods still in its prompt. The idle ones are let go.
test("turning a pause on lets go of the account's idle runtimes that carry methods, and of no other", async () => {
  const manager = new RuntimeManager({ runtimeMode: "mock" });
  const live = (/** @type {string} */ userId, /** @type {string} */ id, /** @type {number} */ mounted) => {
    const project = { userId, id };
    manager.runtimes.set(manager.key(project), { project, capsuleMethodsMounted: mounted });
  };
  live(USER, "p-paused", 2);
  live(USER, "p-open", 2);
  live(USER, "p-empty", 0);
  live(USER, "p-busy", 2);
  live("another-user", "p-paused", 2);
  manager.memoryPause = pauseOf({ projects: ["p-paused", "p-empty", "p-busy"] }).read;
  /** @type {string[]} */ const stopped = [];
  manager.idleVerdict = async (project) => (project.id === "p-busy" ? "working" : "idle");
  manager.stopIdleRuntime = async (project, options) => { stopped.push(`${project.userId}/${project.id}/${options?.event}`); return true; };

  assert.deepEqual(await manager.releasePausedMethodRuntimes(USER), ["p-paused"]);
  assert.deepEqual(stopped, [`${USER}/p-paused/memory_paused`],
    "not the project that is not paused, not one with nothing mounted, not one that is working, not another account's");

  // A switch that cannot be read, or a runtime that cannot be stopped, leaves that runtime to its idle timer.
  manager.memoryPause = pauseOf({ unreadable: true }).read;
  assert.deepEqual(await manager.releasePausedMethodRuntimes(USER), []);
  manager.memoryPause = null;
  assert.deepEqual(await manager.releasePausedMethodRuntimes(USER), [], "no store, nothing paused");
});
