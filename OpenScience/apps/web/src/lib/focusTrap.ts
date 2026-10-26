import { tabbable, type FocusableElement } from "tabbable";

const layers: HTMLElement[] = [];
/** Register modal lifetime explicitly: portals and focus drift must not select a lower layer. */
export function registerFocusLayer(container: HTMLElement | null): () => void {
  if (!container) return () => {};
  const child = layers.findIndex(layer => container.contains(layer));
  if (child < 0) layers.push(container); else layers.splice(child, 0, container);
  return () => { const index = layers.lastIndexOf(container); if (index >= 0) layers.splice(index, 1); };
}
export function isTopFocusLayer(container: HTMLElement | null): boolean {
  return layers.length === 0 || layers[layers.length - 1] === container;
}
/** Browser-native tabbability semantics, including radio groups and disabled fieldset legends. */
export function focusableIn(container: HTMLElement | null): FocusableElement[] {
  return container ? tabbable(container) : [];
}
/** Cycle only the active modal, retaining a focus destination even with no tab stops. */
export function trapTab(container: HTMLElement | null, event: KeyboardEvent): void {
  if (event.key !== "Tab" || !container || !isTopFocusLayer(container)) return;
  const focusable = focusableIn(container);
  const first = focusable[0], last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!first) { event.preventDefault(); container.focus(); return; }
  if (!focusable.includes(active as FocusableElement)) {
    event.preventDefault(); (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}
