import { useEffect, useId, useRef } from "react";
import { trapTab } from "@/lib/focusTrap";
import { Button } from "@/components/ui/Button";

/**
 * The one confirmation dialog: a 16 px panel on the scrim, 24 px inside, a
 * 16 / 600 title, a 14 px body in `text-2`, the two buttons at the standard
 * control height. `window.confirm` cannot be styled, translated or
 * focus-managed, so destructive actions ask here.
 *
 * Focus management (spec §22.7): initial focus lands on 取消 (the safe
 * choice), Tab is trapped inside the dialog, Escape / clicking the overlay
 * cancels, and closing returns focus to the element that opened the dialog.
 *
 * Enter is the focused button's and nobody else's. It used to be mapped to
 * "confirm" whenever focus was not on a button (appendix E #4) — so a stray
 * Enter on the panel deleted what the dialog was asking about. Now Enter on
 * 取消, where focus starts, cancels, and confirming a destruction takes a
 * deliberate move to the red button.
 *
 * `busy` is the dialog's own answer to a double press: while the caller's
 * request is in flight the confirming button is disabled and spinning, and the
 * dialog cannot be dismissed (Escape, the overlay and 取消 do nothing), so a
 * second click is impossible by construction rather than by a guard each
 * caller has to remember. The caller closes the dialog when the request
 * settles.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  tone = "danger",
  busy = false,
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
  /** The confirmed action is running: the confirming button is disabled and the dialog stays open until the caller closes it. */
  busy?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  // Always call the latest callback from the mount-once effect below, so a
  // parent re-render neither re-focuses nor re-arms the key listener.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const working = useRef(busy);
  working.current = busy;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working.current) cancel.current();
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
      className="fixed inset-0 z-modal flex items-center justify-center bg-scrim p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={busy || undefined}
        className="w-full max-w-[400px] rounded-panel border border-border bg-surface p-6 shadow-e3"
      >
        <h2 id={titleId} className="text-body font-semibold text-text">{title}</h2>
        <p id={bodyId} className="mt-2 text-ui text-text-2">
          {body}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onCancel}>
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
