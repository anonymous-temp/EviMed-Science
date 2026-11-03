import type { GeoConversationScope } from "./geoNativeClient";
import { conversationReference, vcrObjectReference } from "@evimed/domain";
import { sessionOwner, subscribeSessionBoundary } from "./sessionLifecycle";
import { getWebProjectId } from "./apiClient";

/** One explicit request to the native session surface; a draft never submits. */
export interface RuntimeUiIntent {
  kind: "create" | "open";
  projectId: string;
  requestId: string;
  owner: string;
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

/** The complete history representation. The request payload lives only in this document. */
export interface RuntimeUiIntentMarker {
  kind: "create" | "open";
  projectId: string;
  requestId: string;
  sessionId: string;
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
    kind: "create", projectId: target?.projectId ?? getWebProjectId(), ...(target ? {scope:target.scope} : {}), requestId: crypto.randomUUID(), owner: sessionOwner(),
    sessionId: sessionId && /^[A-Za-z0-9_-]{1,160}$/.test(sessionId) ? sessionId : crypto.randomUUID(),
    ...(draft === undefined ? {} : { draft }),
  };
}

const PREPARED_LIMIT = 128;
const ACKNOWLEDGED_LIMIT = 512;
const acknowledged = new Set<string>();
const prepared = new Map<string, RuntimeUiIntent>();
const pending = new Map<string, RuntimeUiIntent>();
const pendingKey = (projectId: string, sessionId: string, geoId?: string) => JSON.stringify([projectId, sessionId, geoId ?? null]);
subscribeSessionBoundary(() => { acknowledged.clear(); prepared.clear(); pending.clear(); });

/** Prepare before navigation. Only a committed destination may register the payload as pending. */
export function prepareRuntimeUiIntent(intent: RuntimeUiIntent): RuntimeUiIntentMarker {
  const { kind, projectId, requestId, sessionId } = intent;
  const marker = { kind, projectId, requestId, sessionId };
  const checked = validRuntimeUiIntent(intent);
  if (checked && !prepared.has(requestId)) {
    if (prepared.size >= PREPARED_LIMIT) {
      const oldest = prepared.keys().next().value;
      if (oldest !== undefined) prepared.delete(oldest);
    }
    // Do not let a caller mutate the reference or draft after creating the history marker.
    prepared.set(requestId, structuredClone(checked));
  }
  return marker;
}

/** Register only from a committed, active frame; never persist a pending draft across documents. */
export function registerPendingRuntimeUiIntent(intent: RuntimeUiIntent): void {
  if (prepared.get(intent.requestId) !== intent || !intent.owner || intent.owner !== sessionOwner() || acknowledged.has(intent.requestId)) return;
  const key = pendingKey(intent.projectId, intent.sessionId, intent.scope?.geoProjectId);
  if (!pending.has(key) && pending.size >= PREPARED_LIMIT) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(key, intent);
}

export function pendingRuntimeUiIntent(projectId: string, sessionId: string | null, scope?: GeoConversationScope): RuntimeUiIntent | null {
  if (!sessionId || (scope && scope.sessionId !== sessionId)) return null;
  const intent = pending.get(pendingKey(projectId, sessionId, scope?.geoProjectId));
  return intent && intent.owner === sessionOwner() && !acknowledged.has(intent.requestId) ? intent : null;
}

/** Retire an acknowledged intent across all history entries in this document. */
export function acknowledgeRuntimeUiIntent(intent: RuntimeUiIntent): void {
  if (intent.owner === sessionOwner()) {
    prepared.delete(intent.requestId);
    if (acknowledged.size >= ACKNOWLEDGED_LIMIT) {
      const oldest = acknowledged.values().next().value;
      if (oldest !== undefined) acknowledged.delete(oldest);
    }
    acknowledged.add(intent.requestId);
    const key = pendingKey(intent.projectId, intent.sessionId, intent.scope?.geoProjectId);
    if (pending.get(key)?.requestId === intent.requestId) pending.delete(key);
  }
}

function validRuntimeUiIntent(intent: RuntimeUiIntent): RuntimeUiIntent | null {
  if (!intent.owner || intent.owner !== sessionOwner() || acknowledged.has(intent.requestId)
    || !["create", "open"].includes(intent.kind) || !intent.projectId
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

export function runtimeUiIntentMarkerFromState(state: unknown, projectId: string): RuntimeUiIntentMarker | null {
  if (!state || typeof state !== "object" || !("runtimeUiIntent" in state)) return null;
  const value = state.runtimeUiIntent;
  if (!value || typeof value !== "object") return null;
  const marker = value as RuntimeUiIntentMarker;
  if (!["create", "open"].includes(marker.kind) || marker.projectId !== projectId
    || typeof marker.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(marker.requestId)
    || typeof marker.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(marker.sessionId)
    || Object.keys(marker).length !== 4 || !Object.hasOwn(marker, "kind") || !Object.hasOwn(marker, "projectId")
    || !Object.hasOwn(marker, "requestId") || !Object.hasOwn(marker, "sessionId")) return null;
  return marker;
}

/** Remove any pre-migration payload before copying a route state, without activating it. */
export function sanitizeRuntimeUiHistoryState(state: unknown): unknown {
  if (!state || typeof state !== "object" || !("runtimeUiIntent" in state)) return state;
  const raw = state.runtimeUiIntent as Partial<RuntimeUiIntentMarker> | null;
  if (typeof raw?.projectId === "string" && runtimeUiIntentMarkerFromState(state, raw.projectId)) return state;
  const clean = { ...state } as Record<string, unknown>;
  delete clean.runtimeUiIntent;
  if (raw && typeof raw === "object" && typeof raw.projectId === "string") {
    const { kind, projectId, requestId, sessionId } = raw;
    const marker = { kind, projectId, requestId, sessionId };
    if (runtimeUiIntentMarkerFromState({ runtimeUiIntent: marker }, projectId)) clean.runtimeUiIntent = marker;
  }
  return clean;
}

export function runtimeUiIntentFromState(state: unknown, projectId: string): RuntimeUiIntent | null {
  const marker = runtimeUiIntentMarkerFromState(state, projectId);
  if (!marker || acknowledged.has(marker.requestId)) return null;
  const intent = prepared.get(marker.requestId) ?? [...pending.values()].find(candidate => candidate.requestId === marker.requestId
    && candidate.projectId === marker.projectId && candidate.sessionId === marker.sessionId);
  return intent && intent.owner === sessionOwner() && intent.kind === marker.kind && intent.projectId === marker.projectId
    && intent.sessionId === marker.sessionId ? intent : null;
}

export function runtimeUiIntentWasLost(state: unknown, projectId: string): boolean {
  const marker = runtimeUiIntentMarkerFromState(state, projectId);
  if (marker) return !acknowledged.has(marker.requestId) && !runtimeUiIntentFromState(state, projectId);
  const legacy = (state as { runtimeUiIntent?: { draft?: unknown; projectId?: unknown } } | null)?.runtimeUiIntent;
  return legacy?.projectId === projectId && typeof legacy.draft === "string";
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
