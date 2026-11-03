import { Activity, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from "react";
import type { NavigationType } from "react-router";
import { isComposingKey } from "@/lib/compositionKeys";
import { isTopFocusLayer, ownsKeyboard, registerFocusLayer, trapTab } from "@/lib/focusTrap";

type ResultActivity = {
  workspace: string;
  open: boolean;
  covered: boolean;
  handoff: number;
  heldDetail: string | null;
  detail: string | null;
  explicitActivation: string | null;
};

export const WorkspaceResultActivity = createContext<ResultActivity | null>(null);

export function useResultActivity(open: boolean, covered: boolean, detail: string | null, requestId: string | null, activation: string | null, navigation: NavigationType): ResultActivity {
  const workspace = useId();
  const [arrival, setArrival] = useState({
    open, handoff: 0, heldDetail: detail, requestId, detail, activation, reopened: false,
  });
  let current = arrival;
  const explicitSelection = Boolean(navigation === "PUSH" && open && detail && activation && activation !== arrival.activation);
  const returnedFromSelection = navigation === "POP" && arrival.reopened && activation !== arrival.activation;
  const requestChanged = Boolean(requestId && requestId !== arrival.requestId);
  // A new accepted AI request yields the selected detail to the conversation, even within the same session.
  if (open !== arrival.open || (open && navigation !== "POP" && requestChanged)) {
    current = { open, handoff: arrival.handoff + 1, heldDetail: detail, requestId, detail, activation, reopened: false };
  } else if (explicitSelection || returnedFromSelection || detail !== arrival.detail) {
    current = { ...arrival, detail, activation: activation ?? arrival.activation, reopened: explicitSelection };
  }
  // A history entry can carry an older AI intent. Remember its id without replaying the handoff.
  if (navigation === "POP" && requestChanged) current = { ...current, requestId };
  if (current !== arrival) setArrival(current);
  return { workspace, open, covered, handoff: current.handoff, heldDetail: current.reopened ? null : current.heldDetail, detail, explicitActivation: current.reopened ? current.activation : null };
}

function releaseFocusWithin(panel: HTMLElement | null) {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && panel?.contains(focused)) focused.blur();
}

let modalSequence = 0;
const activeModalOrder = new WeakMap<HTMLElement, { workspace: string; tier: number; sequence: number }>();

export function useResultModalFocus(
  panelRef: RefObject<HTMLDivElement | null>,
  kind: "drawer" | "dialog",
  initialFocus: () => HTMLElement | SVGElement | null | undefined,
  onEscape: () => void,
) {
  const activity = useContext(WorkspaceResultActivity);
  const workspace = activity?.workspace;
  const scoped = workspace !== undefined;
  const detail = kind === "drawer" ? activity?.detail ?? null : null;
  const activation = detail ? activity?.explicitActivation ?? null : null;
  const [openedDuring] = useState(() => activity?.open ? activity.handoff : null);
  const suspended = Boolean(activity?.open && (activity.covered || (detail
    ? detail === activity.heldDetail
    : openedDuring !== activity.handoff)));
  const isSuspended = useRef(suspended);
  const previousDetail = useRef({ detail, activation });
  const origin = useRef<HTMLElement | null>(null);
  const order = useRef<number | null>(null);
  const lastFocus = useRef<{ element: HTMLElement; detail: string | null } | null>(null);
  const lastPanel = useRef<HTMLDivElement | null>(null);
  const focus = useRef(initialFocus);
  focus.current = initialFocus;
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useLayoutEffect(() => {
    isSuspended.current = suspended;
    // Give the conversation a chance to take focus as soon as the modal is hidden.
    if (suspended) releaseFocusWithin(lastPanel.current);
  }, [suspended]);

  useEffect(() => {
    if (suspended) {
      // A nested modal's cleanup may have tried to refocus a control in the hidden panel.
      releaseFocusWithin(lastPanel.current);
      return undefined;
    }
    const panel = panelRef.current;
    lastPanel.current = panel;
    const changedDetail = previousDetail.current.detail !== detail
      || Boolean(activation && previousDetail.current.activation !== activation);
    previousDetail.current = { detail, activation };
    const active = document.activeElement;
    if (active instanceof HTMLElement && (!origin.current || (changedDetail && active !== document.body && !panel?.contains(active)))) {
      origin.current = active;
    }
    let unregister: () => void;
    if (panel && workspace) {
      const sequence = order.current ?? (order.current = ++modalSequence);
      const focusedModal = active instanceof HTMLElement ? active.closest<HTMLElement>('[aria-modal="true"]') : null;
      const tier = kind === "drawer" ? 0 : 1;
      activeModalOrder.set(panel, { workspace, tier, sequence });
      // Sibling dialogs are above drawers in CSS. Within a tier keep the order they originally opened.
      unregister = registerFocusLayer(panel, (layer) => {
        const above = activeModalOrder.get(layer);
        if (above?.workspace === workspace) return !layer.contains(panel) && (above.tier > tier || (above.tier === tier && sequence < above.sequence));
        // If the shell opened a modal while results were hidden, leave it in charge of the keyboard.
        return layer === focusedModal && !layer.contains(panel);
      });
    } else unregister = registerFocusLayer(panel);
    if (!scoped) focus.current()?.focus();
    else if (isTopFocusLayer(panel)) {
      const remembered = lastFocus.current;
      if (!changedDetail && remembered?.detail === detail && panel?.contains(remembered.element)) remembered.element.focus();
      if (changedDetail || !panel?.contains(document.activeElement)) focus.current()?.focus();
    }

    const onKey = (event: KeyboardEvent) => {
      if (!ownsKeyboard(panelRef.current, event)) return;
      if (event.key === "Escape" && !isComposingKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        escape.current();
      } else trapTab(panelRef.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unregister();
      if (panel && workspace) activeModalOrder.delete(panel);
      document.removeEventListener("keydown", onKey);
    };
  }, [activation, detail, kind, panelRef, scoped, suspended, workspace]);

  useEffect(() => () => { if (!isSuspended.current) origin.current?.focus(); }, []);

  const onFocus = scoped && !suspended ? (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.currentTarget.contains(event.target)) {
      lastFocus.current = { element: event.target, detail };
    }
  } : undefined;

  return { scoped, suspended, onFocus };
}

export function ResultModalSurface({ scoped, suspended, children }: { scoped: boolean; suspended: boolean; children: ReactNode }) {
  return scoped ? <Activity mode={suspended ? "hidden" : "visible"}>{children}</Activity> : children;
}
