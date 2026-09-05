import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  const client = new MemOsClient({
    memOsBaseUrl: process.env.EVIMED_MEMOS_LIVE_BASE_URL,
    memOsTimeoutMs: 30_000,
    memOsWriteMode: "sync-fast",
  });
  const suffix = randomUUID();
  const account = `disposable-contract-a-${suffix}`;
  const otherAccount = `disposable-contract-b-${suffix}`;
  const projectId = "disposable-project-one";
  const otherProject = "disposable-project-two";
  const accountCreatedAt = "2026-09-06 00:00:00+00";
  const scope = project => ({ accountCreatedAt, projectId: project });
  const entryId = `entry-${suffix}`;
  const provenanceId = `provenance-${suffix}`;
  const record = { entryId, content: `The synthetic contract canary is ${suffix}.`, provenanceIds: [provenanceId] };
  const failures = [];
  try {
    await client.health();
    await client.add(account, [record], scope(projectId));
    await client.add(otherAccount, [record], scope(projectId));
    await client.add(account, [{ ...record, entryId: `other-${entryId}` }], scope(otherProject));
    const exported = await client.export(account, scope(projectId));
    assert.equal(exported.complete, true);
    const memory = exported.records.find(item => item.entryId === entryId);
    assert.ok(memory, "Engine must preserve the product entry ID after processing");
    assert.ok(memory.provenanceIds.includes(provenanceId));
    const recalled = await client.search(account, suffix, scope(projectId));
    assert.ok(recalled.some(item => item.entryId === entryId), "Engine must recall the processed canary");
    assert.ok(recalled.every(item => item.entryId !== `other-${entryId}`), "Project recall must stay isolated");
    const foreign = (await client.export(otherAccount, scope(projectId))).records.find(item => item.entryId === entryId);
    assert.ok(foreign);
    await client.deleteRecord(account, foreign.id, scope(projectId));
    assert.ok((await client.export(otherAccount, scope(projectId))).records.some(item => item.id === foreign.id), "Cross-account deletion must do nothing");
    await client.deleteRecord(account, memory.id, scope(projectId));
    assert.ok(!(await client.export(account, scope(projectId))).records.some(item => item.id === memory.id), "Successful delete must be verified by a scoped read");
    await client.deleteScope(account, scope(otherProject));
    assert.equal((await client.export(account, scope(projectId))).total, 0);
    assert.equal((await client.export(account, scope(otherProject))).total, 0);
    assert.ok((await client.export(otherAccount, scope(projectId))).total > 0);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const userId of [account, otherAccount]) {
      try {
        for (const project of [projectId, otherProject]) {
          await client.deleteScope(userId, scope(project));
          assert.equal((await client.export(userId, scope(project))).total, 0, `Disposable cleanup failed for ${userId}`);
        }
      } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures, "MemOS live contract or disposable cleanup failed.");
});
