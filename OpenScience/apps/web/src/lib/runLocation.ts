import { getWebProjectId, listWebAgentRuns, listWebProjects, type WebProject } from "./apiClient";
import { useProjectStore } from "./projects";

/**
 * Which of the account's other projects holds a run a link names.
 *
 * A link names a run and never a project — the project travels as a request
 * header, in no address — and each tab reads one project. The links that
 * arrive from outside the tab (a Feishu card, a pushed notice, the inbox) name
 * runs of every project the account owns, so a miss in the tab's project is
 * not a missing run. The other projects are asked most recently active first,
 * skipping any the server counts as empty, and the first that has the run
 * answers. Only on that miss: reading every ledger up front is the cost the
 * sidebar refuses to pay (`useProjectRuns`).
 *
 * `runId` matches a run's id or its session, as the reader's own lookup does.
 */
export async function findRunProject(runId: string): Promise<string | null> {
  const current = getWebProjectId();
  const candidates = (await listWebProjects())
    .filter((project) => project.id !== current && project.runCount !== 0)
    .sort((a, b) => lastActivity(b) - lastActivity(a));
  for (const project of candidates) {
    // A ledger that cannot be read is one place the run is not known to be.
    const runs = await listWebAgentRuns({ projectId: project.id }).catch(() => null);
    if (runs?.some((run) => run.id === runId || run.sessionId === runId)) return project.id;
  }
  return null;
}

/**
 * Moves the shell to the project holding `runId`, when another one does.
 *
 * The page that asked unmounts with the move (AppShell keys every page on the
 * project) and mounts again at the same address, where its first read finds
 * the run. Resolves false when no other project has it; rejects when the
 * project cannot be opened, and the shell stays where it was.
 */
export async function openRunProject(runId: string): Promise<boolean> {
  const projectId = await findRunProject(runId);
  if (!projectId) return false;
  await useProjectStore.getState().select(projectId);
  return true;
}

function lastActivity(project: WebProject): number {
  const at = project.lastActivityAt ? Date.parse(project.lastActivityAt) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}
