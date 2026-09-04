import { useEffect, useId, useRef } from "react";

/**
 * Minimal in-app confirmation dialog. `window.confirm` is unreliable inside
 * the desktop webview, so destructive actions confirm through this instead.
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
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={bodyId}
        className="w-[360px] rounded-card border border-border bg-surface p-4 shadow-card"
      >
        <div className="text-sm font-medium text-text">{title}</div>
        <p id={bodyId} className="mt-1.5 text-sm text-muted">
          {body}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="rounded-input bg-error px-3 py-1.5 text-sm font-medium text-error-fg hover:opacity-90"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Keep Tab cycling through the dialog's focusable elements while it is open. */
function trapTab(dialog: HTMLDivElement | null, e: KeyboardEvent): void {
  if (!dialog) return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute("disabled"));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    // Focus drifted out (e.g. the user clicked the overlay) — pull it back in.
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
