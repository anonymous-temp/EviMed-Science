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
      if (Buffer.byteLength(JSON.stringify(payload)) > maxRecordBytes) throw Object.assign(new Error('Record too large'), { code: 'product_record_too_large', status: 413 });
      const row = { id, payload: structuredClone(payload), projectId, revision: expectedRevision + 1, createdAt: old?.createdAt ?? time.toISOString(), updatedAt: time.toISOString() }; rows.set(key, row); return structuredClone(row);
    },
  };
  const service = new EvolutionService({ documents, ownerId: 'operator', now: () => time,
    jobs: { async enqueue(owner, kind, payload, options) { const existing = jobs.find((job) => job.key === options.idempotencyKey); if (existing) return existing; const job = { owner, kind, payload, key: options.idempotencyKey }; jobs.push(job); return job; } },
    notifications: { async create(owner, input) { const row = { id: `n${notices.length}`, owner, ...input }; notices.push(row); return row; } },
  });
  return { service, rows, jobs, notices, documents, advance(ms) { time = new Date(time.getTime() + ms); } };
}
