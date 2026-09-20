import { getWebProjectId, listWebAgentRuns, listWebProjects, type WebProject } from "./apiClient";
import { useProjectStore } from "./projects";

/** A conversation id the shell is willing to put in an address. */
const ADDRESSABLE_SESSION = /^[A-Za-z0-9_-]{1,160}$/;

/** Where a conversation lives. One route, with or without the id. */
export function chatPath(sessionId?: string | null): string {
  return sessionId && ADDRESSABLE_SESSION.test(sessionId)
    ? `/app/chat/${encodeURIComponent(sessionId)}`
    : "/app/chat";
}

/**
 * Whether an address is the conversation surface.
 *
 * The kernel frame is mounted above the router and hidden rather than
 * unmounted off this surface, so this is what decides "hidden" — it is read on
 * every navigation and must not depend on the route table being matched. It
 * matches exactly the shapes `chat/:sessionId?` matches, so an address with a
 * segment too many is the 404 it routes to and not a frame behind one.
 */
export function isChatPath(pathname: string): boolean {
  return pathname === "/app/chat" || /^\/app\/chat\/[^/]+$/.test(pathname);
}

/** The conversation an address names, or null for the bare surface. */
export function chatSessionId(pathname: string): string | null {
  if (!pathname.startsWith("/app/chat/")) return null;
  const raw = pathname.slice("/app/chat/".length);
  if (!raw || raw.includes("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return ADDRESSABLE_SESSION.test(decoded) ? decoded : null;
}

/**
 * The conversation a run happened in, for the links that name a run.
 *
 * Notifications, Feishu cards and old bookmarks name a run id — the ledger's
 * name for it — and the product has one surface for a run now: the
 * conversation it happened in. The ledger is still what knows which that is,
 * so the id is resolved through it and never shown.
 */
export async function findRunSession(runId: string): Promise<string | null> {
  const match = (runs: Awaited<ReturnType<typeof listWebAgentRuns>>) =>
    runs.find((run) => run.id === runId || run.sessionId === runId) ?? null;
  const here = match(await listWebAgentRuns().catch(() => []));
  if (here) return ADDRESSABLE_SESSION.test(here.sessionId) ? here.sessionId : null;
  // Another project of the same account may hold it; moving there is what makes
  // the conversation readable, since a workspace is per project.
  const projectId = await findRunProject(runId).catch(() => null);
  if (!projectId) return null;
  await useProjectStore.getState().select(projectId);
  const found = match(await listWebAgentRuns().catch(() => []));
  return found && ADDRESSABLE_SESSION.test(found.sessionId) ? found.sessionId : null;
}

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
 * The page that asked unmounts with the move (AppShell keys every routed page
 * on the project) and mounts again at the same address, where its first read
 * finds the run. Resolves false when no other project has it; rejects when the
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
