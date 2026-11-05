import { trustedEvolutionNativeName } from './evolutionToolRouting.mjs';
import { createHash } from 'node:crypto';
import { EVOLUTION_TRACKS, EVOLUTION_GAP_CODES, evolutionToolVisible, evolutionDataMatch } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { EVOLUTION_PROJECT_ID } from './internalProjects.mjs';
import { evolutionAccountFloors } from './evolutionAccountClasses.mjs';
import { evolutionRetainUntil } from './evolutionRetention.mjs';

/** @param {any} value */
export function evolutionKey(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32); }
/** Event types read again after they are processed (`EvolutionIntegration.consume` for `tool-ready`). */
const EVOLUTION_LATER_READ_EVENT_TYPES = Object.freeze(['dataset-ready', 'tool-ready']);
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
  /** Serialize invariants on the owned transaction client. External lifecycle steps explicitly preserve their recovery journal on failure.
   * @param {string} key @param {()=>Promise<any>} operation @param {{preserveProgress?:boolean}} [options] */
  async withLock(key, operation, {preserveProgress=false}={}) {
    if (!this.documents.database) return operation();
    let failure;
    const result=await this.documents.database.transaction(async (/** @type {any} */ client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-evolution:${key}`]);
      const work=async()=>{try{return await operation();}catch(error){if(!preserveProgress)throw error;failure=error;return null;}};
      return this.documents.database.withTransactionClient ? this.documents.database.withTransactionClient(client,work) : work();
    });
    if(failure)throw failure;
    return result;
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
  /** The journal acknowledges only completed side effects. Old complete/deferral records remain retryable.
   * One action runs at a time: its advisory lock is held by a transaction that writes nothing, on a connection of its own, and the
   * action runs outside it (and outside any transaction of the caller). A lifecycle step of the action (`retire`, `restoreReview`)
   * therefore commits the progress it must keep in its own transaction: nested in this one it was a savepoint, and a failure after a
   * pin had changed on disk rolled the ledger record of that change back with the rest.
   * @param {any} action @param {()=>Promise<any>} operation */
  async executeDecisionAction(action, operation) {
    const id = `evolution-action-${evolutionKey(action.actionId)}`;
    const run = async () => {
      const prior = await this.get(id);
      if (prior?.payload.status === 'complete' && prior.payload.result?.status !== 'deferred') return prior.payload.result;
      const result = await operation();
      await this.save('action', id, { actionId: action.actionId, status: result?.status === 'deferred' ? 'deferred' : 'complete', result }, prior);
      return result;
    };
    const database = this.documents.database;
    if (!database) return run();
    const outside = (/** @type {() => Promise<any>} */ work) => typeof database.withoutTransactionClient === 'function' ? database.withoutTransactionClient(work) : work();
    return outside(() => database.transaction(async (/** @type {any} */ client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-evolution:action:${action.actionId}`]);
      return run();
    }));
  }
  /**
   * What a researcher's run could not do, kept for the offline lab (`scripts/ops/rsi-signals-export.mjs`): a closed code, never their prose. One lead per code, read by the lab as
   * its occurrences in a window: one row per lead, account and event, dated for retention (`evolutionRetention.mjs`). How often a lead recurs is a counter on it, written without
   * a revision (`telemetry`): a repeat is use, not a new version of the lead.
   * @param {any} input
   */
  async addLead(input) {
    if (!EVOLUTION_TRACKS.includes(input.track) || !['runtime-failure', 'autopilot'].includes(input.source) || !EVOLUTION_GAP_CODES.includes(input.gapCode)) throw new HttpError(400, 'evolution_lead_invalid', 'Unknown evolution lead vocabulary.');
    const payload = { track: input.track, source: input.source, gapCode: input.gapCode, code: EVOLUTION_GAP_CODES.includes(input.code) ? input.code : input.gapCode };
    const id = evolutionLeadId(payload);
    return this.withLock(`lead:${id}`, async () => {
      const occurrenceId = `evolution-lead-occurrence-${evolutionKey([id, input.userId, input.sourceEventId])}`;
      const seen = await this.get(occurrenceId, input.userId);
      const prior = await this.get(id);
      if (seen && prior) return prior;
      if (!seen) await this.save('lead-occurrence', occurrenceId, { leadId: id, eventId: input.sourceEventId, projectId: input.projectId ?? EVOLUTION_PROJECT_ID,
        at: this.now().toISOString(), scope: 'owner', retainUntil: evolutionRetainUntil(this.config, this.now()) }, null, input.userId);
      // Researchers and operators are counted apart, each against its own floor (`evolutionAccountClasses.mjs`).
      const operators = [...new Set((this.config.operatorUsers ?? []).map(String).filter(Boolean))];
      let distinctAccounts, operatorAccounts;
      if (this.documents.database) {
        const aggregate = await this.documents.database.query("SELECT count(DISTINCT user_id)::integer AS accounts, count(DISTINCT user_id) FILTER (WHERE user_id=ANY($2::text[]))::integer AS operators FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-lead-occurrence' AND payload->>'scope'='owner' AND payload->>'leadId'=$1", [id, operators]);
        distinctAccounts = Number(aggregate.rows[0]?.accounts ?? 0);
        operatorAccounts = Number(aggregate.rows[0]?.operators ?? 0);
      } else {
        // The in-memory test store may supply a metadata-only count reader.
        distinctAccounts = await this.callbacks.leadAccountCount?.(id) ?? Math.max(Number(prior?.payload.distinctAccounts ?? 0), 1);
        operatorAccounts = operators.includes(String(input.userId)) ? Math.min(1, distinctAccounts) : 0;
      }
      const userAccounts = distinctAccounts - operatorAccounts;
      const floors = evolutionAccountFloors(this.config);
      const next = { ...payload, createdAt: prior?.payload.createdAt ?? this.now().toISOString(), firstSeenAt: prior?.payload.firstSeenAt ?? this.now().toISOString(), lastSeenAt: this.now().toISOString(),
        occurrences: Number(prior?.payload.occurrences ?? 0) + Number(!seen), distinctAccounts, ...(operatorAccounts ? { operatorAccounts, userAccounts } : {}),
        status: userAccounts >= floors.user || operatorAccounts >= floors.operator ? 'queued' : 'accumulating', recordType: 'evolution-lead' };
      const reached = !prior || next.distinctAccounts !== prior.payload.distinctAccounts || next.status !== prior.payload.status;
      return this.documents.put(await this.owner(), 'knowledge', id, next, { expectedRevision: prior?.revision ?? 0, projectId: EVOLUTION_PROJECT_ID, ...(reached ? {} : { telemetry: true }) });
    });
  }

  /** @param {any} event @param {{runAfter?:Date}} [options] */
  async ingestEvent(event, { runAfter = this.now() } = {}) {
    if (!event.id || !event.type) throw new HttpError(400, 'evolution_event_invalid', 'An event needs its identity and type.');
    // Tenant payloads stay in tenant-owned event records; the shared lead is separately reduced to closed codes.
    // An event of a type nothing reads again carries when it may go (`evolutionRetention.mjs`); a `dataset-ready` is read until a newer revision of its dataset replaces it.
    const id = `evolution-event-${evolutionKey([event.id, event.type, event.userId ?? null])}`;
    const owner = event.userId ?? await this.owner();
    const saved=await this.withLock(`event:${owner}:${id}`,async()=>{
      const prior=await this.get(id,owner);
      return prior??this.save('event',id,{...event,createdAt:this.now().toISOString(),status:'queued',...(EVOLUTION_LATER_READ_EVENT_TYPES.includes(event.type)?{}:{retainUntil:evolutionRetainUntil(this.config,this.now())})},null,owner);
    });
    if(saved.payload.status==='queued')await this.enqueue('event',{eventId:id,eventOwnerId:owner},id,runAfter);
    return saved;
  }
  /** Recover a persisted event whose enqueue was interrupted, without reading tenant prose. */
  async reconcileQueued() {
    if (!this.documents.database) return { recovered: 0 };
    const owner = await this.owner();
    const missing = await this.documents.database.query("SELECT id,user_id FROM evimed_product.documents d WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'status'='queued' AND payload->>'recordType'='evolution-event' AND NOT EXISTS(SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=$1 AND j.idempotency_key='evolution:'||d.id) ORDER BY created_at,id LIMIT 100", [owner]);
    for (const row of missing.rows) await this.enqueue('event', { eventId: row.id, eventOwnerId: row.user_id }, row.id);
    return { recovered: missing.rows.length };
  }
  async dossiers() { return this.list('dossier'); }
  async tools() { return this.list('tool'); }
  /** @param {any} agenda @returns {Promise<any[]>} */
  async availableTools(agenda = {}) { return (await this.tools()).filter((row) => evolutionToolVisible(row.payload) && (!agenda.track || row.payload.track === agenda.track)
    && (!agenda.capabilityId || row.payload.capabilityIds?.includes(agenda.capabilityId))).map((row) => ({ id: row.id, ...(trustedEvolutionNativeName(row.payload) ? {nativeName:trustedEvolutionNativeName(row.payload)} : {}), papers: evolutionPublicPapers(row.payload.lineage?.papers ?? row.payload.papers), ...Object.fromEntries(['name', 'description', 'track', 'capabilityIds', 'toolKind', 'validationLevel', 'dataLevel', 'dataRequirements', 'status', 'maintenanceState', 'entrypoint', 'publicationKind', 'artifactDigest', 'usage', 'whenToUse'].filter((key) => row.payload[key] !== undefined).map((key) => [key, row.payload[key]])) })); }
  /**
   * Only the latest `dataset-ready` of a dataset is read again (`tool-ready`, by `createdAt`): the ones it replaces are dated for retention, and only those, whichever order
   * their jobs finish in. One whose job has not finished may be dated too: the pass deletes only what is processed. @param {any} event
   */
  async retireEarlierDatasetEvents(event) {
    for (const row of await this.list('event', event.userId, { type: 'dataset-ready', datasetId: event.datasetId })) {
      if (row.payload.projectId !== event.projectId || row.payload.retainUntil || !(String(row.payload.createdAt) < String(event.createdAt))) continue;
      await this.save('event', row.id, { ...row.payload, retainUntil: evolutionRetainUntil(this.config, this.now()) }, row, event.userId);
    }
  }
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
        // An already published tool on the researcher's own dataset; the wait is resolved when it completes.
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
}
/** @param {any} dependencies */
export function createEvolutionService(dependencies) { return new EvolutionService(dependencies); }
