import { createHash } from 'node:crypto';
import { rsiBudgetAdmission, rsiCampaignMonth } from '../../../packages/domain/src/rsiCampaign.mjs';
import { ProductDocuments } from './productStore.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { assertRsiLabConfiguration } from './rsiLabConfiguration.mjs';
import { HttpError } from './security.mjs';

/** @param {unknown} value */
function identity(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw new HttpError(400, 'campaign_budget_identity_invalid', 'Invalid budget identity.'); return value; }
/** @param {unknown} value */
function cost(value) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1e8))) throw new HttpError(400, 'campaign_budget_unknown', 'A finite nonnegative cost is required.'); return value; }
/** @param {number} value */
function currencyPrecision(value) { if (Math.abs(value * 1e8 - Math.round(value * 1e8)) > Math.max(1e-7, value * 1e8 * Number.EPSILON * 2)) throw new HttpError(400, 'campaign_budget_unknown', 'Spending limits and reservations require 1e-8 CNY precision.'); }
/** @param {string} campaignId @param {string} stageKey */
const recordId = (campaignId, stageKey) => `rsi-budget:${createHash('sha256').update(JSON.stringify([campaignId, stageKey])).digest('hex')}`;

/** A lab-account ledger. Every mutation serializes across campaigns and writes normal product revisions. */
export class RsiCampaignBudget {
  /** @param {{database:any,configuration:any,now?:()=>string}} options */
  constructor({ database, configuration, now = () => new Date().toISOString() }) {
    this.configuration = structuredClone(assertRsiLabConfiguration(configuration));
    this.database = database; this.documents = new ProductDocuments(database); this.owner = configuration.authority.accountId; this.now = now;
  }
  /** @param {(client:any)=>Promise<any>} operation */
  async transaction(operation) {
    await migrateProductStore(this.database);
    return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rsi-budget:${this.owner}`]);
      return operation(client);
    });
  }
  /** @param {any} client @param {string} id */
  async read(client, id) {
    const result = await client.query("SELECT payload,revision,deleted_at FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2 FOR UPDATE", [this.owner, id]);
    if (result.rows[0]?.deleted_at) throw new HttpError(409, 'campaign_budget_record_deleted', 'A budget record cannot be reset by deletion.');
    return result.rows[0] ?? null;
  }
  /** @param {any} client @param {string} id @param {any} payload @param {number} revision */
  async write(client, id, payload, revision) { await this.documents.put(this.owner, 'knowledge', id, payload, { expectedRevision: revision, transactionClient: client }); }
  /** Reserve an upper bound for one provider request, including its failed outcome. Retries need distinct stage keys.
   * @param {{campaignId:string,stageKey:string,amountCny:number,limits?:{campaignCny:number,monthCny:number}}} input */
  async reserve({ campaignId, stageKey, amountCny, limits = this.configuration.budget }) {
    identity(campaignId); identity(stageKey); cost(amountCny); currencyPrecision(amountCny);
    for (const key of ['campaignCny','monthCny']) { cost(limits?.[key]); currencyPrecision(limits[key]); if (limits[key] <= 0) throw new HttpError(400, 'campaign_budget_unknown', 'Limits must be positive.'); }
    if (amountCny <= 0) throw new HttpError(400, 'campaign_budget_unknown', 'Reservation must be positive.');
    const effective = { campaignCny: Math.min(limits.campaignCny, this.configuration.budget.campaignCny), monthCny: Math.min(limits.monthCny, this.configuration.budget.monthCny) };
    return this.transaction(async client => {
      const id = recordId(campaignId, stageKey), existing = await this.read(client, id);
      if (existing) {
        if (existing.payload.reservedCny !== amountCny || existing.payload.requestedLimits.campaignCny !== limits.campaignCny || existing.payload.requestedLimits.monthCny !== limits.monthCny) throw new HttpError(409, 'campaign_budget_idempotency_conflict', 'Reservation identity has a different amount or limit.');
        return this.authority(client, existing.payload);
      }
      const requestedLimits = {...limits};
      const admittedAt = this.now(), month = rsiCampaignMonth(admittedAt);
      const result = await client.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='rsi-budget-reservation'", [this.owner]);
      const totals = {campaignActualCny:0,campaignReservedCny:0,monthActualCny:0,monthReservedCny:0,requestCny:amountCny};
      for (const {payload: row} of result.rows) {
        const actual = row.actualCny ?? 0, reserved = row.state === 'settled' ? 0 : row.reservedCny;
        if (row.campaignId === campaignId) { totals.campaignActualCny += actual; totals.campaignReservedCny += reserved; effective.campaignCny = Math.min(effective.campaignCny, row.limits.campaignCny); }
        if (row.month === month) { totals.monthActualCny += actual; totals.monthReservedCny += reserved; effective.monthCny = Math.min(effective.monthCny, row.limits.monthCny); }
      }
      const admission = rsiBudgetAdmission(totals, effective);
      if (!admission.admitted) return { authorized:false, reason:admission.reason };
      const payload = {recordType:'rsi-budget-reservation',campaignId,stageKey,reservedCny:amountCny,actualCny:null,state:'reserved',outcome:null,admittedAt,month,requestedLimits,limits:effective};
      await this.write(client, id, payload, 0);
      return this.authority(client, payload);
    });
  }
  /** Revalidate a hold against all current liabilities under the same account lock. Own hold becomes the request once.
   * @param {any} client @param {any} row */
  async authority(client, row) {
    const current = rsiCampaignMonth(this.now()) === row.month;
    if (!current || row.state !== 'reserved') return {...row, authorized:false, reason:!current ? 'campaign_budget_month_expired' : 'campaign_budget_already_dispatched'};
    const limits = {campaignCny:Math.min(row.limits.campaignCny,this.configuration.budget.campaignCny),monthCny:Math.min(row.limits.monthCny,this.configuration.budget.monthCny)};
    const totals = {campaignActualCny:0,campaignReservedCny:0,monthActualCny:0,monthReservedCny:0,requestCny:row.reservedCny};
    const result = await client.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='rsi-budget-reservation'",[this.owner]);
    for (const {payload: other} of result.rows) {
      if (other.campaignId === row.campaignId) limits.campaignCny = Math.min(limits.campaignCny,other.limits.campaignCny);
      if (other.month === row.month) limits.monthCny = Math.min(limits.monthCny,other.limits.monthCny);
      if (other.campaignId === row.campaignId && other.stageKey === row.stageKey) continue;
      const actual=other.actualCny ?? 0, reserved=other.state === 'settled' ? 0 : other.reservedCny;
      if (other.campaignId === row.campaignId) { totals.campaignActualCny += actual; totals.campaignReservedCny += reserved; }
      if (other.month === row.month) { totals.monthActualCny += actual; totals.monthReservedCny += reserved; }
    }
    const admission = rsiBudgetAdmission(totals,limits);
    return {...row,authorized:admission.admitted,reason:admission.reason};
  }
  /** Atomically consume fresh spending authority immediately before a provider step. @param {{campaignId:string,stageKey:string}} input */
  async beginSpend({campaignId,stageKey}) {
    identity(campaignId); identity(stageKey);
    return this.transaction(async client => {
      const id = recordId(campaignId,stageKey), row = await this.read(client,id);
      if (!row) return {authorized:false,reason:'campaign_budget_reservation_missing'};
      const authority = await this.authority(client, row.payload);
      if (!authority.authorized) return authority;
      await this.write(client,id,{...row.payload,state:'in-flight',dispatchedAt:this.now()},row.revision);
      return {...authority,state:'in-flight'};
    });
  }
  /** Unknown or interrupted calls retain their reservation. Actual overruns are recorded honestly and block future admission.
   * @param {{campaignId:string,stageKey:string,actualCny:number|null,outcome:'success'|'failed'|'unknown'}} input */
  async settle({campaignId,stageKey,actualCny,outcome}) {
    identity(campaignId); identity(stageKey);
    if (!['success','failed','unknown'].includes(outcome) || (outcome === 'unknown' ? actualCny !== null : actualCny === null)) throw new HttpError(400,'campaign_budget_settlement_invalid','A known outcome requires actual cost.');
    if (actualCny !== null) cost(actualCny);
    return this.transaction(async client => {
      const id=recordId(campaignId,stageKey),row=await this.read(client,id);
      if (!row) throw new HttpError(409,'campaign_budget_reservation_missing','Reserve before spending.');
      if (row.payload.state === 'settled') {
        if (row.payload.actualCny !== actualCny || row.payload.outcome !== outcome) throw new HttpError(409,'campaign_budget_settlement_conflict','Settlement already recorded.');
        return this.authority(client, row.payload);
      }
      const payload={...row.payload,actualCny,outcome,state:outcome==='unknown'?'uncertain':'settled',settledAt:this.now()};
      await this.write(client,id,payload,row.revision);
      return this.authority(client, payload);
    });
  }
}
