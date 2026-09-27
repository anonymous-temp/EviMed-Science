/**
 * The integration key's subject accounts, without a database: the account id,
 * the header's shape, and the order an institution's doctors are deleted in.
 * `agentApiKeys.integration.test.mjs` holds the rows themselves.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { assertAgentSubject, deleteSubjectAccounts, subjectAccountId } from "../src/agentApiKeys.mjs";
import { safeId } from "../src/security.mjs";

test("a subject's account id is one per doctor per institution, and a store would accept it", () => {
  const id = subjectAccountId("hospital-a", "doc-7");
  assert.equal(id, subjectAccountId("hospital-a", "doc-7"), "the same doctor, the same account");
  assert.notEqual(id, subjectAccountId("hospital-b", "doc-7"), "the same HIS id elsewhere is someone else");
  assert.notEqual(id, subjectAccountId("hospital-a", "doc-8"));
  assert.equal(safeId(id, "user id"), id, "every path that validates an account id accepts it");
  assert.match(id, /^subj_[a-f0-9]{40}$/);
});

test("X-Subject is an opaque identifier: printable, bounded, and never a name", () => {
  for (const good of ["doc-7", "HIS:00012", "dept/ward-3", "a".repeat(128), "user@hospital"]) {
    assert.equal(assertAgentSubject(good), good);
  }
  assert.equal(assertAgentSubject("  doc-7 "), "doc-7", "surrounding space is not part of it");
  for (const bad of [undefined, "", "张医生", "doc 7", "a".repeat(129), "-doc", 7]) {
    assert.throws(() => assertAgentSubject(bad), (error) => error.code === "agent_subject_invalid", String(bad));
  }
});

test("an institution's doctors are deleted index first, with the account hooks, and nothing that is not a subject is touched", async () => {
  const steps = [];
  const accounts = new Map([
    ["subj_a", { id: "subj_a", authType: "subject" }],
    ["subj_b", { id: "subj_b", authType: "local" }],
  ]);
  const client = { query: async () => ({ rows: [] }) };
  const deleted = await deleteSubjectAccounts({
    apiKeys: {
      async subjectAccounts(ownerId) {
        steps.push(["list", ownerId]);
        return [{ userId: "subj_a", accountCreatedAt: "g1" }, { userId: "subj_b", accountCreatedAt: "g2" }, { userId: "subj_gone", accountCreatedAt: "g3" }];
      },
    },
    store: {
      async userById(id) { return accounts.get(id) ?? null; },
      async deleteUser(user, { beforeLock, beforeDelete }) {
        await beforeLock(user.id, client);
        await beforeDelete(user.id, client);
        steps.push(["deleteUser", user.id]);
      },
    },
    memorySubstrate: { async forgetUser(id) { steps.push(["forgetIndex", id]); } },
    memoryIndexing: {
      async lockAccountDeletion(id) { steps.push(["lockIndex", id]); },
      async prepareAccountDeletion(id, generation) { steps.push(["purgeIndex", id, generation]); },
    },
    capsuleTransfers: {
      async prepareAccountDeletion(id) { steps.push(["prepareCapsules", id]); },
      async finishAccountDeletion(id) { steps.push(["finishCapsules", id]); },
    },
  }, "hospital-a");
  assert.equal(deleted, 1);
  assert.deepEqual(steps, [
    ["list", "hospital-a"],
    ["forgetIndex", "subj_a"],
    ["lockIndex", "subj_a"],
    ["purgeIndex", "subj_a", "g1"],
    ["prepareCapsules", "subj_a"],
    ["deleteUser", "subj_a"],
    ["finishCapsules", "subj_a"],
  ]);
  assert.equal(await deleteSubjectAccounts({ apiKeys: null, store: null, memorySubstrate: null }, "x"), 0,
    "a deployment without durable keys has no subjects");
});
