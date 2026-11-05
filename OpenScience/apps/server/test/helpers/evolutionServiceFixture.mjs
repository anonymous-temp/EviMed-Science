import { evolutionMethodFields } from '@evimed/domain';
import { EvolutionService } from '../../src/evolutionService.mjs';

/** The in-memory document, job and notice store the evolution tests share, with the two bounds the real
 * ledger has and a bare Map does not: optimistic concurrency on every write, and the 256 KiB record limit
 * (`productPersistence.mjs`). A double without them hid both halves of the maintenance finding: lost
 * updates, and a tool whose record grew until it could no longer be saved. */
export function evolutionServiceFixture({ maxRecordBytes = 256 * 1024 } = {}) {
  const rows = new Map(); const jobs = []; const notices = [];
  let time = new Date('2026-10-04T00:00:00Z');
  const documents = {
    async get(owner, kind, id) { return structuredClone(rows.get(`${owner}:${kind}:${id}`) ?? null); },
    async list(owner, kind, { filter }) { return { items: [...rows.entries()].filter(([key, row]) => key.startsWith(`${owner}:${kind}:`) && row.payload.recordType === filter.recordType).map(([, row]) => structuredClone(row)), nextCursor: null }; },
    async put(owner, kind, id, payload, { expectedRevision, projectId }) {
      const key = `${owner}:${kind}:${id}`; const old = rows.get(key);
      if ((old?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('CAS conflict'), { code: 'product_revision_conflict' });
      if (Buffer.byteLength(JSON.stringify(payload)) > maxRecordBytes) throw Object.assign(new Error('A product record exceeds 256 KiB.'), { code: 'product_document_too_large', status: 413 });
      const row = { id, payload: structuredClone(payload), projectId, revision: expectedRevision + 1, createdAt: old?.createdAt ?? time.toISOString(), updatedAt: time.toISOString() }; rows.set(key, row); return structuredClone(row);
    },
  };
  const service = new EvolutionService({ documents, ownerId: 'operator', now: () => time,
    jobs: { async enqueue(owner, kind, payload, options) { const existing = jobs.find((job) => job.key === options.idempotencyKey); if (existing) return existing; const job = { owner, kind, payload, key: options.idempotencyKey }; jobs.push(job); return job; } },
    notifications: { async create(owner, input) { const row = { id: `n${notices.length}`, owner, ...input }; notices.push(row); return row; } },
  });
  return { service, rows, jobs, notices, documents, advance(ms) { time = new Date(time.getTime() + ms); } };
}

/** A published tool as the ledger holds one: the method fields' defaults and no assessments, written the way serving's own tests write a record (`service.save`).
 * `registerTool` was the only other writer and went with the experiment engine. @param {EvolutionService} service @param {Record<string, any>} input */
export async function seedTool(service, input) {
  return service.save('tool', input.id, { ...input, ...evolutionMethodFields(input), assessments: [], createdAt: service.now().toISOString() });
}

/** A decision card as a digest or an expiry finds one: delivered or not, class B unless said, with two options serving can carry out. `extra` overrides any field.
 * @param {EvolutionService} service @param {string} id @param {Record<string, any>} [extra] */
export async function seedCard(service, id, extra = {}) {
  return service.save('decision', `evolution-decision-${id}`, { subjectId: id, category: 'research-direction', title: '选择研究方向', body: '已尝试两条路径', directional: true, attemptedPaths: ['first', 'second'],
    options: [{ id: 'go', label: '继续', operation: 'keep' }, { id: 'hold', label: '保留', operation: 'wait' }], recommended: 'go', conservative: 'hold',
    decisionClass: 'B', status: 'pending', createdAt: service.now().toISOString(), history: [], overridden: false, ...extra });
}

/** The fixture's keyed queue with the lease operations a worker uses; a job is due at its `runAfter`. @param {any} f @param {() => Date} [now] */
export function evolutionJobQueue(f, now = () => f.service.now()) {
  const enqueue = f.service.jobs.enqueue.bind(f.service.jobs);
  let sequence = 0;
  return {
    enqueue: async (/** @type {any[]} */ ...args) => { const job = await enqueue(...args); job.runAfter ??= args[3]?.runAfter ?? null; job.state ??= 'queued'; return job; },
    claim: async (/** @type {string[]} */ kinds) => {
      const job = f.jobs.find((/** @type {any} */ item) => kinds.includes(item.kind) && (item.state ?? 'queued') === 'queued' && (!item.runAfter || new Date(item.runAfter) <= now()));
      if (!job) return null;
      job.state = 'running'; job.attempts = (job.attempts ?? 0) + 1; job.id ??= `job-${++sequence}`;
      return { ...job, userId: job.owner, leaseToken: 'lease', maxAttempts: 3 };
    },
    renew: async () => true,
    finish: async (/** @type {string} */ _owner, /** @type {string} */ id, /** @type {string} */ _lease, /** @type {any} */ result) => { const job = f.jobs.find((/** @type {any} */ item) => item.id === id); Object.assign(job, { state: 'succeeded', result }); return job; },
    fail: async (/** @type {string} */ _owner, /** @type {string} */ id, /** @type {string} */ _lease, /** @type {any} */ error, /** @type {any} */ options) => { const job = f.jobs.find((/** @type {any} */ item) => item.id === id); Object.assign(job, { state: options.retry ? 'queued' : 'failed', error, options }); return job; },
  };
}
