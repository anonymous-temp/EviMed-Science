/**
 * A finished evidence package and a month of use, for the walk's fixture.
 *
 *  - one run of `clinical-evidence-synthesis` that delivered its package — the report and the evidence matrix of eighteen claims over twelve
 *    preserved sources, the known-valid package the gate's own tests use (`test/fixtures/clinicalEvidencePackage.mjs`) — written into the
 *    project's workspace and into the run ledger the way a finished run leaves them, so that the runs list, the report reader and the
 *    evidence matrix are drawn from a package and not from an empty list;
 *  - the account's spend over the month (the usage ledger's own rows), so that 设置 → 用量 draws a chart and a table.
 */
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "server");

/** The deliverable's id and the files of its package. */
const DELIVERABLE = "clinical-evidence";

/**
 * @param {any} app @param {any} user @param {{ log: (line: string) => void }} context
 */
export async function furnishRuns(app, user, { log }) {
  const { deepResearchPackage, researchBrief } = await import(pathToFileURL(path.join(server, "test", "fixtures", "clinicalEvidencePackage.mjs")).href);
  const project = await app.store.defaultProject(user);
  const pack = deepResearchPackage();

  // ---- the package on disk: where a run's deliverable lives, and the sources it preserved
  const directory = path.join(project.workspaceDir, "deliverables", DELIVERABLE);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "clinical-evidence-report.md"), `${pack.reportText}\n`);
  await writeFile(path.join(directory, "clinical-evidence-matrix.json"), `${JSON.stringify(pack.matrix, null, 2)}\n`);
  for (const [artifact, text] of Object.entries(pack.sourceArtifacts)) {
    const target = path.join(directory, String(artifact));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${text}\n`);
  }
  void researchBrief;

  // ---- the run: started through the ledger's own writer, finished by the event it writes
  const registry = await app.agentRegistry;
  const capability = registry?.get?.("clinical-evidence-synthesis");
  const sessionId = "session_walk_evidence";
  const binding = await app.researchSessions.put(project, sessionId, {
    mode: "specialist", agentId: "clinical-evidence-synthesis", agentVersion: capability?.version ?? "1.0.0",
  });
  const started = Date.now() - 6 * 86_400_000;
  const { run } = await app.agentRuns.reserveRun(project, binding, { baselineCursor: null, question: "急性胸部压迫感的院前判别与处置：证据评价", startedAt: new Date(started).toISOString() });
  const finished = {
    event: "finished", id: run.id, status: "succeeded", errorCode: null,
    artifacts: [`deliverables/${DELIVERABLE}/clinical-evidence-report.md`, `deliverables/${DELIVERABLE}/clinical-evidence-matrix.json`],
    finishedAt: new Date(started + 47 * 60_000).toISOString(), durationMs: 47 * 60_000,
    deliverables: [{ id: DELIVERABLE, title: "急性胸部压迫感的证据评价", capability: "clinical-evidence-synthesis", status: "accepted", attempts: 1, lastVerdict: "pass" }],
  };
  await appendFile(path.join(project.metaDir, "runs.jsonl"), `${JSON.stringify(finished)}\n`);
  log(`runs: ${run.id} delivered a package of ${pack.matrix.claims.length} claims`);

  // ---- a month of use: spend on the kernel and on titles, a few days apart
  const days = [27, 25, 22, 20, 17, 15, 12, 9, 6, 4, 2, 1];
  for (const [index, ago] of days.entries()) {
    for (const [purpose, cost] of [["kernel", 1.2 + (index % 5) * 0.9], ["title", 0.01 + (index % 3) * 0.004]]) {
      await app.usageLedger.recordSettled({
        id: `usage_walk_${index}_${purpose}`, userId: user.id, projectId: "default", runId: index === 0 ? run.id : null, purpose, actualCost: Number(cost.toFixed(4)),
        model: "deepseek-flash", priceVersion: "walk-fixture", currency: "CNY", priced: true, requestFingerprint: "a".repeat(63) + String(index % 10),
        usage: { cacheHitTokens: 40_000 + index * 1_000, cacheMissTokens: 12_000 + index * 700, completionTokens: 3_000 + index * 200 }, now: new Date(Date.now() - ago * 86_400_000),
      });
    }
  }
  log(`runs: ${days.length * 2} usage rows`);
  return { runId: run.id };
}
