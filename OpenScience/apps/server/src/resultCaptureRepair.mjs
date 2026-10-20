import { createHash } from "node:crypto";
import { claimEvidenceSources } from "@evimed/domain/clinical-evidence";
import { readCaptureRepairReceipt } from "./agentRuns.mjs";
import { captureFinishedRun, sourceCapture, stableBytes } from "./resultDeliveryCapture.mjs";
import { HttpError } from "./security.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** Operator-only orchestration over the normal capture path. Planning never creates a result, job or model request. */
export class ResultCaptureRepairService {
  /** @param {{results:any,runs:any,programme?:any}} dependencies */
  constructor({ results, runs, programme = null }) { this.results = results; this.runs = runs; this.programme = programme; }

  /** @param {{userId:string,projectId:string,runId:string,expectedReceiptSha256?:string}} request */
  async prepare(request) {
    const project = await this.results.scope(request.userId, request.projectId);
    const run = (await this.runs.list(project)).find(item => item.id === request.runId);
    if (!run) throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
    if (run.status === "running") throw new HttpError(409, "agent_run_not_finished", "The run is still working.");
    const original = await readCaptureRepairReceipt(project, run);
    if (request.expectedReceiptSha256 && request.expectedReceiptSha256 !== original.sha256) throw new HttpError(409, "result_capture_receipt_changed", "The original receipt changed.");
    const files = [];
    const sources = new Map();
    let matrixCount = 0;
    let totalBytes = 0;
    for (const entry of original.receipt.entries) for (const file of entry.files) {
      if (files.length >= 64 || totalBytes + file.bytes > 256 * 1024 * 1024) throw new HttpError(413, "result_capture_repair_too_large", "The repair exceeds its file allowance.");
      const bytes = await stableBytes(project, file.path, this.results.maxSnapshotBytes);
      if (sha(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new HttpError(409, "result_capture_changed", "A result no longer matches its original receipt.");
      totalBytes += bytes.length;
      files.push({ path: file.path, sha256: file.sha256, bytes: file.bytes });
      if (!/(?:^|\/)clinical-evidence-matrix\.json$/.test(file.path)) continue;
      matrixCount += 1;
      const matrix = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(matrix.claims) || matrix.claims.length > 500) throw new HttpError(422, "result_capture_matrix_invalid", "The evidence matrix is invalid.");
      for (const relative of new Set(matrix.claims.flatMap(claim => claimEvidenceSources(claim).map(source => source?.artifactPath)).filter(Boolean))) {
        if (sources.has(relative)) continue;
        if (sources.size >= 48) throw new HttpError(413, "result_source_capture_limit", "Too many sources for one repair.");
        const source = await sourceCapture(project, relative, this.results.maxSnapshotBytes);
        totalBytes += source.bytes.length;
        if (totalBytes > 256 * 1024 * 1024) throw new HttpError(413, "result_capture_repair_too_large", "The repair exceeds its source allowance.");
        sources.set(relative, { path: relative, sha256: source.expectedDigest, version: source.version, bytes: source.bytes.length });
      }
    }
    if (matrixCount !== 1) throw new HttpError(409, "result_capture_repair_matrix_required", "Repair exactly one original clinical package at a time.");
    const plan = { userId: project.userId, projectId: project.id, runId: run.id, receiptSha256: original.sha256,
      files: files.sort((a, b) => a.path.localeCompare(b.path)), sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)) };
    return { project, run, receipt: original.receipt, plan: { ...plan, planSha256: sha(JSON.stringify(plan)) } };
  }

  /** @param {{userId:string,projectId:string,runId:string,expectedReceiptSha256?:string}} request */
  async plan(request) { return (await this.prepare(request)).plan; }

  /** Apply exactly the reviewed plan; capture replay and settlement generations are idempotent.
   * @param {{userId:string,projectId:string,runId:string,expectedReceiptSha256:string,expectedPlanSha256:string,resettle?:boolean,requestedBy?:string}} request */
  async apply(request) {
    if (!/^[a-f0-9]{64}$/.test(request.expectedPlanSha256 ?? "") || !/^[a-f0-9]{64}$/.test(request.expectedReceiptSha256 ?? "")) throw new HttpError(400, "result_capture_repair_plan_required", "An exact repair plan and receipt digest are required.");
    const prepared = await this.prepare(request);
    if (request.resettle && !this.programme?.owns(prepared.project.userId, prepared.project.id)) throw new HttpError(403, "result_capture_repair_invalid", "Only a programme-owned capture may request settlement.");
    if (prepared.plan.planSha256 !== request.expectedPlanSha256) throw new HttpError(409, "result_capture_repair_plan_changed", "The repair plan changed.");
    const captured = await captureFinishedRun({ results: this.results, project: prepared.project, run: prepared.run,
      readReceipt: async () => prepared.receipt, unreceipted: false, reviewOrigin: "capture-repair" });
    if (!captured || captured.failures.length || captured.unbound.length || captured.items.length !== prepared.plan.files.length) {
      throw new HttpError(409, "result_capture_repair_incomplete", "Some original outputs could not be captured.");
    }
    const receipt = await this.results.recordCaptureRepair({ userId: request.userId, project: prepared.project, runId: prepared.run.id,
      receiptSha256: prepared.plan.receiptSha256, items: captured.items, requestedBy: request.requestedBy ?? request.userId });
    const settlement = request.resettle ? await this.programme?.settleCaptureRepair(receipt) : null;
    return { plan: prepared.plan, receipt, settlement, versions: captured.items.map(item => ({ versionId: item.versionId, digest: item.digest, path: item.path })) };
  }
}
