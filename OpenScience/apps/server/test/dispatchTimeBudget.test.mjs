// A dispatch may state a wall-clock budget for its turn (`timeBudgetMinutes`), and the runtime tells the model the clock.
//
// What the control plane owns is small and exact: the request field is validated (a whole number of minutes, 1 to 1440, refused for that
// request otherwise), it reaches the runtime manager's dispatch, and the session's index states it — and states nothing when no budget was
// asked for, so an index is what it always was. The words the model reads and the moments it reads them are the run policy's
// (`packages/socket/test/consistency.test.mjs`).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RUN_CONTEXT_PROTOCOL, RUN_TIME_BUDGET_MINUTES } from "@evimed/domain";
import { runContextAuthorityPublicKey, verifyRunContextAuthority } from "@evimed/harness-port/run-context-authority";

import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { noProfile } from "./helpers/residentProfileDouble.mjs";

const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };

/** @param {(context: { base: string, prompts: any[] }) => Promise<void>} fn */
async function withApp(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-time-budget-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: true,
    memorySettings: {
      configured: false,
      async status() { return { configured: false, connected: false, code: null }; },
      async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
      async sessionState() { return { trialCapsuleId: null }; },
    },
  });
  /** @type {any[]} */ const prompts = [];
  try {
    const address = await app.listen(0, "127.0.0.1");
    app.residentProfiles.forDispatch = noProfile;
    app.runtimeManager.dispatchPrompt = async (/** @type {any} */ _project, /** @type {string} */ sessionId, /** @type {any} */ request) => {
      prompts.push({ sessionId, ...request });
      return { accepted: true };
    };
    await fn({ base: `http://127.0.0.1:${address.port}`, prompts });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** @param {string} base @param {string} sessionId @param {Record<string, any>} [extra] */
async function dispatch(base, sessionId, extra = {}) {
  const bound = await fetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) });
  assert.equal(bound.status, 200);
  const response = await fetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST", headers,
    body: JSON.stringify({ sessionId, dispatchId: `turn_${sessionId}`, text: "write the report", ...extra }),
  });
  return { response, body: await response.json() };
}

test("a dispatch's timeBudgetMinutes reaches the runtime manager's dispatch, and one that states none sends none", async () => {
  await withApp(async ({ base, prompts }) => {
    const budgeted = await dispatch(base, "ses_budgeted", { automated: true, timeBudgetMinutes: 60 });
    assert.equal(budgeted.response.status, 202, JSON.stringify(budgeted.body));
    assert.equal(prompts.length, 1, "the dispatch reached the runtime manager");
    assert.equal(prompts[0].timeBudgetMinutes, 60);

    const plain = await dispatch(base, "ses_plain");
    assert.equal(plain.response.status, 202, JSON.stringify(plain.body));
    assert.equal("timeBudgetMinutes" in prompts[1], false, "a dispatch that asked for no budget sends no field at all");

    const nulled = await dispatch(base, "ses_null", { timeBudgetMinutes: null });
    assert.equal(nulled.response.status, 202, JSON.stringify(nulled.body));
    assert.equal("timeBudgetMinutes" in prompts[2], false, "null is no budget, as it is for `automated`");

    const ends = await dispatch(base, "ses_ends", { timeBudgetMinutes: RUN_TIME_BUDGET_MINUTES.max });
    assert.equal(ends.response.status, 202);
    assert.equal(prompts[3].timeBudgetMinutes, 1440);
    const first = await dispatch(base, "ses_first", { timeBudgetMinutes: RUN_TIME_BUDGET_MINUTES.min });
    assert.equal(first.response.status, 202);
    assert.equal(prompts[4].timeBudgetMinutes, 1);
  });
});

test("a timeBudgetMinutes that is not a whole number of minutes from 1 to 1440 is refused for that request, before anything runs", async () => {
  await withApp(async ({ base, prompts }) => {
    for (const bad of [0, -5, 1441, 60.5, "60", true, [60], {}, Number.MAX_SAFE_INTEGER + 2]) {
      const refused = await dispatch(base, "ses_refused", { timeBudgetMinutes: bad });
      assert.equal(refused.response.status, 400, `${JSON.stringify(bad)} is refused`);
      assert.equal(refused.body.code, "invalid_agent_run");
      assert.match(refused.body.error, /timeBudgetMinutes must be a whole number of minutes from 1 to 1440/);
    }
    assert.deepEqual(prompts, [], "nothing was sent to a runtime for any of them");
    // The refusal is that request's: the same session dispatches again with a valid budget.
    const retried = await dispatch(base, "ses_refused", { timeBudgetMinutes: 30 });
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    assert.equal(prompts[0].timeBudgetMinutes, 30);
  });
});

test("the deployment's default is a lever with a range, and off", () => {
  assert.equal(loadConfig({ rootDir: path.resolve(import.meta.dirname, "..", "..", "..") }).runTimeBudgetMinutes, 0, "no budget unless one is asked for");
  const config = (/** @type {string} */ value) => {
    const saved = process.env.OPEN_SCIENCE_RUN_TIME_BUDGET_MINUTES;
    process.env.OPEN_SCIENCE_RUN_TIME_BUDGET_MINUTES = value;
    try { return loadConfig({ rootDir: path.resolve(import.meta.dirname, "..", "..", "..") }).runTimeBudgetMinutes; }
    finally { if (saved === undefined) delete process.env.OPEN_SCIENCE_RUN_TIME_BUDGET_MINUTES; else process.env.OPEN_SCIENCE_RUN_TIME_BUDGET_MINUTES = saved; }
  };
  assert.equal(config("45"), 45);
  assert.equal(config(""), 0, "the value-less compose form passes an empty value through as the default");
  for (const bad of ["-1", "1441", "1.5", "abc"]) assert.throws(() => config(bad), /OPEN_SCIENCE_RUN_TIME_BUDGET_MINUTES must be a whole number from 0 to 1440/);
});

/** The index a dispatch wrote, as a manager over a throwaway workspace writes it. */
async function indexWritten(/** @type {Record<string, any>} */ config, /** @type {Record<string, any>} */ options) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "os-time-budget-index-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const project = { id: "project-test", userId: "owner", workspaceDir, baseDir: rootDir };
  await mkdir(workspaceDir, { recursive: true });
  const manager = Object.create(RuntimeManager.prototype);
  manager.config = { modelGatewaySigningSecret: "only-the-control-plane-knows-this-fixture-secret", ...config };
  manager.mirrorWorkspaceWrite = async () => {};
  try {
    const sessionId = "ses_index";
    const result = await manager.writeRunBriefIndex(project, "run_1", { sessionId, required: true, contextRevision: "req_1", ...options });
    const index = JSON.parse(await readFile(path.join(workspaceDir, ".evimed-brief", "sessions", sessionId, "index.json"), "utf8"));
    const publicKey = runContextAuthorityPublicKey(manager.config.modelGatewaySigningSecret);
    return { index, result, claims: verifyRunContextAuthority(index, { publicKey, userId: project.userId, projectId: project.id, sessionId }) };
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("the session's index states a dispatch's budget; with none it is the index it always was, and it still verifies", async () => {
  const stated = await indexWritten({}, { unattended: false, timeBudgetMinutes: 90 });
  assert.equal(stated.index.timeBudgetMinutes, 90);
  assert.equal(stated.index.protocol, RUN_CONTEXT_PROTOCOL, "an additive field: the hand-off revision does not move");
  assert.equal(stated.claims?.unattended, false, "the budget is no part of the signed claims: the signature verifies and still says who attends");

  const none = await indexWritten({}, { unattended: false });
  assert.equal("timeBudgetMinutes" in none.index, false);
  assert.deepEqual(Object.keys(none.index).sort(), ["attendanceAuthority", "contextRevision", "protocol", "runId", "sessionId"]);
  assert.equal(none.claims?.unattended, false);
});

test("the deployment's default reaches a dispatch nobody attends and that states none; an explicit budget, a person's turn and a steer are not given it", async () => {
  const config = { runTimeBudgetMinutes: 45 };
  assert.equal((await indexWritten(config, { unattended: true })).index.timeBudgetMinutes, 45, "an automated or scheduled dispatch");
  assert.equal((await indexWritten(config, {})).index.timeBudgetMinutes, 45, "a dispatch that does not say who attends is treated as unattended, and so is given it");
  assert.equal((await indexWritten(config, { unattended: true, timeBudgetMinutes: 20 })).index.timeBudgetMinutes, 20, "what the dispatch asked for wins");
  assert.equal("timeBudgetMinutes" in (await indexWritten(config, { unattended: false })).index, false, "a person's ordinary turn with no stated budget gets nothing");
  assert.equal((await indexWritten(config, { unattended: false, timeBudgetMinutes: 20 })).index.timeBudgetMinutes, 20, "a person may ask for one");
  assert.equal("timeBudgetMinutes" in (await indexWritten(config, { unattended: true, timeBudgetMinutes: 0 })).index, false, "0 says none outright, as a steer does");
  // Not a number of minutes in range: no budget, never a refusal of the write (the route has refused the request already).
  for (const bad of [-1, 1441, 1.5, "60", null, Number.NaN]) {
    assert.equal("timeBudgetMinutes" in (await indexWritten({}, { unattended: false, timeBudgetMinutes: /** @type {any} */ (bad) })).index, false, `${String(bad)} states no budget`);
  }
  assert.equal("timeBudgetMinutes" in (await indexWritten({ runTimeBudgetMinutes: 1441 }, { unattended: true })).index, false, "a default outside the range states none");
});

test("through a real dispatch, the index carries the budget the dispatch asked for, a deployment default for an unattended one, and nothing for a steer", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "os-time-budget-dispatch-"));
  const project = {
    id: "paper-budget", userId: "alice", rootDir,
    metaDir: path.join(rootDir, ".openscience"), workspaceDir: path.join(rootDir, "workspace"), runtimeDir: path.join(rootDir, "runtime"),
  };
  await mkdir(project.workspaceDir, { recursive: true, mode: 0o700 });
  const manager = new RuntimeManager({ runtimeMode: "mock", allowMockRuntime: true, production: false, runTimeBudgetMinutes: 45,
    modelGatewaySigningSecret: "only-the-control-plane-knows-this-fixture-secret" });
  t.after(async () => { await manager.closeAll(); await rm(rootDir, { recursive: true, force: true }); });
  await manager.start(project);
  const index = async (/** @type {string} */ sessionId) => JSON.parse(await readFile(path.join(project.workspaceDir, ".evimed-brief", "sessions", sessionId, "index.json"), "utf8"));

  // A scheduled or automated dispatch that asked for nothing is given the deployment's.
  await manager.dispatchPrompt(project, "ses_scheduled", { text: "weekly", runId: "run_scheduled", requestId: "req_1", strictContext: true, unattended: true });
  assert.equal((await index("ses_scheduled")).timeBudgetMinutes, 45);
  // Its steer continues the turn the runtime already has the clock of: no field, so the schedule is neither restarted nor replaced.
  await manager.dispatchPrompt(project, "ses_scheduled", { text: "<evimed-correction>x</evimed-correction>", runId: "run_scheduled", requestId: "req_2", mode: "steer", strictContext: true, unattended: true });
  const steered = await index("ses_scheduled");
  assert.equal("timeBudgetMinutes" in steered, false);
  assert.equal(steered.unattended, true, "and it is still the run nobody attends");
  // What a dispatch asks for is what its index says, attended or not.
  await manager.dispatchPrompt(project, "ses_asked", { text: "q", runId: "run_asked", requestId: "req_3", strictContext: true, unattended: false, timeBudgetMinutes: 120 });
  assert.equal((await index("ses_asked")).timeBudgetMinutes, 120);
  // A person's ordinary turn gets nothing from the deployment.
  await manager.dispatchPrompt(project, "ses_person", { text: "q", runId: "run_person", requestId: "req_4", strictContext: true, unattended: false });
  assert.equal("timeBudgetMinutes" in await index("ses_person"), false);
});
