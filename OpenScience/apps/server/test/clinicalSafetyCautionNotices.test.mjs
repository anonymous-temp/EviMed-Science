// The pharmacist-authored cautions (clinical-safety-rules.json `cautionRules`)
// reach the reader as SAFETY notices on a delivered run, and never hold the
// delivery back (owner decision 5, 2026-09-18).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { deepResearchPackage, researchBrief } from "./fixtures/clinicalEvidencePackage.mjs";

test("a caution the report owes its reader is delivered as a SAFETY notice, and the package is delivered", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-cautions-"));
  try {
    const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_cautions", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const pkg = deepResearchPackage();
    let history = [];
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
    // The scene is set by the brief alone, as in the run behind the review:
    // the report the fixture carries never mentions aspirin, bleeding or a
    // guideline position on it.
    const question = `${researchBrief()}\n3. ≥70 岁老年人使用阿司匹林进行一级预防是否仍然合理？\n`;
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_cautions",
      question,
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
    history = [{
      info: { id: "msg_cautions", role: "assistant", time: { completed: Date.now() } },
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
    assert.equal(finished.status, "succeeded", "a caution never withholds a delivery");
    assert.equal(finished.errorCode, null);
    assert.equal(finished.verification ?? null, null, "a caution is not a statement about the evidence");
    const notices = (finished.qualityNotices ?? []).filter((notice) => notice.startsWith("SAFETY — "));
    assert.deepEqual(notices.map((notice) => notice.slice("SAFETY — ".length).split("：")[0]), [
      "阿司匹林一级预防",
      "老年人阿司匹林一级预防",
    ]);
    assert.match(notices[0], /请写明/);
    assert.ok(finished.artifacts.includes("clinical-evidence-report.md"));
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
