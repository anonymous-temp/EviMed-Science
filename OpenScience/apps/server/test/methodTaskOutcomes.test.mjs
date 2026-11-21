import assert from "node:assert/strict";
import test from "node:test";
import { methodTaskOutcomes, taskOutcomeWindow } from "../src/methodTaskOutcomes.mjs";
import { selectLearnedMethods } from "../src/learnedMethodMount.mjs";

const method = { id: "m", name: "mine", digest: "mounted", contentDigest: "body" };
const run = { id: "r", startedAt: "2026-11-01T00:00Z", finishedAt: "2026-11-01T01:00Z",
  status: "failed", errorCode: "specialist_required_output_missing" };
const observed = { answered: true, methodsLoaded: [method], methodsInvoked: [] };

test("sole card exposure can matter without a body read, ambiguous exposures remain in the run ledger only", () => {
  assert.equal(methodTaskOutcomes(run, observed, [method])[0].sample.opened, false);
  const several = { ...observed, methodsLoaded: [method, { name: "other" }] };
  assert.deepEqual(methodTaskOutcomes(run, several, [method]), []);
  assert.equal(methodTaskOutcomes(run, { ...several, methodsInvoked: [method] }, [method])[0].sample.opened, true);
  for (const patch of [{ automated: true }, { errorCode: "runtime_stopped" }, { status: "canceled" }, { terminalConflict: true },
    { status: "succeeded", verification: "unverified" }]) assert.deepEqual(methodTaskOutcomes({ ...run, ...patch }, observed, [method]), []);
  assert.deepEqual(methodTaskOutcomes(run, observed, [{ ...method, digest: "amended" }]), []);
  assert.deepEqual(methodTaskOutcomes(run, observed, [{ ...method, id: "official:p:m" }]), []);
  const success = methodTaskOutcomes({ ...run, status: "succeeded" }, observed, [method])[0].sample;
  const failures = [1, 2, 3].map(n => ({ runId: String(n), at: run.startedAt, failed: true }));
  assert.equal(taskOutcomeWindow({ contentDigest: "body", taskOutcomes: { digest: "body", samples: failures } }, success, 3).demoted, false);
});

test("probation frees a similarity slot and keeps the method eligible for exploration", async () => {
  const documents = ["bad", "good"].map(id => ({ id, payload: { frontmatter: { name: id }, body: id, contentDigest: id,
    taskOutcomes: { digest: id, demoted: id === "bad" } } }));
  const scope = { userId: "u", projectId: "p", query: "task", taskOutcomes: true,
    similarity: { nearest: async (_query, docs) => docs.map(method => ({ method, score: 1 })) } };
  const cards = await selectLearnedMethods({ approvedMethods: async () => documents }, scope);
  assert.deepEqual(cards.map(card => [card.name, card.reason]), [["good", "similarity"], ["bad", "explore"]]);
});
