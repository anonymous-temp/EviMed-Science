import { createHash } from 'node:crypto';
import { lineFingerprint, memoryLines } from './nativeMemoryOverlay.mjs';
import { containsRemoved } from './nativeMemoryRejections.mjs';
import { OPENVIKING_KNOWN_MEMORY_TYPES } from './openVikingLayout.mjs';

/** @typedef {Record<string, unknown>} NativeExportRow */
/** @param {unknown} value @returns {NativeExportRow} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {NativeExportRow} */ (value) : {};
/** @param {unknown} value @returns {NativeExportRow[]} */
const records = value => Array.isArray(value) ? value.map(record) : [];
/** @param {unknown} value */
const text = value => typeof value === 'string' ? value : '';
/** @param {unknown} value */
const count = value => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

/** Content projections only: no quotes from forget plans, credentials, engine addresses or retry authority.
 * Removal fingerprints apply across categories inside the same namespace, including legacy unknown origins.
 * Source-deletion protection runs on the raw revisions before this projection, through the overlay's existing reader.
 * @param {{commits: NativeExportRow[], revisions: NativeExportRow[], admissions: NativeExportRow[], imports: NativeExportRow[], rejections: NativeExportRow[], sourceRejections?: NativeExportRow[]}} data
 * @param {string[]} roots */
export function projectNativeMemoryAccountData(data, roots) {
  /** @param {string} root */
  const removals = root => data.rejections.filter(row =>
    root.endsWith('/' + text(row.memoryType).split(':')[0]) || !text(row.memoryType).startsWith('gp-') && root === roots[0]);
  /** @param {unknown} value @param {string} root */
  const clean = (value, root) => typeof value !== 'string' ? null : value.split('\n').filter(line => {
    const statement = memoryLines(line)[0] ?? line;
    return !removals(root).some(row => row.fingerprint === lineFingerprint(statement)
      || text(row.text) && containsRemoved(statement, text(row.text)));
  }).join('\n');
  const personal = roots[0];
  /** Pending inputs have no independent source-version proof; a withdrawn source cannot be reintroduced through them.
   * @param {unknown} value */
  const cleanPending = value => {
    const content = clean(value, personal);
    return content === null ? null : content.split('\n').filter(line => !(data.sourceRejections ?? [])
      .some(row => row.fingerprint === lineFingerprint(memoryLines(line)[0] ?? line))).join('\n');
  };
  const forgetRequests = data.commits.map(row => {
    const plan = record(row.forgetRequests);
    return { at: row.createdAt, updatedAt: row.updatedAt, state: text(plan.state),
      requests: records(plan.requests).map(request => ({ at: record(request.requestMessage).at ?? row.createdAt,
        targetKinds: [...new Set([...records(request.candidates).map(candidate => OPENVIKING_KNOWN_MEMORY_TYPES.includes(text(candidate.type)) ? text(candidate.type) : 'stored-line'),
          ...(Array.isArray(request.intents) && request.intents.length ? ['unstored-intent'] : [])])],
        status: text(request.status), removed: count(request.removed), alreadyRemoved: count(request.alreadyRemoved), toolRemoved: count(request.toolRemoved) })),
      completionReceipts: records(plan.claims).map(claim => ({ at: row.createdAt, kind: 'assistant-completion-claim', message: count(claim.message),
        requestMessage: Number.isSafeInteger(claim.turnMessage) && Number(claim.turnMessage) >= 0 ? Number(claim.turnMessage) : null })),
      falseCompletionClaims: count(plan.falseClaims) };
  });
  const revisions = data.revisions.map(row => {
    const uri = text(row.uri), root = roots.find(candidate => uri.startsWith(`${candidate}/`)) ?? personal;
    const sourceDeleted = row.sourceDeletedText === true || text(row.reason).includes('[source-deleted]');
    const held = row.actor === 'platform' && text(row.reason).split(',').every(reason => ['pasted_instruction', 'pasted_instruction_pending'].includes(reason));
    const edited = row.actor === 'user' && ['edited on the memory page', 'undo', 'restored from forgotten'].includes(text(row.reason));
    const undoable = !row.undoneAt && !sourceDeleted && (row.before != null || ['added', 'restored'].includes(text(row.change)));
    // A filename can itself contain withdrawn words. Use the memory page's opaque id, never its original engine path.
    const base = { id: text(row.id), fileId: `nm_${createHash('sha256').update(uri).digest('hex').slice(0, 24)}`,
      memoryType: text(row.memoryType), projectId: row.projectId ?? null, change: text(row.change), actor: text(row.actor),
      at: row.changedAt, undoneAt: row.undoneAt ?? null, undoable };
    if (!undoable || sourceDeleted) return base;
    if (held) {
      const kept = new Set(memoryLines(clean(row.after, root) ?? '').map(lineFingerprint));
      return { ...base, heldLines: memoryLines(clean(row.before, root) ?? '').filter(line => !kept.has(lineFingerprint(line))),
        held: true, inEffect: false };
    }
    return edited ? { ...base, before: clean(row.before, root), after: clean(row.after, root) } : base;
  });
  const admissions = data.admissions.map(row => ({ candidateId: row.candidateId, revision: row.revision, projectId: row.projectId ?? null,
    state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(!['completed', 'cancelled'].includes(text(row.state)) && row.error !== 'source_conversation_deleted'
      ? { text: cleanPending(row.pendingText) } : {}) }));
  const imports = data.imports.map(row => ({ id: row.id, state: row.state, createdAt: row.createdAt, expiresAt: row.expiresAt,
    saved: count(row.saved), leftOut: count(row.leftOut),
    ...(row.state === 'offered' ? { statements: records(row.statements).flatMap(statement => {
      const content = cleanPending(statement.text);
      return content ? [{ text: content, sensitivity: text(statement.sensitivity), ticked: statement.ticked === true }] : [];
    }) } : {}) }));
  return { forgetRequests, revisions, admissions, imports };
}
