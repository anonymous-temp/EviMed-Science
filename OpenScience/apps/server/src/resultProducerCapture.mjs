import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeResultPath } from "@evimed/domain/result-provenance";

/** Convert a kernel-observed path to this project's workspace. No guessed
 * filename extraction from shell scripts or conversational output is allowed.
 * @param {any} project @param {unknown} value @param {string|null} runtimeWorkspaceRoot */
export function observedResultPath(project, value, runtimeWorkspaceRoot = null) {
  if (typeof value !== "string") throw new Error("Missing output path.");
  if (!path.isAbsolute(value)) return normalizeResultPath(value);
  for (const root of [project.workspaceDir, runtimeWorkspaceRoot].filter(Boolean)) {
    const relative = path.relative(root, value).replace(/\\/g, "/");
    if (relative && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative)) return normalizeResultPath(relative);
  }
  throw new Error("Output path is outside the owned workspace.");
}

/** Executable adapter for the actual DSH onRunEvent callback. Call inputs are
 * observed on the owned kernel stream; only completed write/edit operations
 * qualify. A reconnect can recapture an unchanged version idempotently, but an
 * overwritten path never inherits the previous write's producer receipt.
 * @param {{service:any,runtimeWorkspaceRoot?:(project:any)=>string,maxPendingCalls?:number,maxPendingCallBytes?:number,
 * onFailure?:(failure:any)=>void}} dependencies */
export function createResultProducerCapture({ service, runtimeWorkspaceRoot = () => null,
  maxPendingCalls = 1024, maxPendingCallBytes = 8 * 1024 * 1024, onFailure = () => {} }) {
  const calls = new Map();
  let callBytes = 0;
  const forget = key => { const previous = calls.get(key); if (previous) { callBytes -= previous.size; calls.delete(key); } };
  const pending = new Set();
  /** @param {any} project @param {string} runId @param {any} observed */
  async function observe(project, runId, observed) {
    const event = observed.event;
    const key = JSON.stringify([project.userId, project.id, observed.sessionId, event.callId]);
    if (event.type === "tool/call") {
      if (["write", "edit", "file_write", "file_edit"].includes(event.tool)) {
        forget(key);
        const size = Buffer.byteLength(JSON.stringify(event));
        if (size > maxPendingCallBytes) { onFailure({ projectId: project.id, runId, code: "result_capture_queue_full" }); return null; }
        calls.set(key, { event, size }); callBytes += size;
        while (calls.size > maxPendingCalls || callBytes > maxPendingCallBytes) {
          const oldest = calls.keys().next().value;
          callBytes -= calls.get(oldest).size; calls.delete(oldest);
        }
      }
      return null;
    }
    if (event.type !== "tool/result") return null;
    const call = calls.get(key)?.event;
    forget(key);
    if (event.status !== "completed") return null;
    if (!call) return null; // replayed result without input cannot assert an output
    const input = call.input ?? {};
    let relativePath;
    try { relativePath = observedResultPath(project, input.file_path ?? input.filePath ?? input.path, runtimeWorkspaceRoot(project)); }
    catch { onFailure({ projectId: project.id, runId, code: "result_output_path_unavailable" }); return null; }
    // Writes state their full bytes; edits state a patch, so their bytes remain
    // observed unless the owned tool eventually publishes a full digest receipt.
    const content = ["write", "file_write"].includes(call.tool) && typeof input.content === "string" ? input.content : null;
    try {
      return await service.captureFile({ userId: project.userId, project, relativePath,
        ...(content != null ? { expectedDigest: createHash("sha256").update(content).digest("hex") } : {}),
        producer: { kind: "tool", sessionId: observed.sessionId, runId, callId: event.callId,
          eventId: String(event.seq), parentSessionId: observed.parentSessionId ?? null, branchId: observed.branchId ?? null } });
    } catch (error) {
      onFailure({ projectId: project.id, runId, path: relativePath, code: error?.code ?? "result_capture_failed" });
      return null;
    }
  }
  return {
    observe,
    /** Synchronous event callback tracks async completion for shutdown/tests.
     * @param {any} project @param {string} runId @param {any} observed */
    onRunEvent(project, runId, observed) {
      const capture = observe(project, runId, observed);
      pending.add(capture);
      capture.catch(error => onFailure({ projectId: project.id, runId, code: error?.code ?? "result_capture_failed" }))
        .finally(() => pending.delete(capture));
    },
    async drain() { await Promise.allSettled([...pending]); },
  };
}

/** Bound deferred capture without slowing the kernel event feed. A dropped
 * observation remains an explicit gap; the verified delivery receipt can still
 * preserve the finished artifact independently.
 * @param {{capture:any,resolveProject:(project:any)=>Promise<any>,onFailure?:(failure:any)=>any,
 * maxPendingEvents?:number,maxPendingBytes?:number}} dependencies */
export function createResultCaptureQueue({ capture, resolveProject, onFailure = () => {},
  maxPendingEvents = 128, maxPendingBytes = 8 * 1024 * 1024 }) {
  let tail = Promise.resolve();
  let count = 0; let bytes = 0; let saturated = false;
  const report = async failure => { try { await onFailure(failure); } catch { /* logging cannot reject the delivery path */ } };
  return {
    observe(project, runId, observed) {
      if (!capture || !["tool/call", "tool/result"].includes(observed.event.type)) return;
      if (observed.event.type === "tool/call" && !["write", "edit", "file_write", "file_edit"].includes(observed.event.tool)) return;
      const size = Buffer.byteLength(JSON.stringify(observed));
      if (count >= maxPendingEvents || bytes + size > maxPendingBytes) {
        if (!saturated) void report({ userId: project.userId, projectId: project.id, runId, code: "result_capture_queue_full" });
        saturated = true;
        return;
      }
      count++; bytes += size;
      tail = tail.then(async () => capture.observe(await resolveProject(project), runId, observed))
        .catch(error => report({ userId: project.userId, projectId: project.id, runId, code: error?.code ?? "result_capture_failed" }))
        .finally(() => { count--; bytes -= size; if (count < maxPendingEvents / 2 && bytes < maxPendingBytes / 2) saturated = false; });
    },
    async drain() { await tail; },
  };
}

/** Bridge an already verified delivery or engine receipt. No run ledger is
 * created: ownership and digest remain those of the existing producer.
 * @param {any} service @param {any} input @param {{path:string,sha256?:string,digest?:string}[]} files */
export async function captureReceiptOutputs(service, input, files) {
  const items = []; const failures = [];
  for (const file of files) {
    const expectedDigest = (file.sha256 ?? file.digest ?? "").replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
      failures.push({ path: file.path, code: "result_producer_digest_missing" }); continue;
    }
    try { items.push(await service.captureFile({ ...input, relativePath: file.path, expectedDigest })); }
    catch (error) { failures.push({ path: file.path, code: error?.code ?? "result_capture_failed" }); }
  }
  return { items, failures };
}
