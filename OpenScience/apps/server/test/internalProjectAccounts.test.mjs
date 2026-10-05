// A name a client chose is never a waiver (follow-up to the review of 「循证进化」, 2026-10-05, B1).
// A project named `acceptance-*`, `audit-*` or `eval-method-*` was "internal" whoever owned it: its runs were
// not charged under research billing, it did not count against the account's project ceiling, and its runtime
// took none of the researcher's slots — and the name is typed by the caller of `POST /api/projects`, or derived
// from the title a researcher gives (an English "Audit trial" becomes `audit-trial`). It is internal now only when
// its owner is an operator or the deployment's acceptance account.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { EvimedCreditsService } from "../src/evimedCreditsService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("the project ceiling counts an ordinary account's acceptance-x project, and not an operator's or the acceptance account's", async () => {
  // Development auth signs in as the account `dev`; each app makes it a different kind of account.
  const kinds = [["an ordinary account", {}, 409], ["an operator", { operatorUsers: ["dev"] }, 200], ["the acceptance account", { acceptanceUsername: "dev" }, 200]];
  for (const [label, accounts, secondStatus] of kinds) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-internal-accounts-"));
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, maxProjectsPerUser: 2, ...accounts });
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const create = (/** @type {any} */ body) => fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const listed = async () => (await (await fetch(`${base}/api/projects`)).json()).data ?? [];
      assert.equal((await create({ id: "acceptance-x", name: "x" })).status, 200, label);
      assert.equal((await create({ id: "second", name: "second" })).status, secondStatus, `${label}: a second project`);
      // The same rule decides whether the project is shown in the researcher's own list.
      const ids = (await listed()).map((/** @type {any} */ project) => project.id);
      assert.equal(ids.includes("acceptance-x"), kinds.find(([name]) => name === label)?.[2] === 409, `${label}: shown in its own list only when it is an ordinary project`);
      // What the platform makes itself cannot be typed by anyone, operator or not.
      for (const id of ["evimed-frontier", `methodeval-${"0a".repeat(12)}`, "evimed-learning", "evimed-sources"]) {
        assert.equal((await create({ id, name: "x" })).status, 409, `${label}: ${id}`);
      }
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
});

test("an ordinary account's acceptance-x run is charged; an operator's and the acceptance account's are waived as before", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-internal-accounts-billing-"));
  const settled = [];
  const original = EvimedCreditsService.prototype.settleRun;
  EvimedCreditsService.prototype.settleRun = async function (run) { settled.push(run); return { status: "skipped", reason: "test" }; };
  const suffix = randomUUID().replaceAll("-", "");
  const ids = { ordinary: `ordinary_${suffix}`, operator: `operator_${suffix}`, acceptance: `acceptance_${suffix}` };
  const app = createWebApiApp({ dataDir, databaseUrl, stateStore: "postgres", requireSharedStateStore: true, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", deepseekProviderEnabled: false, researchMemoryEnabled: false, operatorUsers: [ids.operator], acceptanceUsername: ids.acceptance,
    evimedCreditsEnabled: true, researchBillingEnabled: true, evimedCreditsPerCny: 1, evimedCreditsUrl: "https://wallet.evimed.com/deduct",
    evimedCreditsBalanceUrl: "https://wallet.evimed.com/balance", evimedApiKey: "internal-accounts-test-only-key",
    evimedCreditsFetch: async () => Response.json({ code: 200, data: { balance: 100, frozen: 0, receiptId: "r" } }) });
  t.after(async () => {
    EvimedCreditsService.prototype.settleRun = original;
    for (const id of Object.values(ids)) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]).catch(() => {});
    await app.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  await app.listen(0, "127.0.0.1");
  for (const [kind, userId] of Object.entries(ids)) {
    const user = await app.store.upsertExternalUser(userId, `fixture ${kind}`, "evimed", { evimedUserId: `upstream-${kind}-${suffix}` });
    for (const projectId of ["acceptance-x", "audit-trial", "default"]) {
      const project = await app.store.projectFor(user, projectId);
      const binding = await app.researchSessions.put(project, `session_${randomUUID()}`, { mode: "open-domain" });
      const created = await app.agentRuns.createRun(project, binding, { baselineCursor: null });
      const persisted = (await app.agentRuns.list(project)).find((/** @type {any} */ run) => run.id === created.id);
      await app.agentRuns.onRunFinished(project, { ...persisted, status: "completed", finishedAt: new Date().toISOString() });
    }
  }
  const chargedProjects = (userId) => settled.filter((run) => run.userId === userId).map((run) => run.projectId).sort();
  assert.deepEqual(chargedProjects(ids.ordinary), ["acceptance-x", "audit-trial", "default"], "an ordinary account is charged for a project named like a measurement");
  assert.deepEqual(chargedProjects(ids.operator), ["default"], "an operator's measurement projects are waived");
  assert.deepEqual(chargedProjects(ids.acceptance), ["default"], "the acceptance account's measurement projects are waived");
});
