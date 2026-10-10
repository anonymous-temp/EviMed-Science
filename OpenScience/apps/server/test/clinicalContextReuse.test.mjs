// Whether a finished run's work may be copied into account-wide memory, methods or the evaluation corpus is the VCR store's
// word (a conversation that read a clinical projection may not be), asked for one run when the run finishes and for every run
// of an account's projects when a routine is counted (2026-10-10 review D7). The second used to be one statement per selected
// run, all at once, for every project of the account.
import assert from "node:assert/strict";
import test from "node:test";

import { createClinicalReuse } from "../src/clinicalContextReuse.mjs";

/** A store that holds clinical context for the conversations it is told of, and counts the questions it is asked. */
function fakeStore(heldSessions = [], heldRuns = []) {
  const questions = [];
  const held = (/** @type {{ sessionId?: string, runId?: string }} */ context) => Boolean(
    (context.sessionId && heldSessions.includes(context.sessionId)) || (context.runId && heldRuns.includes(context.runId)));
  return {
    questions,
    async hasClinicalContext(/** @type {string} */ userId, /** @type {string} */ projectId, /** @type {any[]} */ contexts) {
      questions.push({ kind: "one", userId, projectId, contexts });
      return contexts.some(held);
    },
    async clinicalContextsHeld(/** @type {string} */ userId, /** @type {string} */ projectId, /** @type {any[]} */ contexts) {
      questions.push({ kind: "many", userId, projectId, contexts });
      return contexts.map(held);
    },
  };
}

const project = { id: "p1", userId: "u1" };
const runs = [
  { id: "run_a", sessionId: "ses_a" },
  { id: "run_b", sessionId: "ses_b" },
  { id: "run_c", sessionId: "ses_c" },
];

test("a project's runs are asked about in one question, and the answers agree with asking about each run", async () => {
  const store = fakeStore(["ses_b"], []);
  const { canReuseRun, canReuseRuns } = createClinicalReuse({ store });
  assert.deepEqual(await canReuseRuns(project, runs), [true, false, true]);
  assert.equal(store.questions.length, 1, "one statement for the whole list");
  assert.deepEqual(store.questions[0].contexts, [
    { sessionId: "ses_a", runId: "run_a" }, { sessionId: "ses_b", runId: "run_b" }, { sessionId: "ses_c", runId: "run_c" },
  ]);
  for (const [index, run] of runs.entries()) {
    assert.equal(await canReuseRun(project, run), (await canReuseRuns(project, runs))[index], `${run.id}: one at a time or all together`);
  }
  assert.deepEqual(await canReuseRuns(project, []), [], "nothing to ask about");
  assert.equal(store.questions.filter((question) => question.contexts.length === 0).length, 0, "and nothing is asked");
});

test("a deployment with no VCR store lets every run be reused, and a store that fails fails the question", async () => {
  const { canReuseRun, canReuseRuns } = createClinicalReuse({ store: null });
  assert.equal(await canReuseRun(project, runs[0]), true);
  assert.deepEqual(await canReuseRuns(project, runs), [true, true, true]);
  const broken = { async hasClinicalContext() { throw new Error("down"); }, async clinicalContextsHeld() { throw new Error("down"); } };
  const failing = createClinicalReuse({ store: broken });
  await assert.rejects(failing.canReuseRun(project, runs[0]), /down/, "the caller decides what a failed question means");
  await assert.rejects(failing.canReuseRuns(project, runs), /down/);
});
