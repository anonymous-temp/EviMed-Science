/** Read-time dependency withdrawal. No second deletion ledger and no cached verdict:
 * undo lifts the existing rejection and immediately restores these readers.
 * A derived object is withheld when its own text says a withdrawn thing, or when a recorded
 * source was withdrawn whole (`MemoryHistoryLedger.derivedSourcesRejected`): exactly as wide
 * as the evidence. These are readers; lifecycle code (project deletion retiring the methods
 * learnt only in it) reads the real rows and is never filtered here.
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
export function forgetRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** Only structural source fields confer dependency, never words inside prose.
 * @param {unknown} value */
export function forgetDependencies(value) {
  /** @type {string[]} */ const texts = [];
  /** @type {Set<string>} */ const archives = new Set();
  /** @type {Set<string>} */ const sessions = new Set();
  /** @type {Set<string>} */ const runs = new Set();
  /** @type {Set<string>} */ const methods = new Set();
  /** @param {unknown} item @param {string} [field] */
  const visit = (item, field = '') => {
    if (typeof item === 'string') {
      texts.push(item);
      if (['archiveUri', 'sourceArchiveUri'].includes(field)) archives.add(item);
      if (['sessionId', 'sourceSessionId', 'rootSessionId'].includes(field)) sessions.add(item);
      if (['engineSession', 'sourceSession'].includes(field) && item.startsWith('dsh-')) sessions.add(item.slice(4));
      if (['runId', 'sourceRunId', 'sourceRunIds'].includes(field)) runs.add(item);
      if (['methodId', 'sourceMethodId'].includes(field)) methods.add(item);
      return;
    }
    if (Array.isArray(item)) { for (const entry of item) visit(entry, field); return; }
    const row = forgetRecord(item);
    if (row.type === 'run' && typeof row.id === 'string') runs.add(row.id);
    for (const [key, entry] of Object.entries(row)) visit(entry, key);
  };
  visit(value);
  return { texts, archives: [...archives], sessions: [...sessions], runs: [...runs], methods: [...methods] };
}

/** @typedef {{projectId?:string|null, payload?:unknown, [key:string]:unknown}} DerivedValue */
/** @typedef {{archives:string[], sessions:string[]}} SourceReferences */
/**
 * The adapters reuse MemoryHistoryLedger.rejected and its active source bindings.
 * Resolution reads retained source records, never their filtered public projection.
 * @template Context
 * @param {{
 *   context: (userId:string,projectId:string|null,value:unknown) => Promise<Context>,
 *   rejected: (context:Context,texts:string[]) => Promise<boolean>,
 *   hasWithdrawals?: (context:Context) => Promise<boolean>,
 *   sourcesRejected: (context:Context,refs:SourceReferences) => Promise<boolean>,
 *   conversationsDeleted?: (context:Context) => Promise<boolean>,
 *   resolveRun: (userId:string,projectId:string|null,runId:string) => Promise<unknown>,
 *   resolveMethod: (userId:string,methodId:string) => Promise<unknown>
 * }} dependencies
 */
export function createMemoryForgetReader(dependencies) {
  /** A source that no longer resolves is no evidence by itself: a deleted project's runs go with it while its methods
   * follow their own lifecycle. It withholds only where a source conversation of that scope was deleted, which it
   * may have come from and which can no longer be ruled out. @param {Context} context */
  const unresolvedWithdrawn = async context => dependencies.conversationsDeleted ? dependencies.conversationsDeleted(context) : false;
  /** @param {string} userId @param {unknown} value @param {string|null} [projectId] @returns {Promise<boolean>} */
  return async function allowed(userId, value, projectId = null) {
    /** @type {Set<string>} */ const visited = new Set();
    /** @param {unknown} candidate @param {string|null} scope @param {number} depth @param {Context|null} inherited @returns {Promise<boolean>} */
    const check = async (candidate, scope, depth, inherited) => {
      if (depth > 16) return false;
      const row = forgetRecord(candidate), payload = forgetRecord(row.payload ?? candidate);
      const provenance = forgetRecord(payload.provenance);
      const namedProject = provenance.sourceProjectId ?? payload.projectId ?? row.projectId ?? scope;
      const sourceProject = typeof namedProject === 'string' ? namedProject : null;
      const context = inherited !== null && sourceProject === scope && !provenance.contextPolicy
        ? inherited : await dependencies.context(userId, sourceProject, candidate);
      if (dependencies.hasWithdrawals && !await dependencies.hasWithdrawals(context)) return true;
      const refs = forgetDependencies(candidate);
      if (await dependencies.rejected(context, refs.texts) || await dependencies.sourcesRejected(context, refs)) return false;
      for (const runId of refs.runs) {
        const key = JSON.stringify(['run', sourceProject, runId]);
        if (visited.has(key)) continue;
        visited.add(key);
        const run = await dependencies.resolveRun(userId, sourceProject, runId);
        if (run ? !await check(run, sourceProject, depth + 1, context) : await unresolvedWithdrawn(context)) return false;
      }
      for (const methodId of refs.methods) {
        const key = JSON.stringify(['method', methodId]);
        if (visited.has(key)) continue;
        visited.add(key);
        const method = await dependencies.resolveMethod(userId, methodId);
        if (method ? !await check(method, sourceProject, depth + 1, context) : await unresolvedWithdrawn(context)) return false;
      }
      return true;
    };
    return check(value, projectId, 0, null);
  };
}

export const FORGET_DERIVED_KINDS = new Set(['fact', 'method', 'profile', 'method-consolidation']);
