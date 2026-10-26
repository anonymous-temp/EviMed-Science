import { useCallback, useEffect, useState, useId, useSyncExternalStore, useRef, useLayoutEffect } from "react";

const routeGuards = new Map<string, { busy: boolean; confirming: boolean }>();
const routeListeners = new Set<() => void>();
const notifyRouteGuards = () => routeListeners.forEach(listener => listener());
export const dirtyRouteState = () => [...routeGuards.values()].some(guard => guard.confirming) ? "local-confirm" : [...routeGuards.values()].some(guard => guard.busy) ? "busy" : routeGuards.size ? "dirty" : "clean";
export function useDirtyRouteState() {
  return useSyncExternalStore(
    listener => { routeListeners.add(listener); return () => { routeListeners.delete(listener); }; },
    dirtyRouteState,
    () => "clean",
  );
}

/** One guard for modal exits and browser unload; route integrations call requestClose too. */
export function useUnsavedGuard(dirty: boolean, onClose: () => void, busy = false) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const acknowledged = useRef(false);
  useLayoutEffect(() => {
    if (!dirty) { acknowledged.current = false; return; }
    if (acknowledged.current) return;
    routeGuards.set(id, { busy, confirming });
    notifyRouteGuards();
    return () => { routeGuards.delete(id); notifyRouteGuards(); };
  }, [dirty, busy, confirming, id]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { if (acknowledged.current) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
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
  return { markSaved, requestClose, confirming, keepEditing: () => setConfirming(false), discard: () => { if (!busy) { setConfirming(false); onClose(); } } };
}
