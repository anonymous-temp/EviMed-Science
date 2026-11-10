import { isInternalProject } from './internalProjects.mjs';

/**
 * What a finished run says about a missing method, if anything. A run fails for a spent budget, a stopped container, a
 * cancel, a provider outage; none of those is a tool the platform lacks, and turning each into a lead made every failure
 * of every researcher a job for the module. Only a tool or engine the run could not use is a gap in the platform's
 * methods: the closed code `runtime_tool_error` on a run recorded before 2026-10-04, and since then, when a tool failure
 * the run did not get past no longer ends it, the `run_tool_failed` notice on a run that finished (review D-E20). A tool
 * that is not mounted at all is `run_tool_unavailable`, a missing tool of its own; the tools a run found missing are
 * read from its own transcript (the handbook gap).
 * @param {{errorCode?: string | null, qualityNotices?: readonly {code?: string}[] | null}} run @returns {"method-implementation" | null}
 */
export function evolutionRunGap(run) {
  if (run?.errorCode === "runtime_tool_error") return "method-implementation";
  return (run?.qualityNotices ?? []).some((notice) => notice?.code === "run_tool_failed") ? "method-implementation" : null;
}

/**
 * The closed-code signals a researcher's finished run leaves for the offline lab (`scripts/ops/rsi-signals-export.mjs`): a routing failure, an override of the suggested
 * capability, a connector or tool the run did not have. Nothing a run says reaches a code; every value is one of `evolutionSignals.mjs`'s vocabularies.
 * @param {{signals:{record:(input:any)=>Promise<any>}}} dependencies
 */
export function createEvolutionRunSignals({ signals }) {
  /** @param {any} project @param {any} run */
  async function record(project, run) {
    if (isInternalProject(project.id)) return;
    const route = String(run.effectiveRouteReason ?? '');
    if (route.includes(':classifier:')) await signals.record({ userId: project.userId, projectId: project.id, eventId: run.id, moduleId: 'runtime', kind: 'classifier-failure',
      capability: run.effectiveAgentId ?? 'open-domain-answer', operation: 'route', dataShape: 'none', reason: 'unsupported' });
    if (run.connectorNeeds?.length) await signals.record({ userId: project.userId, projectId: project.id, eventId: `connector:${run.id}`, moduleId: 'tools', kind: 'unmet-demand',
      capability: run.effectiveAgentId ?? 'open-domain-answer', operation: 'search', dataShape: 'unknown', reason: 'missing-data' });
    if (route.startsWith('choice:')) await signals.record({ userId: project.userId, projectId: project.id, eventId: run.id, moduleId: 'runtime', kind: 'route-override',
      capability: run.effectiveAgentId ?? 'open-domain-answer', fromCapability: run.suggestedAgentId ?? 'unknown', operation: 'route', dataShape: 'none', reason: 'unsupported' });
    const toolUnavailable = (run.qualityNotices ?? []).some((/** @type {any} */ notice) => notice?.code === 'run_tool_unavailable');
    if (toolUnavailable || ['method-missing', 'method-implementation', 'connector'].includes(/** @type {string} */ (evolutionRunGap(run)))) await signals.record({ userId: project.userId, projectId: project.id, eventId: run.id,
      moduleId: 'tools', kind: 'unmet-demand', capability: run.effectiveAgentId, operation: 'unknown', dataShape: 'unknown', reason: 'missing-tool' });
  }
  return { record };
}
