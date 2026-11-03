import { prepareRuntimeUiIntent, runtimeUiIntentFromState, type RuntimeUiIntentMarker, type VcrObjectSelection } from "./runtimeUiNavigation";
import { sessionOwner, subscribeSessionBoundary } from "./sessionLifecycle";

/** The history entry can only point at a draft in this document. */
export interface VcrPendingDraftMarker {
  version: 1;
  requestId: string;
  studyId: string;
}

type Draft = {
  draft: string;
  reference?: VcrObjectSelection;
  restoreDraft: boolean;
};

type Entry = Draft & {
  marker: VcrPendingDraftMarker;
  owner: string;
  projectId: string;
  promoted?: RuntimeUiIntentMarker;
};

const LIMIT = 16;
// A guarded navigation can fill its own preparation queue without displacing committed drafts.
const prepared = new Map<string, Entry>();
const committed = new Map<string, Entry>();
const retired = new Set<string>();

subscribeSessionBoundary(() => { prepared.clear(); committed.clear(); retired.clear(); });

function markerFromState(state: unknown): VcrPendingDraftMarker | null {
  if (!state || typeof state !== "object" || !("vcrPendingDraft" in state)) return null;
  const marker = state.vcrPendingDraft as Partial<VcrPendingDraftMarker> | null;
  if (!marker || typeof marker !== "object" || Object.keys(marker).length !== 3 || marker.version !== 1
    || typeof marker.studyId !== "string" || typeof marker.requestId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(marker.requestId)) return null;
  return { version: 1, requestId: marker.requestId, studyId: marker.studyId };
}

function entryFor(entries: ReadonlyMap<string, Entry>, state: unknown, studyId: string, projectId: string): Entry | undefined {
  const marker = markerFromState(state);
  if (marker?.studyId !== studyId) return undefined;
  const entry = entries.get(marker.requestId);
  return entry?.owner && entry.owner === sessionOwner() && entry.marker.studyId === studyId && entry.projectId === projectId
    ? entry : undefined;
}

export function prepareVcrPendingDraft(studyId: string, projectId: string, payload: Draft): VcrPendingDraftMarker {
  const owner = sessionOwner();
  const marker: VcrPendingDraftMarker = { version: 1, requestId: crypto.randomUUID(), studyId };
  if (!owner || (payload.reference?.studyId && payload.reference.studyId !== studyId)) return marker;
  if (prepared.size >= LIMIT) {
    const oldest = prepared.keys().next().value;
    if (oldest !== undefined) prepared.delete(oldest);
  }
  prepared.set(marker.requestId, { ...structuredClone(payload), marker, owner, projectId });
  return marker;
}

export function vcrPendingDraftStatus(state: unknown, studyId: string, projectId: string): "waiting" | "lost" | null {
  if (!state || typeof state !== "object" || !("vcrPendingDraft" in state)) return null;
  const marker = markerFromState(state);
  if (marker && (marker.studyId !== studyId || retired.has(marker.requestId))) return null;
  return entryFor(committed, state, studyId, projectId) || entryFor(prepared, state, studyId, projectId) ? "waiting" : "lost";
}

/** Called by the study only after its chat route has committed. */
export function acceptVcrPendingDraft(state: unknown, studyId: string, projectId: string): void {
  const entry = entryFor(prepared, state, studyId, projectId);
  if (!entry) return;
  prepared.delete(entry.marker.requestId);
  // FIFO by first commit. Revisiting an already committed draft does not change its order.
  if (committed.size >= LIMIT) {
    const oldest = committed.keys().next().value;
    if (oldest !== undefined) committed.delete(oldest);
  }
  committed.set(entry.marker.requestId, entry);
}

/** Call only from the committed chat route after the server supplies the study's session. */
export function promoteVcrPendingDraft(state: unknown, studyId: string, projectId: string, sessionId: string): RuntimeUiIntentMarker | null {
  const entry = entryFor(committed, state, studyId, projectId);
  if (!entry) return null;
  if (entry.promoted?.sessionId === sessionId && runtimeUiIntentFromState({ runtimeUiIntent: entry.promoted }, projectId)) return entry.promoted;
  entry.promoted = prepareRuntimeUiIntent({
    kind: "open", projectId, requestId: crypto.randomUUID(), owner: entry.owner, sessionId, draft: entry.draft,
    ...(entry.restoreDraft ? { restoreDraft: true } : {}), ...(entry.reference ? { vcrReference: entry.reference } : {}),
  });
  return entry.promoted;
}

/** A blocked replacement leaves the provisional entry recoverable. Only its committed successor retires it. */
export function retireVcrPendingDraft(studyId: string, projectId: string, intent: RuntimeUiIntentMarker): void {
  for (const [key, entry] of committed) {
    if (entry.owner !== sessionOwner() || entry.marker.studyId !== studyId || entry.projectId !== projectId
      || entry.promoted?.requestId !== intent.requestId || entry.promoted.sessionId !== intent.sessionId) continue;
    committed.delete(key);
    if (retired.size >= LIMIT) {
      const oldest = retired.values().next().value;
      if (oldest !== undefined) retired.delete(oldest);
    }
    retired.add(key);
    break;
  }
}
