import { DEPLOYMENT_PERMISSION_HASH, cloudAuthorization, notAuthorized, projectionHash } from './vcrCloudProjection.mjs';
import { canonicalScenarioJson } from '@evimed/domain';
import { HttpError } from './security.mjs';
/** Revalidate recorded source dependencies before a provider sees a cached conversation.
 * This is source permission, not a quality gate or a claim to detect patient text.
 *
 * It sits on every model call of every project, so it asks the cheap question first: a dependency hangs off a study
 * of the project, and a project that holds none is allowed without anything else being read. The conversation is
 * resolved from the run ledger only after that. It used to be resolved first, so a damaged or oversized ledger refused
 * the model call of a project that never touched clinical data (`agent_runs_corrupt`, `agent_runs_too_large`), and every
 * call paid for parsing the whole ledger twice. A project that does hold a study is still checked, and still fails
 * closed on what it cannot read.
 * A recorded dependency is held to the permission in force now, on whichever basis it stands (`cloudAuthorization`): the
 * deployment's agreements, or a permission recorded for its source. A source an operator revoked, and a study that was hidden or
 * deleted, refuse their cached conversations; a projection reviewed under a recorded permission stays bound to it.
 * @param {{store:any, resolveSession:(caller:any)=>Promise<string|null>, destinations:()=>string[], deployment?:()=>any, now?:()=>string}} deps */
export function createVcrCloudEgress({ store, resolveSession, destinations, deployment = () => null, now = () => new Date().toISOString() }) {
  return async (caller, body) => {
    if (!await store.holdsStudy(caller.userId, caller.projectId)) return;
    const sessionId = await resolveSession(caller);
    // Exact platform-issued ids in tool results also cover a copied artifact or a child session: a projection's, and a document's
    // own when it was read as it is.
    const ids = [...new Set(JSON.stringify(body).match(/\b(?:prj_[a-f0-9]{48}|sfl_[a-f0-9]{22})\b/g) ?? [])];
    const rows = await store.cloudDependencies(caller.userId, caller.projectId, sessionId, ids);
    for (const row of rows) {
      // A hidden study still owns its cached clinical conversations, and so does a source that was deleted since the
      // conversation read it; no agreement reopens either.
      if (row.deleted_at || row.source_id === null) throw notAuthorized();
      const { basis } = cloudAuthorization(row.cloud_permission, destinations(), now(), deployment());
      const reviewedUnder = row.permission_hash;
      if (basis === 'source_permission' && reviewedUnder && reviewedUnder !== DEPLOYMENT_PERMISSION_HASH
        && projectionHash(canonicalScenarioJson(row.cloud_permission)) !== reviewedUnder) {
        throw new HttpError(403, 'vcr_projection_permission_changed', 'This conversation contains a projection under an earlier permission. Start a new conversation to use the newly reviewed projection.');
      }
      // A child or copied context inherits the dependency before its first provider call.
      if (sessionId && ids.includes(row.id)) await store.inheritCloudDependency(row.study_id,sessionId,caller.runId ?? sessionId,row.id);
    }
  };
}

/**
 * The conversation a model call belongs to, as the run ledger records it -- the one its clinical reads were filed under:
 * a root conversation's own session, a subagent's parent's, the named run's.
 *
 * A call made from inside a runtime carries only its kernel session, and a run that is running is all it can belong to
 * (the fold the gateway attributes spend against, with no phase walk). A call that names its run -- a bounded runtime,
 * a review or a reply check -- may name one that has finished, so for it the whole ledger is read. Failing to read the
 * ledger refuses the call of a project that holds a study and no other's: `createVcrCloudEgress` asks that first.
 * @param {{ sourceProject: (identity: {userId: string, projectId: string}) => Promise<any>,
 *           agentRuns: { activeRuns: (project: any) => Promise<{id: string, sessionId: string}[]>,
 *                        list: (project: any) => Promise<{id: string, sessionId: string}[]>,
 *                        runIdForSession: (sessionId: string | null | undefined, runs: readonly {id: string, sessionId: string}[]) => string | null } }} dependencies
 * @returns {(caller: {userId: string, projectId: string, runId?: string | null, sessionId?: string | null}) => Promise<string | null>}
 */
export function createVcrSessionResolver({ sourceProject, agentRuns }) {
  return async caller => {
    const project = await sourceProject({ userId: caller.userId, projectId: caller.projectId });
    const runs = caller.runId ? await agentRuns.list(project) : await agentRuns.activeRuns(project);
    const runId = caller.runId ?? agentRuns.runIdForSession(caller.sessionId, runs);
    return runs.find(row => row.id === runId)?.sessionId ?? caller.sessionId ?? null;
  };
}
