// What a run's spend is booked as is decided by the control plane, never by a
// string the browser sends (review of 「循证进化」, 2026-10-05, B1/F2).
//
// `POST /api/agent-runs/dispatch` takes `dispatchId` and `automated` from its
// caller. The domain read both: a dispatch id spelled `evolution_…` booked the
// run as the platform's own evolution spend — outside the account's day and
// week caps, under a separate allowance, waived by research billing — and
// `methodeval_…` did the same as `learning`; `automated: true` waived the
// charge. Production runs with caps of 0 and the evolution module off, and
// none of that was gated on either.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isChargeableResearchRun, isResearcherOwnedWork, usagePurposeOfRun } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";

const FORGED = ["evolution_free_1", "evolution_paper_0123456789abcdef", "methodeval_0a1b2c3d4e5f"];

test("a run the dispatch route records is the kernel's whatever dispatch id or flags its caller sends", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-purpose-boundary-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
  try {
    const dispatched = [];
    for (const [index, dispatchId] of FORGED.entries()) {
      const session = `ses_forged_${index}`;
      assert.equal((await fetch(`${base}/api/research-sessions/${session}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
      const response = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers,
        body: JSON.stringify({ sessionId: session, dispatchId, text: `问题 ${dispatchId}`, automated: index === 2 }) });
      assert.equal(response.status, 202, dispatchId);
      dispatched.push((await response.json()).data);
    }
    const ledger = (await (await fetch(`${base}/api/agent-runs`, { headers })).json()).data;
    assert.equal(ledger.length, FORGED.length);
    for (const run of ledger) {
      assert.ok(FORGED.includes(run.dispatchId), "the caller's id is kept as an identity");
      assert.equal(usagePurposeOfRun(run), "kernel", `${run.dispatchId} must not choose a purpose`);
      assert.equal(isChargeableResearchRun(run), true, `${run.dispatchId} is still the researcher's to pay`);
    }
    // Nor can the public route name a capability whose runs are the platform's: an internal capability is no line a caller may choose.
    for (const [index, line] of ["tool-builder", "evolution-scout", "method-distillation", "method-relations", "source-understanding"].entries()) {
      const session = `ses_internal_${index}`;
      assert.equal((await fetch(`${base}/api/research-sessions/${session}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
      const refused = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify({ sessionId: session, dispatchId: `internal_${index}`, text: "x", line }) });
      assert.equal(refused.status, 400, `line ${line}`);
    }
    // A conversation bound to one of them is refused too, wherever the refusal falls: binding it, or the dispatch.
    for (const agentId of ["tool-builder", "method-distillation", "source-understanding"]) {
      const session = `ses_bound_${agentId}`;
      const bound = await fetch(`${base}/api/research-sessions/${session}`, { method: "PUT", headers, body: JSON.stringify({ mode: "specialist", agentId }) });
      if (bound.status < 400) {
        const refused = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify({ sessionId: session, dispatchId: `bound_${agentId}`, text: "x" }) });
        assert.ok(refused.status >= 400, `a session bound to ${agentId} must not dispatch (${refused.status})`);
      }
    }
    const claimedAutomated = ledger.find((run) => run.automated === true);
    assert.ok(claimedAutomated, "the harness flag is still recorded");
    assert.equal(isResearcherOwnedWork(claimedAutomated), false, "a harness teaches nothing");
    assert.equal(isChargeableResearchRun(claimedAutomated), true, "but its own statement is not a waiver");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an account cannot name a project into the evolution module's own class; an operator can, as the paper-gold harness does", async () => {
  for (const [operatorUsers, expected] of [[[], 409], [["dev"], 200]]) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "os-evolution-project-id-"));
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, operatorUsers });
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "Content-Type": "application/json" };
    try {
      for (const id of ["evimed-evolution", "evolution-eval-abc", "eval-paper-0123abcd"]) {
        const response = await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id, name: "x" }) });
        const text = await response.text();
        assert.equal(response.status, expected, `${id} for operators=${JSON.stringify(operatorUsers)}: ${text}`);
        if (expected === 409) assert.match(text, /project_id_reserved/);
      }
      // An ordinary id is untouched.
      assert.equal((await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id: "my-study", name: "my study" }) })).status, 200);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
