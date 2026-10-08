import { useState } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";
import { useToastStore, type Toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Bottom-center stack of transient notifications (a download saved or not).
 *
 * Spec §22.1: one card whatever it reports — a surface, a hairline edge,
 * `shadow-e2` — and the status is the icon's to say (a green `CheckCircle2`,
 * a red `XCircle`), not a coloured border (appendix E #7). A success is a
 * polite `status`, an error an assertive `alert`; neither takes focus.
 * Hovering or focusing a toast pauses its timer; a long message expands on
 * click; a toast can carry one action (撤销) beside its close button. It sits
 * on the toast tier (`z-toast`), above a dialog, and rises 8 px as it arrives
 * — a pure fade under reduced motion.
 */
export function Toaster() {
  const { toasts, dismiss, pause, resume } = useToastStore();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-toast flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          toast={t}
          onDismiss={() => dismiss(t.id)}
          onPause={() => pause(t.id)}
          onResume={() => resume(t.id)}
        />
      ))}
    </div>
  );
}

function ToastCard({
  toast: t,
  onDismiss,
  onPause,
  onResume,
}: {
  toast: Toast;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isError = t.tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
      className="pointer-events-auto flex min-h-control max-w-[70vw] animate-toast-in items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-ui text-text shadow-e2"
    >
      {isError ? (
        <XCircle size={16} className="shrink-0 text-error" aria-hidden="true" />
      ) : (
        <CheckCircle2 size={16} className="shrink-0 text-ok" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn("min-w-0 text-left", expanded ? "whitespace-pre-wrap break-words" : "truncate")}
      >
        {t.message}
      </button>
      {t.action && (
        <button
          type="button"
          className="shrink-0 font-medium text-link hover:underline"
          onClick={() => {
            t.action?.onClick();
            onDismiss();
          }}
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="关闭"
        className="shrink-0 text-text-3 hover:text-text"
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
