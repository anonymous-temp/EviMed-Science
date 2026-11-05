import { HttpError, readJson, sendJson } from './security.mjs';
/** The history reads and an operator's answer to a card. Experiments run offline, so a POST of theirs is an unknown operation.
 * @param {any} dependencies */
export function createEvolutionRoutes({ store, service, decisions, worker, config = {}, isOperator, capabilityMap = null, maxJsonBytes = 262144 }) {
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://evimed.local');
    if (url.pathname !== '/api/evolution' && !url.pathname.startsWith('/api/evolution/')) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service || config.evolutionEnabled !== true) throw new HttpError(404, 'evolution_disabled', 'Evolution is disabled.');

    if (req.method === 'GET' && url.pathname === '/api/evolution/project-tools') {
      const projectId = url.searchParams.get('projectId');
      await store.requireProject(user, projectId);
      sendJson(res, 200, { data: await service.availableTools({}) }); return true;
    }
    if (!await isOperator(user)) throw new HttpError(403, 'evolution_operator_required', 'Evolution is available to operators only.');
    // The capability map is the engine's own last model of what the platform could do, not a researcher's page: operators only, and read-only.
    if (req.method === 'GET' && url.pathname === '/api/evolution/capability-map') {
      const map = capabilityMap ? await capabilityMap() : null;
      sendJson(res,200,{data:map ? {cells:(map.cells ?? []).map(cell=>({id:cell.id,capabilityId:cell.capabilityId,version:cell.version,taskFamily:cell.taskFamily,status:cell.status,dependencies:cell.dependencies,demand:cell.demand,newThisMonth:cell.newThisMonth===true})),counts:map.counts,derivedAt:map.derivedAt} : null}); return true;
    }
    let parts;
    try { parts = url.pathname.slice('/api/evolution'.length).split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, 'evolution_path_invalid', 'Invalid evolution path.'); }
    const reply = (/** @type {any} */ data) => { sendJson(res, 200, { data }); return true; };
    if (req.method === 'GET' && (!parts.length || parts[0] === 'status')) return reply(worker?.status() ?? { enabled: true });
    if (req.method === 'GET' && parts[0] === 'tools') return reply(await service.availableTools({}));
    if (req.method === 'GET' && parts[0] === 'missions') return reply(await service.list('mission'));
    if (req.method === 'GET' && parts[0] === 'verdicts') return reply(await service.list('candidate-verdict'));
    if (req.method === 'GET' && parts[0] === 'policies') return reply(await service.list('policy'));
    if (req.method === 'GET' && parts[0] === 'dossiers') return reply(await service.dossiers());
    if (req.method === 'GET' && parts[0] === 'decisions' && parts.length === 2) {
      const row = await service.get(parts[1]);
      return reply(row ? { ...row, dueOutcome: await decisions.dueOutcome(row) } : row);
    }
    if (req.method === 'GET' && parts[0] === 'decisions') return reply(await service.list('decision'));
    if (req.method === 'POST' && parts[0] === 'decisions' && parts.length === 3 && parts[2] === 'resolve') return reply(await decisions.resolve(parts[1], await readJson(req, maxJsonBytes)));
    throw new HttpError(404, 'evolution_route_missing', 'Unknown evolution operation.');
  };
}
