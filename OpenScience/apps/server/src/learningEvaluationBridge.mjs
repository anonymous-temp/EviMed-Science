import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { HttpError, readJson, sendJson } from "./security.mjs";

const GRANT_FIELDS = ["userId", "projectId", "methodId", "candidateDigest", "mountedDigest", "snapshotDigest"];

/**
 * A job-only loopback API. No browser session, general account route or provider
 * credential is issued to the evaluator. Every operation belongs to a cell
 * allocated by this grant; deleting the source project is not expressible.
 * @param {{grant: any, createCell: (input: any) => Promise<any>, readCell: (cell: any) => Promise<any>,
 * readArtifact: (cell: any, path: string) => Promise<any>, readTranscript: (cell: any) => Promise<any>,
 * readUsage: (cell: any) => Promise<any>, cleanupCell: (cell: any) => Promise<void>,
 * judge?: (cell: any, input: any) => Promise<any>, maxCells?: number, ttlMs?: number, now?: () => number}} options
 */
export async function startLearningEvaluationBridge(options) {
  const { grant, now = Date.now, ttlMs = 6 * 60 * 60_000, maxCells = 12 } = options;
  if (!Number.isSafeInteger(maxCells) || maxCells < 2 || maxCells > 600
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60_000) throw new TypeError("Invalid evaluation limits.");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now() + ttlMs;
  const cells = new Map();
  const claimed = new Set();
  const pending = new Set();
  let closed = false;
  let closePromise;
  let url = "";
  const controller = new AbortController();

  const cleanup = async (cell) => {
    await options.cleanupCell(cell);
    cells.delete(cell.projectId);
  };
  const handle = async (req, res) => {
    const supplied = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    if (closed || now() >= expiresAt || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new HttpError(401, "evaluation_grant_invalid", "The evaluation grant is unavailable.");
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const reply = (data, status = 200) => sendJson(res, status, { data });
    if (pathname === "/api/evaluation/job" && req.method === "GET") {
      return reply({ ...grant, maxCells, expiresAt });
    }
    if (pathname === "/api/evaluation/cells" && req.method === "POST") {
      const body = await readJson(req, 4 * 1024 * 1024);
      if (!body || GRANT_FIELDS.some((field) => body[field] !== grant[field])) {
        throw new HttpError(403, "evaluation_scope_mismatch", "The cell does not belong to this frozen evaluation.");
      }
      if (!["baseline", "candidate"].includes(body.arm) || typeof body.cellId !== "string" || body.cellId.length > 200
        || typeof body.text !== "string" || !body.text.trim() || typeof body.capabilityId !== "string") {
        throw new HttpError(400, "evaluation_cell_invalid", "Invalid evaluation cell.");
      }
      if (claimed.has(body.cellId) || claimed.size >= maxCells) {
        throw new HttpError(409, "evaluation_cell_limit", "This evaluation cell is already claimed or exceeds its budget.");
      }
      claimed.add(body.cellId);
      const cell = await options.createCell({ ...body, signal: controller.signal });
      if (!cell?.projectId || cell.projectId === grant.projectId || cells.has(cell.projectId)) {
        throw new HttpError(500, "evaluation_cell_invalid", "The cell did not receive an isolated project.");
      }
      cells.set(cell.projectId, cell);
      if (closed) { await cleanup(cell); throw new HttpError(410, "evaluation_closed", "Evaluation closed."); }
      return reply({ projectId: cell.projectId, runId: cell.runId, sessionId: cell.sessionId }, 201);
    }
    const projectId = String(req.headers["x-open-science-project"] ?? "");
    const cell = cells.get(projectId);
    if (!cell) throw new HttpError(403, "evaluation_project_forbidden", "This project is outside the evaluation grant.");
    if (pathname === "/api/agent-runs" && req.method === "GET") return reply([await options.readCell(cell)]);
    if (pathname === `/api/runs/${encodeURIComponent(cell.runId)}/usage` && req.method === "GET") return reply(await options.readUsage(cell));
    if (pathname === `/api/runtime/sessions/${encodeURIComponent(cell.sessionId)}/transcript` && req.method === "GET") {
      return reply(await options.readTranscript(cell));
    }
    if (pathname === "/api/commands/read_artifact" && req.method === "POST") {
      const body = await readJson(req, 8192);
      if (typeof body?.path !== "string") throw new HttpError(400, "evaluation_path_invalid", "An artifact path is required.");
      return reply(await options.readArtifact(cell, body.path));
    }
    if (pathname === "/api/evaluation/judge" && req.method === "POST" && options.judge) {
      return reply(await options.judge(cell, await readJson(req, 256 * 1024)));
    }
    if (pathname === `/api/evaluation/cells/${encodeURIComponent(projectId)}` && req.method === "DELETE") {
      await cleanup(cell);
      return reply({ deleted: true });
    }
    throw new HttpError(404, "not_found", "No such evaluation operation.");
  };
  const server = createServer((req, res) => {
    const operation = handle(req, res).catch((error) => {
      if (!res.destroyed) sendJson(res, error instanceof HttpError ? error.status : 500, {
        code: error instanceof HttpError ? error.code : "evaluation_failed",
        message: "The private evaluation operation failed.",
      });
    }).finally(() => pending.delete(operation));
    pending.add(operation);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(null)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The evaluation listener has no address.");
  url = `http://127.0.0.1:${address.port}`;
  const close = () => closePromise ??= (async () => {
    closed = true;
    controller.abort();
    clearTimeout(expiry);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(null)));
    await Promise.allSettled([...pending]);
    const results = await Promise.allSettled([...cells.values()].map(cleanup));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Evaluation cleanup failed.");
  })();
  const expiry = setTimeout(() => { void close().catch(() => {}); }, ttlMs);
  expiry.unref();
  return { url, token, close };
}
