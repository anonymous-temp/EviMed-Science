import {
  cancelWebAgentRun,
  dispatchWebAgentRun,
  putWebResearchSession,
  WebApiError,
  type WebAgentRun,
  type WebResearchAgent,
} from "@/lib/apiClient";
import { announceRunsChanged, OPEN_DOMAIN_ANSWER_AGENT_ID, runAgentName } from "@/lib/runPresentation";

/**
 * Where a request goes when the shell starts it.
 *
 * `capability` binds a fresh research session to one capability, and the
 * control plane then skips routing entirely (`session-binding`): the
 * researcher chose, and a classifier second-guessing that choice would be the
 * defect. `open-domain` leaves the choice to the router — the named-capability
 * rule, the classifier, and the net under it — and the answer line when none
 * of them claims the request.
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

/** The answer line's name wherever the product shows a line. */
export const ANSWER_LINE_LABEL = "普通问答";

export interface RouteLine {
  /** The effective capability, or null for the answer line. */
  agentId: string | null;
  /** 「临床证据深度分析」, or 「普通问答」 for the answer line. */
  label: string;
  answerLine: boolean;
  /** 「通常 15–30 分钟」, or null when neither the run nor the catalogue says. */
  minutes: string | null;
  /** The control plane's own Chinese sentence for why (contract C3), or null. */
  reason: string | null;
}

/**
 * What a run's route line says. The typical duration is the run's own
 * `estimatedMinutes` (the dispatch response carries it), else the
 * catalogue's figure for the capability; a line with neither says nothing
 * about time rather than guessing one. The reason is only ever the Chinese
 * `routeReason` — never the ledger's internal `effectiveRouteReason` code.
 */
export function routeLineOf(run: WebAgentRun, catalog: ReadonlyArray<WebResearchAgent> = []): RouteLine {
  const agentId = run.effectiveAgentId ?? run.agentId ?? null;
  const answerLine = agentId === OPEN_DOMAIN_ANSWER_AGENT_ID || (!agentId && run.mode === "open-domain");
  const entry = agentId ? catalog.find((agent) => agent.id === agentId) : undefined;
  const label = answerLine
    ? ANSWER_LINE_LABEL
    : runAgentName(agentId) ?? entry?.title ?? "所选能力";
  const range = run.estimatedMinutes
    ?? (entry?.estimatedMinutes ? { min: entry.estimatedMinutes[0], max: entry.estimatedMinutes[1] } : null);
  const reason = typeof run.routeReason === "string" && run.routeReason.trim() ? run.routeReason.trim() : null;
  return { agentId: answerLine ? null : agentId, label, answerLine, minutes: minutesText(range), reason };
}

export function minutesText(range: { min: number; max: number } | null | undefined): string | null {
  if (!range) return null;
  const min = Math.max(0, Math.round(range.min));
  const max = Math.max(min, Math.round(range.max));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return null;
  return min === max ? `通常约 ${max} 分钟` : `通常 ${min}–${max} 分钟`;
}
