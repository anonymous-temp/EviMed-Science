import { HttpError, sendJson } from './security.mjs';
import { searchTopicsQuery } from './searchTopicsRuntime.mjs';

/** Only an authenticated project reader can invoke that project's installed topic plugin. */
export function createSearchTopicsRoutes(/** @type {{store:any, runtimeManager:any, ensureCurrent?:()=>Promise<any>}} */ { store, runtimeManager, ensureCurrent }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? '/', 'http://evimed.local');
    const match = /^\/api\/projects\/([^/]+)\/evimed-search\/topics$/.exec(url.pathname);
    if (!match) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Topic recommendations require GET.');
    const query = searchTopicsQuery(url.searchParams);
    let projectId;
    try { projectId = decodeURIComponent(match[1]); } catch { throw new HttpError(400, 'invalid_request', 'Invalid project path.'); }
    const project = await store.requireProject(user, projectId);
    let publication = await ensureCurrent?.();
    let data = await runtimeManager.searchTopicsFor(project, query);
    if (publication) {
      const matches = () => data.source?.kind === 'provider' && data.source.isExample === false
        && data.recommendation?.generatedAt === publication.generatedAt && data.recommendation?.corpusVersion === publication.corpusVersion;
      // A second process may publish between the producer and native read. Retry once instead of mixing generations.
      if (!matches()) { publication = await ensureCurrent(); data = await runtimeManager.searchTopicsFor(project, query); }
      if (!matches()) throw new HttpError(503, 'evimed_search_topics_unavailable', 'Search topic recommendations are temporarily unavailable.');
      data.recommendation = { ...data.recommendation, stale: publication.stale };
    }
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { data });
    return true;
  };
}
