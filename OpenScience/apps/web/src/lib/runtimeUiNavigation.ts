import type { GeoConversationScope } from "./geoNativeClient";
import { conversationReference, vcrObjectReference } from "@evimed/domain";
import { getWebProjectId } from "./apiClient";

/** One explicit request to the native session surface; a draft never submits. */
export interface RuntimeUiIntent {
  kind: "create" | "open";
  projectId: string;
  requestId: string;
  sessionId: string;
  draft?: string;
  restoreDraft?: boolean;
  originReference?: NonNullable<ReturnType<typeof conversationReference>>;
  references?: Array<{ id: string; title: string }>;
  resultRevision?: { referenceId: string };
  vcrReference?: VcrObjectSelection;
  geoPlanContext?: { referenceId: string };
  scope?: GeoConversationScope;
}

export interface VcrObjectSelection {
  studyId?: string;
  kind: "population" | "patient_set" | "comparator" | "trial_scenario" | "model" | "step";
  objectId: string;
  version?: number | string;
  resultId?: string;
  resultVersion?: number;
  compareTo?: { objectId: string; version: number | string; resultId?: string; resultVersion?: number };
}

/**
 * A deliberate new conversation.
 *
 * `sessionId` is minted here, before the kernel exists, because the shell has
 * to be able to bind that conversation to a research tool first — a binding is
 * what makes the router honour the choice instead of re-deciding it. Pass one
 * in when it was already bound.
 */
export function newRuntimeUiIntent(draft?: string, sessionId?: string, target?: {projectId:string;scope:GeoConversationScope}): RuntimeUiIntent {
  return {
    kind: "create", projectId: target?.projectId ?? getWebProjectId(), ...(target ? {scope:target.scope} : {}), requestId: crypto.randomUUID(),
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
  if (intent.scope && (intent.scope.kind !== "geo" || intent.scope.sessionId !== intent.sessionId || typeof intent.scope.geoProjectId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(intent.scope.geoProjectId) || intent.kind !== "open" || Object.keys(intent.scope).length !== 3)) return null;
  if (intent.geoPlanContext && (Object.keys(intent.geoPlanContext).length !== 1 || !/^gpc_[a-f0-9]{64}$/.test(intent.geoPlanContext.referenceId))) return null;
  if (intent.resultRevision && (typeof intent.resultRevision.referenceId !== "string"
    || !/^rr_[a-f0-9]{64}$/.test(intent.resultRevision.referenceId))) return null;
  if (intent.restoreDraft !== undefined && typeof intent.restoreDraft !== "boolean") return null;
  if (intent.vcrReference && (!intent.draft || !vcrObjectReference(intent.vcrReference))) return null;
  if (intent.originReference && !conversationReference(intent.originReference)) return null;
  if (intent.references && (!Array.isArray(intent.references) || intent.references.length > 50
    || intent.references.some(ref => !ref || typeof ref.id !== "string" || !/^src_[a-f0-9]{32}$/.test(ref.id)
      || typeof ref.title !== "string" || ref.title.length > 300))) return null;
  return intent.vcrReference ? { ...intent, vcrReference: vcrObjectReference(intent.vcrReference) as VcrObjectSelection } : intent;
}

/** A history entry's project is a routing hint; project selection must still prove ownership. */
export function conversationProjectFromState(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { conversationProjectId?: unknown }).conversationProjectId;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
}

/** Preserve the conversation's scope across native selection, creation and forks. */
export function conversationNavigationState(state: unknown, projectId: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(state && typeof state === "object" ? state : {}), conversationProjectId: projectId };
  delete next.runtimeUiIntent;
  if (projectId !== "default") delete next.globalAssistant;
  return next;
}

/** Explicit URL scope survives refresh and copied links; ownership is proved by select. */
export function conversationProjectFromLocation(location: { search: string; state: unknown }): string | null {
  const params = new URLSearchParams(location.search);
  if (params.has("project")) {
    const project = params.get("project") ?? "";
    return /^[A-Za-z0-9_-]{1,160}$/.test(project) ? project : "invalid-project-context";
  }
  return conversationProjectFromState(location.state);
}

export function scopedConversationPath(path: string, projectId: string): string {
  const url = new URL(path, "https://conversation.invalid");
  url.searchParams.set("project", projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}
