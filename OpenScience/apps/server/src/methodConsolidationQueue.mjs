/** Durable pair work on the existing product ledger. One small row per pair/head;
 * no model call holds a database transaction or the learned-library authority.
 * A scope lease prevents two workers spending on the same snapshot. Crashes
 * expire the lease; each completed pair is checkpointed before the next call.
 */
import { createHash, randomUUID } from 'node:crypto';

export const METHOD_CONSOLIDATION_KIND = 'method-consolidation';
export const METHOD_PAIR_FLOOR = 0.60;
const hash = value => createHash('sha256').update(value).digest('hex');
export const methodPairFingerprint = method => hash(JSON.stringify([
  method.id, method.payload?.contentDigest, method.payload?.frontmatter,
  method.payload?.display, method.payload?.body,
]));
export const pairIdentity = (members, version = '1') => hash(version + members.map(method => `${method.id}@${methodPairFingerprint(method)}`).sort().join('\n'));

export class MethodConsolidationQueue {
  constructor(documents, { now = () => new Date(), version = '1' } = {}) { this.documents = documents; this.now = now; this.version = version; }
  fingerprint(method) { return hash(this.version + methodPairFingerprint(method)); }
  /** Rotate isolated libraries before applying one account-level call budget.
   * A growing owned library must not starve a shared project's pair queue. */
  async scopeOrder(userId, scopes) {
    if (scopes.length < 2) return scopes;
    const id = 'scope-order', prior = await this.documents.get(userId, METHOD_CONSOLIDATION_KIND, id);
    const start = Math.max(0, scopes.indexOf(prior?.payload.nextScope));
    await this.save(userId, id, { scope: 'rotation', recordType: 'rotation', nextScope: scopes[(start + 1) % scopes.length] }, prior);
    return [...scopes.slice(start), ...scopes.slice(0, start)];
  }
  async rows(userId, scope) {
    const result = []; let cursor = null;
    do {
      const page = await this.documents.list(userId, METHOD_CONSOLIDATION_KIND, { limit: 100, cursor, filter: { scope } });
      result.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return result;
  }
  async save(userId, id, payload, prior = null) {
    return this.documents.put(userId, METHOD_CONSOLIDATION_KIND, id, payload,
      { expectedRevision: prior?.revision ?? 0, ...(prior ? { telemetry: true } : {}) });
  }
  async acquire(userId, scope, leaseMs) {
    const id = `lease:${hash(scope)}`, prior = await this.documents.get(userId, METHOD_CONSOLIDATION_KIND, id);
    if (prior?.payload.until > this.now().getTime()) return null;
    try {
      return await this.save(userId, id, { scope, recordType: 'lease', token: randomUUID(), until: this.now().getTime() + leaseMs }, prior);
    } catch (error) { if (error.code === 'product_revision_conflict') return null; throw error; }
  }
  async release(userId, lease) { await this.save(userId, lease.id, { ...lease.payload, until: 0 }, lease); }

  /** Only changed/new endpoints propose new work. Old snapshots become obsolete,
   * never user-memory deletions. Persist heads last so a crash retries enqueue. */
  async sync(userId, scope, methods, propose) {
    const rows = await this.rows(userId, scope), byId = new Map(rows.map(row => [row.id, row]));
    const heads = new Map(rows.filter(row => row.payload.recordType === 'head').map(row => [row.payload.methodId, row]));
    const current = new Map(methods.map(method => [method.id, this.fingerprint(method)]));
    const changed = methods.filter(method => heads.get(method.id)?.payload.fingerprint !== current.get(method.id));
    let enqueued = 0;
    if (changed.length) {
      const pairs = await propose(changed.map(method => method.id));
      const docs = new Map(methods.map(method => [method.id, method]));
      for (const pair of pairs) {
        const members = [docs.get(pair.a), docs.get(pair.b)];
        if (members.some(method => !method) || !changed.some(method => method.id === pair.a || method.id === pair.b)) continue;
        const id = `pair:${hash(scope)}:${pairIdentity(members, this.version)}`;
        const prior = byId.get(id);
        if (prior && prior.payload.status !== 'obsolete') continue;
        const row = await this.save(userId, id, { scope, recordType: 'pair', status: 'pending',
          a: pair.a, b: pair.b, fingerprints: members.map(method => this.fingerprint(method)), score: pair.score ?? pair.overlap,
          enqueuedAt: this.now().toISOString(), examined: false, attempts: 0 }, prior);
        if (prior) rows.splice(rows.indexOf(prior), 1);
        rows.push(row); byId.set(id, row); enqueued += 1;
      }
    }
    for (const row of rows) if (row.payload.recordType === 'pair' && row.payload.status !== 'obsolete') {
      const p = row.payload;
      if (current.get(p.a) !== p.fingerprints[0] || current.get(p.b) !== p.fingerprints[1]) {
        const next = await this.save(userId, row.id, { ...p, status: 'obsolete' }, row); Object.assign(row, next);
      }
    }
    for (const [id, head] of heads) if (!current.has(id) && head.payload.fingerprint !== null) {
      await this.save(userId, head.id, { ...head.payload, fingerprint: null }, head);
    }
    for (const method of changed) {
      const id = `head:${hash(scope)}:${hash(method.id)}`;
      await this.save(userId, id, { scope, recordType: 'head', methodId: method.id, fingerprint: current.get(method.id) }, byId.get(id));
    }
    return { rows: rows.filter(row => row.payload.recordType === 'pair'), enqueued, changed: changed.length };
  }
  pending(rows) {
    const pending = rows.filter(row => row.payload.status === 'pending');
    pending.sort((a, b) => Number(a.payload.examined) - Number(b.payload.examined)
      || a.payload.attempts - b.payload.attempts || b.payload.score - a.payload.score || b.payload.enqueuedAt.localeCompare(a.payload.enqueuedAt) || a.id.localeCompare(b.id));
    // One least-recently attempted pair per pass guarantees progress even
    // while better-scoring methods arrive, including retries after a transient
    // failure. Attempt counts alone would strand failed pairs behind new ones.
    const oldest = pending.filter(row => !row.payload.examined).sort((a,b) =>
      (a.payload.lastTriedAt ?? a.payload.enqueuedAt).localeCompare(b.payload.lastTriedAt ?? b.payload.enqueuedAt)
      || a.payload.attempts - b.payload.attempts || a.id.localeCompare(b.id))[0];
    if (oldest) pending.splice(0, 0, ...pending.splice(pending.indexOf(oldest), 1));
    return pending;
  }
  summary(rows) {
    return { backlog: rows.filter(row => row.payload.status === 'pending' && !row.payload.examined).length,
      pendingBuilds: rows.filter(row => row.payload.status === 'pending' && row.payload.examined).length };
  }
}

/** Batch nearby queued work without discarding cross-group pairs. The oldest
 * anchor gets its turn; connected endpoints fill the existing eight-body bound
 * first, and disjoint work uses spare space. Only supplied pairs are completed. */
export function queuedPairBatch(pending, anchor, maxMethods = 8) {
  const ids = new Set(anchor.payload.groupIds ?? [anchor.payload.a, anchor.payload.b]);
  const candidates = pending.filter(row => row.payload.examined === anchor.payload.examined
    && (!anchor.payload.examined || row.payload.batchKey === anchor.payload.batchKey));
  if (!anchor.payload.examined) for (;;) {
    const fitting = candidates.filter(row => !ids.has(row.payload.a) || !ids.has(row.payload.b))
      .filter(row => new Set([...ids, row.payload.a, row.payload.b]).size <= maxMethods);
    const next = fitting.find(row => ids.has(row.payload.a) || ids.has(row.payload.b)) ?? fitting[0];
    if (!next) break;
    ids.add(next.payload.a); ids.add(next.payload.b);
  }
  return candidates.filter(row => ids.has(row.payload.a) && ids.has(row.payload.b));
}
