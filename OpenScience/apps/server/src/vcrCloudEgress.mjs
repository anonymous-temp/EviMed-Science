import { projectionHash, requireCloudPermission } from './vcrCloudProjection.mjs';
import { canonicalScenarioJson } from '@evimed/domain';
import { HttpError } from './security.mjs';
/** Revalidate recorded source dependencies before a provider sees a cached conversation.
 * This is source permission, not a quality gate or a claim to detect patient text.
 * @param {{store:any, resolveSession:(caller:any)=>Promise<string|null>, destinations:()=>string[], now?:()=>string}} deps */
export function createVcrCloudEgress({ store, resolveSession, destinations, now = () => new Date().toISOString() }) {
  return async (caller, body) => {
    const sessionId = await resolveSession(caller);
    // Exact platform-issued projection ids in tool results also cover a copied artifact or a child session.
    const ids = [...new Set(JSON.stringify(body).match(/\bprj_[a-f0-9]{48}\b/g) ?? [])];
    const rows = await store.cloudDependencies(caller.userId, caller.projectId, sessionId, ids);
    for (const row of rows) {
      requireCloudPermission(row.deleted_at ? null : row.cloud_permission, destinations(), now());
      if (projectionHash(canonicalScenarioJson(row.cloud_permission)) !== row.permission_hash) {
        throw new HttpError(403, 'vcr_projection_permission_changed', 'This conversation contains a projection under an earlier permission. Start a new conversation to use the newly reviewed projection.');
      }
      // A child or copied context inherits the dependency before its first provider call.
      if (sessionId && ids.includes(row.id)) await store.inheritCloudDependency(row.study_id,sessionId,caller.runId ?? sessionId,row.id);
    }
  };
}
