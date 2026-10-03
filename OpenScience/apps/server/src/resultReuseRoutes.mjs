import { HttpError, readJson, sendJson } from "./security.mjs";

export function createResultReuseRoutes({ store, exporter, revisions }) {
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
        "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(file.bytes); return true;
    }
    if (matched[2] === "revisions" && req.method === "POST") {
      if (!revisions) throw new HttpError(503, "result_storage_unavailable", "Result revision is unavailable.");
      sendJson(res, 201, { data: await revisions.stage(user.id, matched[1], await readJson(req, 32768)) }); return true;
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  };
}
