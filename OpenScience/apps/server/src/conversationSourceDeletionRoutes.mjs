import { HttpError, sendJson } from './security.mjs';

/** The signed-in owner deletes one source conversation; guessed foreign ids never reveal its header. */
export function createConversationSourceDeletionRoutes({ store, service }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://evimed.local');
    const match = /^\/api\/projects\/([^/]+)\/conversations\/([^/]+)\/source$/.exec(url.pathname);
    if (!match) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    let projectId, sessionId;
    try { projectId = decodeURIComponent(match[1]); sessionId = decodeURIComponent(match[2]); } catch { throw new HttpError(400, 'invalid_request', 'Invalid conversation path.'); }
    const project = await store.requireProject(user, projectId);
    if (project.userId !== user.id) throw new HttpError(404, 'runtime_session_not_found', 'Conversation not found.');
    if (!service) throw new HttpError(503, 'source_deletion_unavailable', 'Conversation deletion is unavailable.');
    let data;
    if (req.method === 'DELETE') data = await service.request(project, sessionId);
    else if (req.method === 'GET') data = await service.status(project, sessionId);
    else throw new HttpError(405, 'method_not_allowed', 'Use DELETE or GET.');
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, data.cleanup === 'pending' ? 202 : 200, { data });
    return true;
  };
}
