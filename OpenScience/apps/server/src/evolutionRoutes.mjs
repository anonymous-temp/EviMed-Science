import { HttpError, readJson, sendJson } from './security.mjs';
/** @param {any} dependencies */
export function createEvolutionRoutes({ store, service, decisions, worker, config = {}, isOperator, registerEvaluationPolicy, evaluationAudit, adoptOpportunity, evidenceRegistration, capabilityMap = null, maxJsonBytes = 262144 }) {
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
    if (req.method === 'GET' && url.pathname === '/api/evolution/opportunities') {
      const projectId = url.searchParams.get('projectId'); await store.requireProject(user, projectId);
      sendJson(res, 200, { data: (await service.opportunities(user.id)).filter((/** @type {any} */ row) => row.payload.projectId === projectId) }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/evolution/opportunities/adopt') {
      const input = await readJson(req, maxJsonBytes); await store.requireProject(user, input.projectId);
      const opportunity = await service.get(input.opportunityId, user.id);
      if (!opportunity || opportunity.payload.projectId !== input.projectId) throw new HttpError(404, 'evolution_opportunity_missing', 'Opportunity not found.');
      sendJson(res, 200, { data: await service.withLock(`adopt:${user.id}:${opportunity.id}`, () => adoptOpportunity(user, input)) }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/evolution/capability-map') {
      const map = capabilityMap ? await capabilityMap() : null;
      sendJson(res,200,{data:map ? {cells:map.cells.map(cell=>({id:cell.id,capabilityId:cell.capabilityId,version:cell.version,taskFamily:cell.taskFamily,status:cell.status,dependencies:cell.dependencies,demand:cell.demand,newThisMonth:cell.newThisMonth===true})),counts:map.counts,derivedAt:map.derivedAt} : null}); return true;
    }
    if (!await isOperator(user)) throw new HttpError(403, 'evolution_operator_required', 'Evolution is available to operators only.');
    if (!service || config.evolutionEnabled !== true) throw new HttpError(404, 'evolution_disabled', 'Evolution is disabled.');
    let parts;
    try { parts = url.pathname.slice('/api/evolution'.length).split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, 'evolution_path_invalid', 'Invalid evolution path.'); }
    const reply = (/** @type {any} */ data) => { sendJson(res, 200, { data }); return true; };
    if (req.method === 'GET' && (!parts.length || parts[0] === 'status')) return reply(worker?.status() ?? { enabled: true });
    if (req.method === 'GET' && parts[0] === 'tools') return reply(await service.availableTools({}));
    if (req.method === 'POST' && parts[0] === 'tools' && parts.length === 3 && parts[2] === 'provenance') return reply(await evidenceRegistration.registerToolProvenance(user, { ...await readJson(req, maxJsonBytes), toolId: parts[1] }));
    if (req.method === 'GET' && parts[0] === 'missions') return reply(await service.list('mission'));
    if (req.method === 'GET' && parts[0] === 'verdicts') return reply(await service.list('candidate-verdict'));
    if (req.method === 'GET' && parts[0] === 'policies') return reply(await service.list('policy'));
    if (req.method === 'GET' && parts[0] === 'dossiers') return reply(await service.dossiers());
    if (req.method === 'GET' && parts[0] === 'opportunities') return reply(await service.opportunities(user.id));
    if (req.method === 'GET' && parts[0] === 'decisions' && parts.length === 2) return reply(await service.get(parts[1]));
    if (req.method === 'GET' && parts[0] === 'decisions') return reply(await service.list('decision'));
    if (req.method === 'GET' && parts[0] === 'evaluation-audit') return reply(await evaluationAudit(user, { projectId: url.searchParams.get('projectId') }));
    if (req.method === 'POST' && parts[0] === 'evaluations' && parts[1] === 'import-existing-methods' && parts.length === 2) {
      const input = await readJson(req, maxJsonBytes);
      if (typeof input?.methodId !== 'string' || input.methodId.length > 100 || !/^(meta-reml-published-data|mr-ivw-published-data|faers-ror-published-data)(?:-v[0-9]+)?$/.test(input.methodId)
        || !/^[a-f0-9]{64}$/.test(input?.reportHash ?? '') || Object.keys(input).some(key => !['methodId', 'reportHash'].includes(key))) throw new HttpError(400, 'evolution_evaluation_invalid', 'Select a frozen method identity and operator receipt hash.');
      return reply(await service.enqueue('evaluate', { action: 'import-existing-methods', methodId: input.methodId, reportHash: input.reportHash }, `import-existing-methods:${input.methodId}:${input.reportHash}`));
    }
    if (req.method === 'POST' && parts[0] === 'prospective' && parts.length === 3 && parts[2] === 'score') {
      const registration = await service.get(parts[1]);
      if (!registration || registration.payload.registrationEligible !== true) throw new HttpError(400, 'evolution_evaluation_invalid', 'Verified prospective registration is required.');
      return reply(await service.enqueue('evaluate', { action: 'prospective-score', registrationId: registration.id }, `prospective-manual-score:${registration.id}:${registration.revision}:${service.now().toISOString().slice(0,10)}`));
    }
    if (req.method === 'POST' && parts[0] === 'prospective' && parts[1] === 'verify-target') return reply(await evidenceRegistration.verifyTarget(user, await readJson(req, maxJsonBytes)));
    if (req.method === 'POST' && parts[0] === 'prospective' && parts[1] === 'register') return reply(await evidenceRegistration.registerProspective(user, await readJson(req, maxJsonBytes)));
    if (req.method === 'POST' && parts[0] === 'meta-update' && parts[1] === 'register') return reply(await evidenceRegistration.registerMetaUpdate(user, await readJson(req, maxJsonBytes)));
    if (req.method === 'POST' && parts[0] === 'evaluation-policy') return reply(await registerEvaluationPolicy(user, await readJson(req, maxJsonBytes)));
    if (req.method === 'POST' && parts[0] === 'decisions' && parts.length === 3 && parts[2] === 'resolve') return reply(await decisions.resolve(parts[1], await readJson(req, maxJsonBytes)));
    throw new HttpError(404, 'evolution_route_missing', 'Unknown evolution operation.');
  };
}
