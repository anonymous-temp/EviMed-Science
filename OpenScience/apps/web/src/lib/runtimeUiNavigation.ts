import { getWebProjectId } from "./apiClient";

/** One explicit request to the native session surface; a draft never submits. */
export interface RuntimeUiIntent {
  kind: "create" | "open";
  projectId: string;
  requestId: string;
  sessionId: string;
  draft?: string;
}

/**
 * A deliberate new conversation.
 *
 * `sessionId` is minted here, before the kernel exists, because the shell has
 * to be able to bind that conversation to a research tool first — a binding is
 * what makes the router honour the choice instead of re-deciding it. Pass one
 * in when it was already bound.
 */
export function newRuntimeUiIntent(draft?: string, sessionId?: string): RuntimeUiIntent {
  return {
    kind: "create", projectId: getWebProjectId(), requestId: crypto.randomUUID(),
    sessionId: sessionId && /^[A-Za-z0-9_-]{1,160}$/.test(sessionId) ? sessionId : crypto.randomUUID(),
    ...(draft === undefined ? {} : { draft }),
  };
}

export function runtimeUiIntentFromState(state: unknown, projectId: string): RuntimeUiIntent | null {
  if (!state || typeof state !== "object" || !("runtimeUiIntent" in state)) return null;
  const value = state.runtimeUiIntent;
  if (!value || typeof value !== "object") return null;
  const intent = value as RuntimeUiIntent;
  if (!["create", "open"].includes(intent.kind) || intent.projectId !== projectId
    || typeof intent.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(intent.requestId)
    || typeof intent.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(intent.sessionId)
    || (intent.draft !== undefined && (typeof intent.draft !== "string" || intent.draft.length > 100_000))) return null;
  return intent;
}
