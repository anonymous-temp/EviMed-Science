import { createHash } from 'node:crypto';
import { EVOLUTION_TRACKS, EVOLUTION_GAP_CODES } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { EVOLUTION_PROJECT_ID } from './internalProjects.mjs';
import { evolutionAccountFloors } from './evolutionAccountClasses.mjs';
import { evolutionRetainUntil } from './evolutionRetention.mjs';

/** @param {any} value */
export function evolutionKey(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32); }
/** The record id of a lead: its content, so the same lead from anywhere is one. @param {any} payload */
export function evolutionLeadId(payload) { return `evolution-lead-${evolutionKey(payload)}`; }

/**
 * The closed-code signal store of 循证进化 (what `scripts/ops/rsi-signals-export.mjs` reads): signals, their summaries, leads and the prediction registry's filings are
 * documents of the one revision ledger, kept under the operator's internal project. This is what is left of the service that also hosted published tools; it knows no
 * tool, event, job or decision. Rows written by that service stay in the ledger and are read by nothing but the retention pass.
 */
export class EvolutionLedger {
  /** @param {{documents:any, ownerId?:string|null, ensureOwner?:(()=>Promise<string>)|null, config?:any, now?:()=>Date}} dependencies */
  constructor({ documents, ownerId = null, ensureOwner = null, config = {}, now = () => new Date() }) {
    this.documents = documents; this.ownerId = ownerId; this.ensureOwner = ensureOwner; this.config = config; this.now = now;
  }
  /** Serialize invariants on the owned transaction client.
   * @param {string} key @param {()=>Promise<any>} operation */
  async withLock(key, operation) {
    if (!this.documents.database) return operation();
    return this.documents.database.transaction(async (/** @type {any} */ client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-evolution:${key}`]);
      return this.documents.database.withTransactionClient ? this.documents.database.withTransactionClient(client, operation) : operation();
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
        // The in-memory test store has no aggregate: one account is all it can tell.
        distinctAccounts = Math.max(Number(prior?.payload.distinctAccounts ?? 0), 1);
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
}
