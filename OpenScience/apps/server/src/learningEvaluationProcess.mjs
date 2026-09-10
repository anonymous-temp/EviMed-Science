import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./security.mjs";

/** Execute a trusted operator command without a shell; secrets never enter argv.
 * @param {string} command @param {any} request
 * @param {{env?: Record<string,string>, signal?: AbortSignal, timeoutMs?: number, cwd?: string}} [options]
 */
export function runLearningEvaluationProcess(command, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 24 * 60 * 60_000) throw new TypeError("Invalid evaluation timeout.");
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new HttpError(502, "method_evaluation_cancelled", "The evaluation was cancelled.")); return; }
    const [program, ...args] = command.split(/\s+/).filter(Boolean);
    if (!program) { reject(new HttpError(503, "method_evaluation_unavailable", "No evaluation command is configured.")); return; }
    const child = spawn(program, [...args, "--json", "--method", request.methodId,
      "--candidate-digest", request.candidateDigest,
      ...(request.baselineDigest ? ["--baseline-digest", request.baselineDigest] : []),
    ], {
      cwd: options.cwd ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
      // Do not inherit provider credentials, eval-account passwords or arbitrary
      // runtime settings. The job grant is the only credential this child needs.
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", PYTHONUNBUFFERED: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let failure = null;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let killTimer = null;
    const killTree = () => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      } else {
        child.kill("SIGKILL");
      }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(failure);
    };
    const stop = (code) => {
      failure ??= new HttpError(502, code, "The bounded paired evaluation did not complete.");
      killTree();
      if (!killTimer) killTimer = setTimeout(() => {
        killTree();
        child.stdout.destroy();
        child.stderr.destroy();
        fail();
      }, 250);
    };
    const abort = () => stop("method_evaluation_cancelled");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("method_evaluation_timeout"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 1024 * 1024) { stop("method_evaluation_output_limit"); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024 * 1024) stop("method_evaluation_output_limit");
    });
    child.once("error", () => { failure ??= new HttpError(502, "method_evaluation_failed", "The paired evaluation could not start."); });
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) { fail(); return; }
      settled = true;
      if (code !== 0) { reject(new HttpError(502, "method_evaluation_failed", "The paired evaluation failed.")); return; }
      try {
        const parsed = JSON.parse(stdout.toString("utf8").trim().split("\n").at(-1) ?? "");
        if (!parsed || typeof parsed.verdict !== "string" || typeof parsed.report !== "string") throw new Error("Invalid verdict.");
        resolve(parsed);
      } catch { reject(new HttpError(502, "method_evaluation_invalid", "The paired evaluation returned no readable verdict.")); }
    });
  });
}
