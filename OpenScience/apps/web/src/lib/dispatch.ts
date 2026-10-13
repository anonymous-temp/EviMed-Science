import {
  cancelWebAgentRun,
  dispatchWebAgentRun,
  listWebResearchSessions,
  putWebResearchSession,
  WebApiError,
  type WebAgentRun,
  type WebResearchAgent,
} from "@/lib/apiClient";
import { announceRunsChanged } from "@/lib/runPresentation";

/**
 * Where a request goes when the shell starts it.
 *
 * `capability` binds a fresh research session to one capability, and the
 * control plane then skips routing entirely (`session-binding`): the
 * researcher chose, and a classifier second-guessing that choice would be the
 * defect. `open-domain` leaves the choice to the router — a structured choice
 * by name, then the classifier, whose answer is final — and the ordinary
 * conversation when neither claims the request.
 */
export type DispatchTarget =
  | { kind: "capability"; agentId: string; agentVersion: string }
  | { kind: "open-domain" };

export function capabilityTarget(agent: Pick<WebResearchAgent, "id" | "version">): DispatchTarget {
  return { kind: "capability", agentId: agent.id, agentVersion: agent.version };
}

/**
 * A session id the control plane and the frame both accept: the server's
 * `safeId` (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`) and the frame intent's own
 * pattern. The kernel creates the session under this id on the first prompt.
 */
export function newResearchSessionId(): string {
  return `web-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Starts a run from the shell: bind a new session, then dispatch into it.
 *
 * A new session every time, because a session's binding cannot change once it
 * exists (`research_session_identity_conflict`) — which is also why changing
 * the line after a dispatch starts over in a new session rather than
 * rebinding the old one. The dispatch id is minted once per call, so a retry
 * of the same request is the same run, not a second one (the route answers a
 * known dispatch id with the run it already made).
 */
export async function dispatchResearch(target: DispatchTarget, text: string): Promise<WebAgentRun> {
  const question = text.trim();
  if (!question) throw new Error("empty_question");
  const sessionId = newResearchSessionId();
  await putWebResearchSession(
    sessionId,
    target.kind === "capability"
      ? { mode: "specialist", agentId: target.agentId, agentVersion: target.agentVersion }
      : { mode: "open-domain" },
  );
  const run = await dispatchWebAgentRun(sessionId, question, `web-${crypto.randomUUID().replace(/-/g, "")}`);
  announceRunsChanged();
  return run;
}

/**
 * Changes the line of a run that was just started: stop it, and start the
 * same question on the other line (plan §9.6, appendix E §5.3 — the endpoint
 * that honours a binding already existed; nothing reached it).
 *
 * A run that already ended cannot be cancelled and does not need to be; the
 * control plane says so with 409, and the new run starts regardless.
 */
export async function rerouteRun(run: WebAgentRun, target: DispatchTarget, text: string): Promise<WebAgentRun> {
  if (run.status === "running") {
    try {
      await cancelWebAgentRun(run.id);
    } catch (error) {
      if (!(error instanceof WebApiError && error.status === 409)) throw error;
    }
  }
  return dispatchResearch(target, text);
}

/**
 * Which research tool a conversation runs, as the control plane holds it.
 *
 * The frame shows it above the composer and offers the way out of it, but the
 * binding is the control plane's: `session-binding` is what makes the router
 * skip its classifier, and a page that only claimed a tool would be a page
 * whose promise the run does not keep.
 */
export async function conversationCapability(sessionId: string): Promise<string | null> {
  const sessions = await listWebResearchSessions().catch(() => []);
  const bound = sessions.find((session) => session.sessionId === sessionId);
  return bound && bound.mode === "specialist" ? bound.agentId ?? null : null;
}

/**
 * Binds a conversation to a tool, and says which conversation it ended up on.
 *
 * A binding cannot change once its session exists
 * (`research_session_identity_conflict`), so choosing a different tool — or
 * dropping one — is a fresh conversation rather than an edit. The caller
 * carries the draft across, because the researcher may have typed the question
 * before picking the tool.
 */
export async function bindConversationCapability(
  sessionId: string | null,
  agent: { agentId: string; agentVersion: string } | null,
): Promise<{ sessionId: string; rebound: boolean }> {
  const current = sessionId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(sessionId) ? sessionId : null;
  const bound = current ? await conversationCapability(current) : null;
  const wanted = agent?.agentId ?? null;
  if (bound === wanted && current) return { sessionId: current, rebound: false };
  const target = current && bound === null && wanted !== null ? current : newResearchSessionId();
  try {
    await putWebResearchSession(
      target,
      agent ? { mode: "specialist", agentId: agent.agentId, agentVersion: agent.agentVersion } : { mode: "open-domain" },
    );
    return { sessionId: target, rebound: target !== current };
  } catch (error) {
    // An identity conflict means this conversation already ran under another
    // tool; the next one starts clean rather than refusing the choice.
    if (!(error instanceof WebApiError && error.status === 409)) throw error;
    const fresh = newResearchSessionId();
    await putWebResearchSession(
      fresh,
      agent ? { mode: "specialist", agentId: agent.agentId, agentVersion: agent.agentVersion } : { mode: "open-domain" },
    );
    return { sessionId: fresh, rebound: true };
  }
}
