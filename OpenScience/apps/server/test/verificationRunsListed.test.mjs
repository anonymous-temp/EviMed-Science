// The independent re-check of a scheduled task's claim is a run of its own in the project's ledger, and the person's own lists read that
// ledger (2026-10-14: 14 of them, titled 「独立核验另一研究…」, stood in the owner's conversation list, and "last open" could reopen one).
// The run list carries the one mark that tells them apart (`role`), derived from the route reason the control plane wrote, and the
// ledger's "last open" and the researcher's own questions leave them out.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON } from "@evimed/domain";
import { isResearcherRun } from "../src/agentRuns.mjs";
import { VERIFICATION_ROUTE_REASON } from "../src/autopilotService.mjs";
import { createWebApiApp } from "../src/server.mjs";

const HEADERS = { "X-Open-Science-Project": "default" };

test("a verification run is marked in the run list, an ordinary or scheduled run is not, and nothing is removed from the ledger", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-verification-list-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true });
  const address = await app.listen(0, "127.0.0.1");
  try {
    const user = await app.store.devUser();
    const project = await app.store.requireProject(user, "default");
    const reserve = async (sessionId, dispatchId, effectiveRouteReason, extra = {}) => {
      await app.researchSessions.put(project, sessionId, { mode: "open-domain" });
      const { run } = await app.agentRuns.reserveRun(project, await app.researchSessions.get(project, sessionId), {
        baselineCursor: null, dispatchId, question: `question of ${dispatchId}`,
        effectiveAgentId: "open-domain-answer", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "open-domain-answer", effectiveRouteReason, ...extra,
      });
      return run;
    };
    // The person's own turn first and the platform's after it, so that "last open" is a verification unless it is told apart.
    const ordinary = await reserve("ses_ordinary", "ordinary-turn-1", "unrouted:open-domain");
    const scheduled = await reserve("ses_episode", "episode-00112233445566778899aabbccddeeff", "autopilot:routine", { automated: true });
    const verification = await reserve("ses_verify", "episode-0123456789abcdef0123456789abcdef-v1", VERIFICATION_ROUTE_REASON);
    const programme = await reserve("ses_verify_programme", "episode-fedcba9876543210fedcba9876543210-v1", EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent-runs`, { headers: HEADERS });
    assert.equal(response.status, 200);
    const runs = (await response.json()).data;
    const byId = new Map(runs.map((run) => [run.id, run]));
    // Still in the list: the task's page reads the progress of a verification from it, and the run ledger keeps every run.
    for (const run of [verification, programme, ordinary, scheduled]) assert.ok(byId.has(run.id), `${run.dispatchId} is listed`);
    assert.equal(byId.get(verification.id).role, "verification");
    assert.equal(byId.get(programme.id).role, "verification");
    assert.equal(Object.hasOwn(byId.get(ordinary.id), "role"), false);
    assert.equal(Object.hasOwn(byId.get(scheduled.id), "role"), false, "the execution a verification checks is the task's own conversation");

    // "Last open" reopens a conversation of the person's, never a verification, however recent.
    assert.equal(await app.agentRuns.lastSessionId(project), "ses_ordinary");
    assert.deepEqual([verification, programme, ordinary, scheduled].map((run) => isResearcherRun(run)), [false, false, true, false]);
    assert.deepEqual((await app.agentRuns.researcherRuns(project, { includeManaged: true })).map((run) => run.dispatchId).sort(),
      ["episode-00112233445566778899aabbccddeeff", "ordinary-turn-1"].sort(), "a managed execution counts as the researcher's work, its verification does not");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
