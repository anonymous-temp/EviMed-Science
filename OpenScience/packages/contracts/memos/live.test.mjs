import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { MemOsClient } from "../../../apps/server/src/memOsEngineClient.mjs";

// Explicit opt-in: add/search invoke embedding and can enqueue paid model work.
// Every account is newly generated; no namespace or account ID can be supplied.
const enabled = process.env.EVIMED_MEMOS_LIVE_CONTRACT === "disposable"
  && process.env.EVIMED_MEMOS_LIVE_ALLOW_MODEL_CALLS === "yes";

test("live MemOS persistence, processing, provenance and tenant isolation", {
  skip: !enabled,
  timeout: 240_000,
}, async () => {
  assert.ok(process.env.EVIMED_MEMOS_LIVE_BASE_URL, "Provide the isolated engine origin");
  const client = new MemOsClient({ memOsBaseUrl: process.env.EVIMED_MEMOS_LIVE_BASE_URL, memOsTimeoutMs: 30_000 });
  const suffix = randomUUID();
  const account = `disposable-contract-a-${suffix}`;
  const otherAccount = `disposable-contract-b-${suffix}`;
  const projectId = "disposable-project-one";
  const otherProject = "disposable-project-two";
  const entryId = `entry-${suffix}`;
  const provenanceId = `provenance-${suffix}`;
  const record = { entryId, content: `The synthetic contract canary is ${suffix}.`, provenanceIds: [provenanceId] };
  const failures = [];
  async function settle(userId, receipt, project) {
    const deadline = Date.now() + 60_000;
    let status = "unverified";
    while (Date.now() < deadline) {
      const result = await client.getTaskStatus(userId, receipt.records[0].taskId, { projectId: project });
      status = result.status;
      if (status === "completed") return;
      assert.ok(!["failed", "cancelled"].includes(status), `MemOS processing ${status}`);
      await delay(500);
    }
    assert.fail(`MemOS processing did not complete: ${status}`);
  }
  try {
    await client.health();
    const initial = await client.add(account, [record], { projectId });
    await settle(account, initial, projectId);
    await settle(otherAccount, await client.add(otherAccount, [record], { projectId }), projectId);
    await settle(account, await client.add(account, [{ ...record, entryId: `other-${entryId}` }], { projectId: otherProject }), otherProject);
    const exported = await client.export(account, { projectId });
    assert.equal(exported.complete, true);
    const memory = exported.records.find(item => item.entryId === entryId);
    assert.ok(memory, "Engine must preserve the product entry ID after processing");
    assert.ok(memory.provenanceIds.includes(provenanceId));
    const recalled = await client.search(account, suffix, { projectId });
    assert.ok(recalled.some(item => item.entryId === entryId), "Engine must recall the processed canary");
    assert.ok(recalled.every(item => item.entryId !== `other-${entryId}`), "Project recall must stay isolated");
    const foreign = (await client.export(otherAccount, { projectId })).records.find(item => item.entryId === entryId);
    assert.ok(foreign);
    await client.deleteRecord(account, foreign.id, { projectId });
    assert.ok((await client.export(otherAccount, { projectId })).records.some(item => item.id === foreign.id), "Cross-account deletion must do nothing");
    await client.deleteRecord(account, memory.id, { projectId });
    assert.ok(!(await client.export(account, { projectId })).records.some(item => item.id === memory.id), "Successful delete must be verified by a scoped read");
    await client.deleteUser(account);
    assert.equal((await client.export(account, { projectId })).total, 0);
    assert.equal((await client.export(account, { projectId: otherProject })).total, 0);
    assert.ok((await client.export(otherAccount, { projectId })).total > 0);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const userId of [account, otherAccount]) {
      try {
        await client.deleteUser(userId);
        for (const project of [projectId, otherProject]) {
          assert.equal((await client.export(userId, { projectId: project })).total, 0, `Disposable cleanup failed for ${userId}`);
        }
      } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures, "MemOS live contract or disposable cleanup failed.");
});
