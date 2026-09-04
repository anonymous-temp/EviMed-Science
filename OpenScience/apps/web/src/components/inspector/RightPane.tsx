import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { INSPECTOR_MAX, INSPECTOR_MIN, useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";

/** Dragging the divider below this pane width closes the pane — the same
 *  snap-shut behaviour as the sidebar. Sits below INSPECTOR_MIN for a clear snap. */
const COLLAPSE_BELOW = 280;

/** The pane may never squeeze the conversation out on small windows. */
const MAX_FRACTION = 0.7;

/** The lg Tailwind breakpoint — below it there is no room for a split. */
const LG_MEDIA = "(min-width: 1024px)";

function useBelowLg(): boolean {
  const [below, setBelow] = useState(
    () => typeof window !== "undefined" && !window.matchMedia(LG_MEDIA).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(LG_MEDIA);
    const onChange = () => setBelow(!mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return below;
}

/**
 * Resizable right pane hosting an inspector or the session Files browser.
 * The left-edge divider drags within [INSPECTOR_MIN, INSPECTOR_MAX] (persisted);
 * dragging it far right snaps the pane closed. Maximized, the pane covers the
 * whole window — sidebar and conversation stay mounted underneath.
 */
export function RightPane({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { inspectorWidth, inspectorMaximized, setInspectorWidth, setInspectorMaximized } =
    useUiStore();
  const belowLg = useBelowLg();
  // While dragging, the live width lives here; the store (and localStorage)
  // are only written on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;

  // Maximized never outlives the pane — closing it returns the next pane
  // (possibly for a different artifact or session) to the normal split.
  useEffect(() => () => setInspectorMaximized(false), [setInspectorMaximized]);

  const clamp = (w: number) =>
    Math.max(
      INSPECTOR_MIN,
      Math.min(w, INSPECTOR_MAX, Math.round(window.innerWidth * MAX_FRACTION)),
    );

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragWidth(inspectorWidth);
  };

  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    // The pane ends at the window's right edge, so the width is whatever is
    // right of the pointer.
    const w = window.innerWidth - e.clientX;
    if (w < COLLAPSE_BELOW) {
      // Snap closed — the pane unmounts, which also ends the drag.
      setDragWidth(null);
      onClose();
      return;
    }
    setDragWidth(clamp(w));
  };

  const onDividerPointerUp = () => {
    if (!dragging) return;
    setInspectorWidth(dragWidth);
    setDragWidth(null);
  };

  if (inspectorMaximized) {
    // The pane header stays the top row — PaneTitlebarInset (rendered inside
    // each header) clears the macOS traffic lights, so no extra strip here.
    return <div className="fixed inset-0 z-40 bg-surface">{children}</div>;
  }

  // Below lg a split would crush the conversation, so the pane degrades to a
  // fullscreen overlay with its own close affordances (button + Esc).
  if (belowLg) return <OverlayPane onClose={onClose}>{children}</OverlayPane>;

  return (
    <div
      className="relative h-full shrink-0"
      style={{ width: dragWidth ?? inspectorWidth }}
    >
      <div className="h-full">{children}</div>
      {/* Drag divider: resize within [INSPECTOR_MIN, INSPECTOR_MAX]; dragging
          far right snaps the pane closed. */}
      <div
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onPointerCancel={onDividerPointerUp}
        className="group absolute inset-y-0 left-0 z-10 w-[5px] cursor-col-resize"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-[2px] transition-colors",
            dragging ? "bg-accent/60" : "bg-transparent group-hover:bg-accent/40",
          )}
        />
      </div>
    </div>
  );
}

/**
 * Small-window (<lg) stand-in for the split pane: the same fullscreen coverage
 * as the maximized branch. The child inspector/files header retains its normal
 * close action; Esc closes the surrounding overlay
 * (capture phase, so it beats the session page's Esc-interrupt; modals and
 * open menus still win) and focus returns to whatever opened it.
 */
function OverlayPane({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A modal or an open menu owns Esc over the overlay.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) {
        return;
      }
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);
  // Return focus to the element that opened the pane (e.g. the Files toggle).
  useEffect(
    () => () => {
      const el = restoreFocus.current;
      if (el && document.contains(el)) el.focus();
    },
    [],
  );
  return (
    <div className="fixed inset-0 z-40 bg-surface">
      {children}
    </div>
  );
}

/** Spacer at the start of a pane header row: when the pane is maximized on
 *  macOS its header becomes the window's top row, so this clears the native
 *  traffic lights (keeping everything on one line) and lets them drag the
 *  window. Renders nothing otherwise. */
export function PaneTitlebarInset() {
  const inspectorMaximized = useUiStore((s) => s.inspectorMaximized);
  const overlayTitlebar = false;
  if (!inspectorMaximized || !overlayTitlebar) return null;
  // Headers pad 16px (px-4); the lights need ~78px clear in total.
  return <div data-tauri-drag-region className="w-[62px] shrink-0 self-stretch" />;
}

/** Maximize / restore toggle for the pane's header row (session pages only —
 *  full-page viewers like the Files page have nothing to maximize over). */
export function MaximizePaneButton() {
  const inspectorMaximized = useUiStore((s) => s.inspectorMaximized);
  const setInspectorMaximized = useUiStore((s) => s.setInspectorMaximized);
  const label = inspectorMaximized ? "还原面板" : "最大化面板";
  return (
    <button
      className="text-text hover:opacity-60"
      aria-label={label}
      title={label}
      onClick={() => setInspectorMaximized(!inspectorMaximized)}
    >
      {inspectorMaximized ? (
        <Minimize2 size={14} strokeWidth={1.5} />
      ) : (
        <Maximize2 size={14} strokeWidth={1.5} />
      )}
    </button>
  );
}
