import { isComposingKey } from "@/lib/compositionKeys";
import { useEffect, useId, useRef } from "react";
import { trapTab, registerFocusLayer, ownsKeyboard } from "@/lib/focusTrap";
import { Button } from "@/components/ui/Button";

/**
 * Component: ConfirmDialog; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: title, subject/count, consequence, recovery and two actions.
 * Variants: danger or primary with legacy body compatibility.
 * States: busy locks confirmation and, unless `cancellable`, dismissal.
 * Hit area: shared control-height buttons.
 * Keyboard: initial Cancel; Enter activates only focused button; modal Tab cycle.
 * Long content: bounded panel wraps explanatory content.
 * Theme: semantic danger/action/surface roles.
 * Responsive: viewport padding bounds panel.
 * Verification: ConfirmDialog.test.tsx; browser/AT remain separate.
 */
export function ConfirmDialog({
  title,
  body,
  subject,
  count,
  consequences,
  recovery,
  confirmLabel,
  onConfirm,
  onCancel,
  tone = "danger",
  busy = false,
  cancellable,
}: {
  title: string;
  body?: string;
  subject?: string;
  count?: number;
  consequences?: string;
  recovery?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * `danger` for what cannot be undone — deleting, stopping a running
   * analysis. `primary` for a confirmation that is only a checkpoint (running
   * one autopilot episode now, restoring a plugin version). The button used to
   * be red for both, which spent the red budget on questions that were not
   * dangerous (review B, ConfirmDialog P1).
   */
  tone?: "danger" | "primary";
  /** The confirmed action is running: the confirming button guards activation while busy and the dialog stays open until the caller closes it. */
  busy?: boolean;
  /**
   * Whether 取消, Escape and the backdrop still dismiss the dialog. By default they do not while `busy` (the confirmed action is
   * running and its dialog is the only place that says so). The route guard sets it: its busy is a save that may hang, and a dialog
   * that cannot be left would trap navigation until the request settles.
   */
  cancellable?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  // Always call the latest callback from the mount-once effect below, so a
  // parent re-render neither re-focuses nor re-arms the key listener.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const working = useRef(busy && cancellable !== true);
  working.current = busy && cancellable !== true;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregister = registerFocusLayer(dialogRef.current);
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!ownsKeyboard(dialogRef.current, e)) return;
      if (e.key === "Escape" && !isComposingKey(e)) { e.preventDefault(); e.stopPropagation(); if (!working.current) cancel.current(); }
      if (e.key === "Tab") trapTab(dialogRef.current, e);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unregister();
      document.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, []);

  return (
    // The overlay has no keyboard listener on purpose: click-outside cancels,
    // and the keyboard equivalent is Escape. role="presentation" keeps it
    // out of the accessibility tree.
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-scrim p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !working.current) onCancel();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={busy || undefined}
        className="w-full max-w-[400px] rounded-panel border border-border bg-surface p-6 shadow-e3"
      >
        <h2 id={titleId} className="text-body font-semibold text-text">{title}</h2>
        <p id={bodyId} className="mt-2 text-ui text-text-2">
          {subject && <span className="block">{subject}{count !== undefined && `（${count} 项）`}</span>}
          {body}
          {consequences && <span className="block">{consequences}</span>}
          {recovery && <span className="block">{recovery}</span>}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" disabled={busy && cancellable !== true} onClick={onCancel}>
            取消
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={busy ? undefined : onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
