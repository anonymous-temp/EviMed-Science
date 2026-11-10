import { platformSessionOf } from './openVikingSessions.mjs';
import { isPlatformStartedRun } from './memoryDispatch.mjs';
import { isInternalProjectOf } from './internalProjects.mjs';
import { historyTitle } from './memoryHistory.mjs';

/** The server's source authority and admission for original conversation history.
 * Kept together so worker ingestion and recall exercise the same live checks.
 */
export function createMemoryHistorySources({ config, store, productDatabase, nativeMemoryContexts, nativeMemoryOverlay,
  agentRuns, memorySettings, agentRegistry, vcrPrivacyStore, memoryAdmission }) {
  return {
    resolveSource: async (commit, memoryContext) => {
      const user = await store.userById(memoryContext.ownerId);
      if (!user) return null;
      const projectId = commit.projectId ?? memoryContext.projectId;
      if (!projectId || memoryContext.kind === 'geo-project' && projectId !== memoryContext.projectId) return null;
      const project = await store.requireProject(user, projectId);
      if (project.userId !== memoryContext.ownerId) return null;
      const row = (await productDatabase.query('SELECT created_at::text AS stamp FROM evimed_control.projects WHERE user_id=$1 AND id=$2', [memoryContext.ownerId, projectId])).rows[0];
      if (!row) return null;
      // A worker's account view has no project incarnation. Account-wide recall
      // can also resolve a named project from the default project's view. Bind
      // those lookups to the database stamp before asking for live authority;
      // retain a caller's existing stamp when it already names this project.
      const projectCreatedAt = memoryContext.projectId === projectId && memoryContext.projectCreatedAt
        ? memoryContext.projectCreatedAt : row.stamp;
      await nativeMemoryContexts.assertLive({ ...memoryContext, projectId, projectCreatedAt });
      const base = { projectId, projectCreatedAt: row.stamp, project };
      if (!commit.engineSession) return base;
      const sessionId = platformSessionOf(commit.engineSession);
      if (!sessionId) return null;
      if (memoryContext.kind === 'geo-project') {
        const bound = await nativeMemoryContexts.session(memoryContext, commit.engineSession);
        if (!bound || bound.payload.source.kind !== 'dsh' || bound.payload.source.childAddress || bound.payload.source.rootSessionId !== sessionId) return null;
      } else if (await nativeMemoryOverlay.projectOfSession(memoryContext.ownerId, commit.engineSession) !== projectId) return null;
      const runs = await agentRuns.conversationRuns(project, sessionId);
      if (!runs.length || runs.every(run => run.deleted === true)) return null;
      const named = runs.find(run => typeof run.title === 'string' && run.title.trim());
      return { ...base, sessionId, runs, conversationTitle: historyTitle(named?.title ?? runs.at(-1)?.question), projectTitle: historyTitle(project.name,'Project'),
        conversationUrl: `/app/chat/${encodeURIComponent(sessionId)}` };
    },
    eligible: async (memoryContext, source) => {
      if (isInternalProjectOf(config, memoryContext.ownerId, source.projectId)) return false;
      const state = await memorySettings.sessionState(memoryContext.ownerId, source.projectId, source.sessionId);
      if (state.trialCapsuleId) return false;
      // Raw archives cannot reliably date an undated message into a mixed
      // automated conversation, so exclude that entire conversation here.
      for (const run of source.runs) {
        if (run.deleted || isPlatformStartedRun(run) || (await agentRegistry)?.get?.(run.effectiveAgentId ?? run.agentId)?.visibility === 'internal') return false;
      }
      if (vcrPrivacyStore && await vcrPrivacyStore.hasClinicalContext(memoryContext.ownerId, source.projectId,
        source.runs.map(run => ({ sessionId: source.sessionId, runId: run.id })))) return false;
      return true;
    },
    admitMessage: async (memoryContext, source, message) => (await memoryAdmission.admit({ user: { id: memoryContext.ownerId }, project: source.project,
      engineSessionId: `dsh-${source.sessionId}`, at: Number.isFinite(Date.parse(message.created_at ?? '')) ? Date.parse(message.created_at) : null })).learn,
  };
}
