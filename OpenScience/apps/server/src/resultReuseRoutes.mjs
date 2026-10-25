import { attachmentDisposition, HttpError, readJson, sendJson } from "./security.mjs";

/**
 * `onExported(user, projectId, versionId)` is told, after the package has been sent, that the owner took a result: the learning loop counts a
 * delivered file taken as the run's use (`LearningEvidence.noteFileUse`). An observation: never awaited, a failure is its own.
 * @param {{ store: any, exporter: any, revisions: any, onExported?: ((user: any, projectId: string, versionId: string) => Promise<unknown> | unknown) | null }} dependencies
 */
export function createResultReuseRoutes({ store, exporter, revisions, onExported = null }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const matched = /^\/api\/results\/(rv_[a-f0-9]{64})\/(export|revisions)$/.exec(url.pathname);
    if (!matched) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (matched[2] === "export" && req.method === "GET") {
      if (!exporter) throw new HttpError(503, "result_storage_unavailable", "Result export is unavailable.");
      const file = await exporter.export(user.id, url.searchParams.get("projectId"), matched[1]);
      res.writeHead(200, { "Content-Type": file.mimeType, "Content-Length": file.bytes.length,
        "Content-Disposition": attachmentDisposition(file.filename), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(file.bytes);
      if (onExported) void Promise.resolve().then(() => onExported(user, String(url.searchParams.get("projectId") ?? ""), matched[1])).catch(() => {});
      return true;
    }
    if (matched[2] === "revisions" && req.method === "POST") {
      if (!revisions) throw new HttpError(503, "result_storage_unavailable", "Result revision is unavailable.");
      sendJson(res, 201, { data: await revisions.stage(user.id, matched[1], await readJson(req, 32768)) }); return true;
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  };
}
