import { useSyncExternalStore } from "react";
import { sessionOwner, subscribeSessionBoundary } from "./sessionLifecycle";
import { parseVcrWorkspaceArea, type VcrWorkspaceArea } from "./vcrWorkspaceNavigation";

type EntryArea = VcrWorkspaceArea | "new";
// Like native pending intents, entry drafts stay in this document, never in history or disk storage.
const drafts = new Map<EntryArea, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
subscribeSessionBoundary(() => { drafts.clear(); emit(); });
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** An older area id (`virtual-cohort`, `virtual-patient`, `virtual-trial`) reads and writes the draft of the entrance that replaced it. */
const canonical = (area: EntryArea): EntryArea => area === "new" ? area : parseVcrWorkspaceArea(`area=${area}`);

/** Retain unsent questions across SPA navigation; account boundaries retire every draft. */
export function useVcrEntryDraft(requested: EntryArea): readonly [string, (value: string) => void] {
  const area = canonical(requested);
  const owner = useSyncExternalStore(subscribeSessionBoundary, sessionOwner, sessionOwner);
  const value = useSyncExternalStore(subscribe, () => owner === sessionOwner() ? drafts.get(area) ?? "" : "", () => "");
  return [value, next => {
    if (!owner || owner !== sessionOwner()) return;
    if (next) drafts.set(area, next); else drafts.delete(area);
    emit();
  }];
}
