import { trustedEvolutionNativeName } from './evolutionToolRouting.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, EVOLUTION_TRACKS, EVOLUTION_TOOL_STATES, EVOLUTION_DATA_LEVELS, EVOLUTION_GAP_CODES, EVOLUTION_LEAD_SOURCES, evolutionMethodFields, evolutionValidationLevel, evolutionToolVisible, evolutionDataMatch, validateEvolutionDataRequirements } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { EVOLUTION_PROJECT_ID } from './internalProjects.mjs';
import { MODULE_LEAD_SOURCES, moduleLeadPayload } from './evolutionLeadSources.mjs';

/** @param {any} value */
export function evolutionKey(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32); }
/** The record id of a lead: its content, so the same lead from anywhere is one. @param {any} payload */
export function evolutionLeadId(payload) { return `evolution-lead-${evolutionKey(payload)}`; }
/** Public paper identities only; candidate URLs and private provenance never cross this projection. @param {any} papers */
export function evolutionPublicPapers(papers) {
  const result = new Map();
  for (const paper of Array.isArray(papers) ? papers : []) {
    const record = typeof paper === 'string' ? { id: paper } : paper ?? {};
    const raw = String(record.doi ?? record.pmid ?? record.pmcid ?? record.id ?? record.identifier ?? '').trim();
    const doi = raw.replace(/^doi:/i, '');
    const pmid = raw.replace(/^pmid:/i, '');
    const pmcid = raw.replace(/^pmcid:/i, '').toUpperCase();
    const id = /^10\.\d{4,9}\/[^\s<>]+$/.test(doi) ? doi : /^\d+$/.test(pmid) ? pmid : /^PMC\d+$/.test(pmcid) ? pmcid : null;
    if (!id) continue;
    const url = id.startsWith('10.') ? `https://doi.org/${encodeURI(id)}` : id.startsWith('PMC') ? `https://pmc.ncbi.nlm.nih.gov/articles/${id}/` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
    result.set(id, { id, title: typeof record.title === 'string' ? record.title : id, url });
  }
  return [...result.values()];
}
/** Platform records share the existing revision ledger, under the operator's internal project. */
export class EvolutionService {
  /** @param {any} dependencies */
  constructor({ documents, jobs, ownerId = null, ensureOwner = null, config = {}, now = () => new Date(), callbacks = {}, notifications = null }) {
    this.documents = documents; this.jobs = jobs; this.ownerId = ownerId; this.ensureOwner = ensureOwner; this.config = config; this.now = now; this.callbacks = callbacks; this.notifications = notifications;
  }
  /** Serialize module-wide invariants across API processes. @param {string} key @param {()=>Promise<any>} operation */
  async withLock(key, operation) {
    if (!this.documents.database) return operation();
    return this.documents.database.transaction(async (/** @type {any} */ client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-evolution:${key}`]);
      return operation();
    });
  }
  async owner() { return this.ownerId ?? (this.ownerId = await this.ensureOwner?.()); }
  /** @param {string} type @param {string|null} userId @param {Record<string, any>} [filter] payload fields the records must carry, to read a part of a large kind */
  async list(type, userId = null, filter = {}) {
    const owner = userId ?? await this.owner();
    if (!owner) return [];
    const items = [];
    let cursor = null;
    do { const page = await this.documents.list(owner, 'knowledge', { limit: 100, cursor, filter: { ...filter, recordType: `evolution-${type}` } }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
    return items;
  }
  /** @param {string} id @param {string|null} userId */
  async get(id, userId = null) { return this.documents.get(userId ?? await this.owner(), 'knowledge', id); }
  /** @param {string} type @param {string} id @param {any} payload @param {any} previous @param {string|null} userId */
  async save(type, id, payload, previous = null, userId = null) {
    try { return await this.documents.put(userId ?? await this.owner(), 'knowledge', id, { ...payload, recordType: `evolution-${type}` },
      { expectedRevision: previous?.revision ?? 0, projectId: payload.projectId ?? EVOLUTION_PROJECT_ID });
    } catch (error) {
      if (!previous && error?.code === 'product_revision_conflict') return this.get(id, userId);
      throw error;
    }
  }
  /** @param {string} action @param {any} payload @param {string} key @param {Date} runAfter */
  async enqueue(action, payload, key, runAfter = this.now()) {
    return this.jobs.enqueue(await this.owner(), `evolution-${action}`, payload, { idempotencyKey: `evolution:${key}`, projectId: EVOLUTION_PROJECT_ID,
      maxAttempts: Math.max(1, Math.min(10, this.config.evolutionMaxJobAttempts ?? 3)), runAfter });
  }
  /** The record id a lead with this payload has. @param {any} payload */
  leadId(payload) { return evolutionLeadId(payload); }
  /** Only closed operational codes cross the researcher's tenant boundary. @param {any} input */
  async addLead(input) {
    if (!EVOLUTION_TRACKS.includes(input.track) || !EVOLUTION_LEAD_SOURCES.includes(input.source) || !EVOLUTION_GAP_CODES.includes(input.gapCode)) throw new HttpError(400, 'evolution_lead_invalid', 'Unknown evolution lead vocabulary.');
    const privateSource = ['runtime-failure', 'autopilot', 'dataset', 'handbook'].includes(input.source);
    // The platform's own modules (flywheel F20): a closed code and closed entity keys, chosen from lists `evolutionLeadSources.mjs` owns.
    const payload = MODULE_LEAD_SOURCES.includes(input.source) ? moduleLeadPayload(input) : privateSource ? { track: input.track, source: input.source, gapCode: input.gapCode, code: EVOLUTION_GAP_CODES.includes(input.code) ? input.code : input.gapCode }
      : { track: input.track, source: input.source, gapCode: input.gapCode, method: input.method, papers: input.papers ?? [], features: input.features ?? {}, origin: input.origin ?? 'literature' };
    const id = evolutionLeadId(payload);
    const prior = await this.get(id);
    if (prior) { if (prior.payload.status === 'queued') await this.enqueue('scout', { leadId: id }, id); return prior; }
    const saved = await this.save('lead', id, { ...payload, createdAt: this.now().toISOString(), status: 'queued' });
    await this.enqueue('scout', { leadId: id }, id);
    return saved;
  }
  /** @param {any} event */
  async ingestEvent(event) {
    if (!event.id || !event.type) throw new HttpError(400, 'evolution_event_invalid', 'An event needs its identity and type.');
    // Tenant payloads stay in tenant-owned event records; the shared lead is separately reduced to closed codes.
    const id = `evolution-event-${evolutionKey([event.id, event.type, event.userId ?? null])}`;
    const owner = event.userId ?? await this.owner();
    const prior = await this.get(id, owner);
    if (prior) { if (prior.payload.status === 'queued') await this.enqueue('event', { eventId: id, eventOwnerId: owner }, id); return prior; }
    const saved = await this.save('event', id, { ...event, createdAt: this.now().toISOString(), status: 'queued' }, null, owner);
    await this.enqueue('event', { eventId: id, eventOwnerId: owner }, id);
    return saved;
  }
  /** Recover a persisted lead/event whose enqueue was interrupted, without reading tenant prose. */
  async reconcileQueued() {
    if (!this.documents.database) return { recovered: 0 };
    const owner = await this.owner();
    const missing = await this.documents.database.query("SELECT id,user_id,payload->>'recordType' AS record_type FROM evimed_product.documents d WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'status'='queued' AND payload->>'recordType'=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=$2 AND j.idempotency_key='evolution:'||d.id) ORDER BY created_at,id LIMIT 100", [['evolution-lead','evolution-event'], owner]);
    for (const row of missing.rows) await this.enqueue(row.record_type === 'evolution-lead' ? 'scout' : 'event', row.record_type === 'evolution-lead' ? { leadId: row.id } : { eventId: row.id, eventOwnerId: row.user_id }, row.id);
    return { recovered: missing.rows.length };
  }
  /** @param {any} input */
  async addDossier(input) { const id = input.id ?? `evolution-dossier-${randomUUID()}`; return this.save('dossier', id, { ...input, status: 'planned', createdAt: this.now().toISOString() }); }
  /** @param {string} id */
  async queueBuild(id) { const dossier = await this.get(id); if (!dossier) throw new HttpError(404, 'evolution_dossier_missing', 'Dossier not found.'); return this.enqueue('build', { dossierId: id }, `build:${id}:${dossier.revision}`); }
  /** @param {any} input */
  async registerTool(input) {
    if (!input.id || !EVOLUTION_TRACKS.includes(input.track) || !EVOLUTION_TOOL_STATES.includes(input.status ?? 'active') || !EVOLUTION_DATA_LEVELS.includes(input.dataLevel ?? 'D0')) throw new HttpError(400, 'evolution_tool_invalid', 'Invalid tool identity or track.');
    if (input.dataRequirements && validateEvolutionDataRequirements(input.dataRequirements).length) throw new HttpError(400, 'evolution_requirements_invalid', 'Invalid data requirements.');
    const existing = await this.get(input.id);
    if (existing) { if (canonicalJson([existing.payload.artifactDigest ?? null, existing.payload.entrypoint ?? null, existing.payload.publicationKind ?? null, existing.payload.dataRequirements ?? null, existing.payload.capabilityIds ?? null, existing.payload.track]) !== canonicalJson([input.artifactDigest ?? null, input.entrypoint ?? null, input.publicationKind ?? null, input.dataRequirements ?? null, input.capabilityIds ?? null, input.track])) throw new HttpError(409, 'evolution_version_immutable', 'A published version is immutable.'); return existing; }
    return this.save('tool', input.id, { ...input, ...evolutionMethodFields({ ...input, validationLevel: 'V0' }), assessments: [], createdAt: this.now().toISOString() });
  }
  /** Called only by the independently composed evaluator, never by public routes. @param {string} id @param {any} assessment */
  async recordAssessment(id, assessment) {
    const tool = await this.get(id);
    if (!tool || tool.payload.recordType !== 'evolution-tool') throw new HttpError(404, 'evolution_tool_missing', 'Tool not found.');
    if (assessment.independent !== true || !assessment.id) throw new HttpError(400, 'evolution_assessment_invalid', 'An independent assessment identity is required.');
    assessment = Object.fromEntries(['id', 'caseId', 'kind', 'papers', 'preRegistered', 'monteCarloError', 'passed', 'independent', 'exposed', 'retracted', 'crossImplementationPassed', 'failureIds', 'cycleId', 'at'].filter((key) => assessment[key] !== undefined).map((key) => [key, assessment[key]]));
    const assessments = [...tool.payload.assessments.filter((/** @type {any} */ a) => a.id !== assessment.id), assessment];
    const validationLevel = evolutionValidationLevel(assessments, tool.payload.usage);
    const saved = await this.save('tool', id, { ...tool.payload, assessments, validationLevel }, tool);
    if (tool.payload.validationLevel !== validationLevel) await this.resolveWaiters({ type: 'tool-ready', toolId: id });
    return saved;
  }
  async dossiers() { return this.list('dossier'); }
  async tools() { return this.list('tool'); }
  /** @param {string} userId */
  async opportunities(userId) { return this.list('opportunity', userId); }
  /** @param {any} agenda @returns {Promise<any[]>} */
  async availableTools(agenda = {}) { return (await this.tools()).filter((row) => evolutionToolVisible(row.payload) && (!agenda.track || row.payload.track === agenda.track)
    && (!agenda.capabilityId || row.payload.capabilityIds?.includes(agenda.capabilityId))).map((row) => ({ id: row.id, ...(trustedEvolutionNativeName(row.payload) ? {nativeName:trustedEvolutionNativeName(row.payload)} : {}), papers: evolutionPublicPapers(row.payload.lineage?.papers ?? row.payload.papers), ...Object.fromEntries(['name', 'description', 'track', 'capabilityIds', 'toolKind', 'validationLevel', 'dataLevel', 'dataRequirements', 'status', 'maintenanceState', 'entrypoint', 'publicationKind', 'artifactDigest', 'usage', 'whenToUse'].filter((key) => row.payload[key] !== undefined).map((key) => [key, row.payload[key]])) })); }
  /** @param {any} input */
  async waitFor(input) {
    const id = `evolution-waiter-${evolutionKey([input.userId, input.projectId, input.agendaId, input.sourceEpisodeId, input.capabilityId, input.methodId, input.toolId, input.requirementId])}`;
    const existing = await this.get(id, input.userId);
    if (existing) return existing;
    return this.save('waiter', id, { ...input, status: 'waiting' }, null, input.userId);
  }
  /** @param {any} event */
  async resolveWaiters(event) {
    const owners = event.userId ? [event.userId] : await this.callbacks.waiterOwners?.() ?? [];
    const resolved = [];
    for (const owner of owners) for (const row of await this.list('waiter', owner)) {
      const wait = row.payload;
      if (wait.status !== 'waiting' || (event.userId && wait.projectId !== event.projectId)) continue;
      const tool = event.type === 'tool-ready' ? await this.get(event.toolId) : null;
      const toolMatch = wait.kind === 'tool' && event.type === 'tool-ready' && tool && evolutionToolVisible(tool.payload) && (!wait.methodId || tool.payload.methodId === wait.methodId) && (!wait.capabilityId || tool.payload.capabilityIds?.includes(wait.capabilityId)) && (wait.toolId ? wait.toolId === event.toolId : Boolean(wait.capabilityId || wait.methodId));
      const dataMatch = event.type === 'dataset-ready' && Boolean(wait.dataRequirements) && (!event.requirementId || wait.requirementId === event.requirementId) && evolutionDataMatch(wait.dataRequirements, event.dataset).matched;
      if (!toolMatch && !dataMatch) continue;
      if (dataMatch) {
        const available = wait.toolId ? [await this.get(wait.toolId)] : (await this.tools()).filter(item => evolutionToolVisible(item.payload)
          && wait.capabilityId && item.payload.capabilityIds?.includes(wait.capabilityId)
          && evolutionDataMatch(item.payload.dataRequirements, event.dataset).matched);
        const matched = available.find(Boolean);
        if (!matched) continue;
        await this.enqueue('self-check', { userId: owner, projectId: wait.projectId, agendaId: wait.agendaId,
          waiterId: row.id, sourceEventId: event.id, toolId: matched.id, datasetId: event.datasetId }, `check:${row.id}:${event.id}:${matched.id}`);
        continue;
      }
      const woke = await this.wakeWait(row, owner, wait, event);
      if (!woke.woken) continue;
      resolved.push(await this.save('waiter', row.id, { ...wait, status: 'resolved', resolvedAt: this.now().toISOString(),
        ...(woke.deferred ? { wakeDeferred: woke.deferred } : {}) }, row, owner));
    }
    return resolved;
  }
  /**
   * One wait's wake is the agenda's business, and an agenda that cannot be woken cannot fail the platform's event
   * or the waits behind it: the failure is kept on its own wait as a closed code and the wait stays, to be tried at
   * the next event; an agenda that is gone closes its wait. An agenda the researcher holds back (it stopped reading,
   * it rejected the direction) keeps its wait too, and one refused for budget is woken, to continue on its schedule.
   * @param {any} row @param {string} owner @param {any} wait @param {any} event
   * @returns {Promise<{woken: boolean, deferred?: string}>}
   */
  async wakeWait(row, owner, wait, event) {
    let woke;
    try { woke = await this.callbacks.wakeAgenda?.({ ...wait, event }); }
    catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'evolution_wake_failed';
      const patch = error?.status === 404 ? { status: 'closed', closedReason: code, closedAt: this.now().toISOString() }
        : { wakeFailure: { code, at: this.now().toISOString(), count: Number(wait.wakeFailure?.count ?? 0) + 1 } };
      await this.save('waiter', row.id, { ...wait, ...patch }, row, owner).catch(() => null);
      return { woken: false };
    }
    if (woke?.closed) await this.save('waiter', row.id, { ...wait, status: 'closed', closedReason: woke.closed, closedAt: this.now().toISOString() }, row, owner).catch(() => null);
    if (woke === false || woke?.resumed === false) return { woken: false };
    return { woken: true, ...(woke?.deferred ? { deferred: woke.deferred } : {}) };
  }
  /** Dataset matching schedules a check; completed measurements annotate the resumed agenda without gating delivery. @param {any} input @param {any} result */
  async completeSelfCheck(input, result) {
    if (!input.waiterId || !(['passed','failed','inconclusive'].includes(result?.payload?.status)) || (result.payload.status !== 'passed' && result.payload.measurementCompleted !== true)) return { resumed: false };
    const row = await this.get(input.waiterId, input.userId);
    if (!row || row.projectId !== input.projectId || row.payload.status !== 'waiting') return { resumed: false };
    const wait = row.payload;
    const event = { id: input.sourceEventId, type: 'dataset-ready', userId: input.userId, projectId: input.projectId,
      datasetId: input.datasetId, toolId: input.toolId, selfCheckId: result.id, selfCheckStatus: result.payload.status };
    const woke = await this.wakeWait(row, input.userId, wait, event);
    if (!woke.woken) return { resumed: false };
    await this.save('waiter', row.id, { ...wait, status: 'resolved', resolvedAt: this.now().toISOString(), selfCheckId: result.id,
      ...(woke.deferred ? { wakeDeferred: woke.deferred } : {}) }, row, input.userId);
    return { resumed: true };
  }
  /** Failed approaches are immutable and wake only on new resources or methods. @param {any} input */
  async recordFailure(input) {
    if (!EVOLUTION_GAP_CODES.includes(input.gapCode)) throw new HttpError(400, 'evolution_failure_invalid', 'Unknown failure category.');
    const id = `evolution-failure-${evolutionKey([input.dossierId, input.version, input.gapCode, input.attemptedPaths])}`;
    const previous = await this.get(id);
    return previous ?? this.save('failure', id, { ...input, origin: 'tool-result', createdAt: this.now().toISOString(), status: 'waiting', wakeConditions: input.wakeConditions ?? ['new-method', 'new-data', 'new-tool', 'new-model'] });
  }
  /** @param {any} input */
  async addOpportunity(input) { return this.save('opportunity', input.id ?? `evolution-opportunity-${randomUUID()}`, { ...input, origin: 'platform-inference', createdAt: this.now().toISOString() }, null, input.userId); }
}
/** @param {any} dependencies */
export function createEvolutionService(dependencies) { return new EvolutionService(dependencies); }
