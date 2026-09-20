import { useEffect, useId, useRef } from "react";
import { trapTab } from "@/lib/focusTrap";
import { Button } from "@/components/ui/Button";

/**
 * The one confirmation dialog: a 16 px panel on the scrim, 24 px inside, the
 * two buttons at the standard control height. `window.confirm` cannot be
 * styled, translated or focus-managed, so destructive actions ask here.
 *
 * Focus management (P1-7, spec §11.3): initial focus lands on 取消 (the safe
 * choice), Tab is trapped inside the dialog, Enter confirms, Escape / clicking
 * the overlay cancels, and closing returns focus to the element that opened
 * the dialog.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  tone = "danger",
}: {
  title: string;
  body: string;
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
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  // Always call the latest callbacks from the mount-once effect below, so a
  // parent re-render neither re-focuses nor re-arms the key listener.
  const callbacks = useRef({ onConfirm, onCancel });
  callbacks.current = { onConfirm, onCancel };

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") callbacks.current.onCancel();
      // Enter confirms from anywhere in the dialog — except when a button has
      // focus, because that button's own click would fire the callback twice.
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) callbacks.current.onConfirm();
      if (e.key === "Tab") trapTab(dialogRef.current, e);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, []);

  return (
    // The overlay has no keyboard listener on purpose: click-outside cancels,
    // and the keyboard equivalent is Escape. role="presentation" keeps it
    // out of the accessibility tree.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-modal"
      >
        <h2 id={titleId} className="text-ui font-semibold text-text">{title}</h2>
        <p id={bodyId} className="mt-2 text-ui text-muted">
          {body}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
