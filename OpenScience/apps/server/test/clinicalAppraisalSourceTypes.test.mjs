// A claim's structured GRADE certainty is read against the evidence type the
// preserving tool stamped beside its source (`source.json`, contract C8). The
// run side and the reader read that file; this is the control plane's own
// gate reading it too, so the notice a delivered run carries is the one the
// run was given and the one the reader's badge agrees with. Advice only: the
// package is delivered either way (owner decision 5, 2026-09-18).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { deepResearchPackage, researchBrief } from "./fixtures/clinicalEvidencePackage.mjs";

const DESIGN_NOTICE = "starts at low, but every source it cites is a randomized trial";

/** One clinical run through the real delivery gate, with CLM-001 carrying a
 *  certainty that starts at low, and its source stamped — or not — as a
 *  randomized trial. @param {{ stamped: boolean }} options */
async function deliver({ stamped }) {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-appraisal-"));
  try {
    const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_appraisal", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const pkg = deepResearchPackage();
    pkg.matrix.claims[0] = { ...pkg.matrix.claims[0], certainty: { start: "low", label: "low" } };
    let history = /** @type {any[]} */ ([]);
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "1.0.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          outputs: [
            { path: "clinical-evidence-report.md", required: true },
            { path: "clinical-evidence-matrix.json", required: true },
          ],
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
      maxClinicalRepairAttempts: 0,
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_appraisal",
      question: researchBrief(),
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    const deliverables = new Map([
      ["clinical-evidence-report.md", pkg.reportText],
      ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)],
    ]);
    for (const [relative, content] of deliverables) await writeFile(path.join(project.workspaceDir, relative), content, "utf8");
    for (const [artifactPath, content] of Object.entries(pkg.sourceArtifacts)) {
      await mkdir(path.join(project.workspaceDir, path.dirname(artifactPath)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, artifactPath), content, "utf8");
    }
    if (stamped) {
      const capture = path.dirname(pkg.matrix.claims[0].artifactPath);
      await writeFile(path.join(project.workspaceDir, capture, "source.json"), '{"schemaVersion":1,"sourceType":"rct","sourceId":"source-1"}\n', "utf8");
    }
    history = [{
      info: { id: "msg_appraisal", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...Object.entries(pkg.sourceArtifacts).map(([artifactPath, content]) => ({
          type: "tool",
          tool: "evimed-research_evimed_open_access_full_text",
          state: {
            status: "completed",
            output: JSON.stringify({ status: "success", artifacts: [artifactPath], data: { artifactSha256s: { [artifactPath]: createHash("sha256").update(content, "utf8").digest("hex") } } }),
          },
        })),
        ...[...deliverables.keys()].map((filePath) => ({ type: "tool", tool: "write", state: { status: "completed", input: { filePath } } })),
        { type: "text", text: "Completed." },
      ],
    }];

    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    await store.closeProject(project, "canceled");
    return finished;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the control plane's gate reads the type stamped beside a source, and its certainty notice is advice", async () => {
  const stamped = await deliver({ stamped: true });
  assert.equal(stamped.status, "succeeded", "a certainty notice never withholds a delivery");
  assert.notEqual(stamped.verification, "unverified", "a notice about appraisal is not a statement about the evidence");
  assert.ok(stamped.artifacts.includes("clinical-evidence-report.md"));
  // Serialized so the assertion holds whether a notice is a string or the
  // structured item the notices are becoming (contract C2).
  assert.ok(JSON.stringify(stamped.qualityNotices ?? []).includes(DESIGN_NOTICE), JSON.stringify(stamped.qualityNotices));

  // No stamp beside the capture: the author's own start stands, and nothing is said.
  const unstamped = await deliver({ stamped: false });
  assert.equal(unstamped.status, "succeeded");
  assert.equal(JSON.stringify(unstamped.qualityNotices ?? []).includes(DESIGN_NOTICE), false, JSON.stringify(unstamped.qualityNotices));
});
