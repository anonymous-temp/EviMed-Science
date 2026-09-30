import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { noticeTexts } from "./helpers/noticeTexts.mjs";

for (const status of ["canceled", "failed"]) {
  test(`a ${status} run preserves files without inventing a failed quality check`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "os-unverified-notice-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = { id: "p-notice", userId: "owner", rootDir: root,
      workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "session-notice", mode: "open-domain", agentId: null,
      agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash" });
    store.scheduleMonitor = () => {};
    const started = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "notice-turn" },
      async () => ({ accepted: true }));
    const relative = "deliverables/research/report.md";
    await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relative), "# Preserved research\n");
    if (status === "canceled") await store.cancelRun(project, started.id, { by: "user" });
    else await store.finishInternal(project, started.id, { status, errorCode: "runtime_not_running", artifacts: [] });
    const result = (await store.list(project)).find((run) => run.id === started.id);
    assert.equal(result.status, status);
    assert.deepEqual(result.unverifiedArtifacts, [relative]);
    const notice = noticeTexts(result).find((text) => text.includes("未经核验"));
    assert.ok(notice, "retained files must disclose their unverified state");
    assert.doesNotMatch(notice, /没有通过|退回理由|质量门|通过判定/,
      "stopping before verification is not evidence that a quality check rejected the research");
    if (status === "canceled") assert.match(notice, /取消/);
  });
}
