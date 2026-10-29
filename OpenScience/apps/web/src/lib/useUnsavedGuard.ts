import { useCallback, useEffect, useState, useId, useSyncExternalStore, useRef, useLayoutEffect } from "react";

export interface UnsavedRouteOptions {
  /** Changes while a project proof is pending require a fresh discard decision. */
  draftKey?: string;
  /** Optional mode boundary for editors whose main area changes without changing pathname. */
  samePathChange?(fromSearch: string, toSearch: string): boolean;
  /** Search parameters that name the editor's mode: a navigation that changes any of them leaves the editor, so it is asked about. */
  modeParams?: readonly string[];
  /** Clear unsaved data on a host-confirmed route exit; never navigate from this callback. */
  onRouteDiscard?(): void;
}
const routeGuards = new Map<string, { dirty: boolean; busy: boolean; confirming: boolean; options?: UnsavedRouteOptions; acknowledge: () => void }>();
export function dirtyRouteShouldBlock(from: {pathname: string; search: string}, to: {pathname: string; search: string}): boolean {
  if (dirtyRouteState() === 'clean') return false;
  if (from.pathname !== to.pathname) return true;
  const was = new URLSearchParams(from.search), next = new URLSearchParams(to.search);
  return [...routeGuards.values()].some(guard => guard.options?.samePathChange?.(from.search, to.search) || guard.options?.modeParams?.some(key => was.get(key) !== next.get(key)));
}
export function discardDirtyRoutes() {
  for (const guard of routeGuards.values()) { guard.acknowledge(); guard.options?.onRouteDiscard?.(); }
  routeGuards.clear(); notifyRouteGuards();
}
export const dirtyExitSnapshot = () => JSON.stringify([...routeGuards.entries()].map(([id, guard]) => [id, guard.busy, guard.options?.draftKey]));
let projectExit: { resolve: (allow: boolean) => void } | null = null;
export function resolveProjectExit(allow: boolean) {
  // A save over unsaved work, or a dialog already asking, must settle first; a request alone ("pending") does not hold the person here.
  if (allow && (dirtyRouteState() === "busy" || dirtyRouteState() === "local-confirm")) return;
  const pending = projectExit; projectExit = null; pending?.resolve(allow); notifyRouteGuards();
}
/** Project identity does not live in the URL, so store mutations need the same explicit exit decision. */
export function requestProjectExit(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || dirtyRouteState() === "local-confirm") return Promise.resolve(false);
  if (dirtyRouteState() === "clean") return Promise.resolve(true);
  resolveProjectExit(false);
  return new Promise(resolve => {
    const abort = () => resolveProjectExit(false);
    projectExit = { resolve: allow => { signal?.removeEventListener("abort", abort); resolve(allow); } };
    signal?.addEventListener("abort", abort, { once: true });
    notifyRouteGuards();
  });
}
export function useProjectExitPending() {
  return useSyncExternalStore(listener => { routeListeners.add(listener); return () => { routeListeners.delete(listener); }; }, () => projectExit !== null, () => false);
}

const routeListeners = new Set<() => void>();
const notifyRouteGuards = () => routeListeners.forEach(listener => listener());
/**
 * "local-confirm": a dialog of the page's own is asking. "busy": a save is running over unsaved work, and leaving waits for it.
 * "dirty": unsaved work. "pending": only a request is running and nothing is unsaved — leaving is the person's call, and the
 * dialog says a request is running rather than that changes are unsaved. "clean": nothing to protect.
 */
export type DirtyRouteState = "local-confirm" | "busy" | "dirty" | "pending" | "clean";
export const dirtyRouteState = (): DirtyRouteState => {
  const guards = [...routeGuards.values()];
  return guards.some(guard => guard.confirming) ? "local-confirm" : guards.some(guard => guard.dirty && guard.busy) ? "busy"
    : guards.some(guard => guard.dirty) ? "dirty" : guards.length ? "pending" : "clean";
};
export function useDirtyRouteState() {
  return useSyncExternalStore(
    listener => { routeListeners.add(listener); return () => { routeListeners.delete(listener); }; },
    dirtyRouteState,
    () => "clean",
  );
}

/** One guard for modal exits and browser unload; route integrations call requestClose too. */
export function useUnsavedGuard(dirty: boolean, onClose: () => void, busy = false, options?: UnsavedRouteOptions) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const acknowledged = useRef(false);
  useLayoutEffect(() => {
    if (!dirty && !busy) { acknowledged.current = false; return; }
    if (acknowledged.current) return;
    routeGuards.set(id, { dirty, busy, confirming, options, acknowledge: () => { acknowledged.current = true; } });
    notifyRouteGuards();
    return () => { routeGuards.delete(id); notifyRouteGuards(); };
  }, [dirty, busy, confirming, id, options]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const unload = (event: BeforeUnloadEvent) => { if (acknowledged.current) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty, busy]);
  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty && !acknowledged.current) setConfirming(true); else onClose();
  }, [busy, dirty, onClose]);
  const markSaved = useCallback(() => {
    acknowledged.current = true;
    routeGuards.delete(id);
    notifyRouteGuards();
    setConfirming(false);
  }, [id]);
  // The local dialog is the person's decision to discard: it leaves the registry (`markSaved`) before `onClose` moves the address, so the
  // route guard reads a clean page and the dialog's own `confirming` state is no longer what it asks about.
  return { markSaved, requestClose, confirming, keepEditing: () => setConfirming(false), discard: () => { if (!busy) { markSaved(); onClose(); } } };
}
