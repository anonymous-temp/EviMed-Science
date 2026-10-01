import { HttpError, readJson, sendJson } from './security.mjs';
/** This route is platform-wide, including deployments without VCR. */
export function createDocumentExportRoutes({ store, service }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/document-exports')) return false;
    const user = await store.ensureUser(req, res);
    if (!service) throw new HttpError(503, 'document_export_unavailable', 'Document conversion is unavailable.');
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[2];
    if (parts.length === 2 && req.method === 'POST') sendJson(res, 202, { data: await service.request(user, await readJson(req, 16384)) });
    else if (parts.length === 3 && req.method === 'GET') sendJson(res, 200, { data: await service.status(user, id) });
    else if (parts.length === 4 && parts[3] === 'cancel' && req.method === 'POST') sendJson(res, 200, { data: await service.cancel(user, id) });
    else if (parts.length === 4 && parts[3] === 'retry' && req.method === 'POST') {
      const body = await readJson(req, 1024);
      if (Object.keys(body).some(key => key !== 'format')) throw new HttpError(400, 'document_export_request_invalid', 'Invalid retry request.');
      sendJson(res, 202, { data: await service.retry(user, id, body.format) });
    } else if (parts.length === 5 && parts[3] === 'download' && req.method === 'GET') {
      const file = await service.download(user, id, parts[4]);
      res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(file.bytes);
    } else throw new HttpError(404, 'document_export_unavailable', 'The document is unavailable.');
    return true;
  };
}
