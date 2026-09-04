import { useState } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";
import { useToastStore, type Toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Bottom-center stack of transient notifications (download saved/failed, …).
 * A11y (P1-7, spec §11.4): success toasts are polite live regions, errors are
 * assertive alerts; hovering or keyboard-focusing a toast pauses its
 * auto-dismiss; long messages expand on click; toasts can carry an action
 * (e.g. undo) next to an explicit close button.
 */
export function Toaster() {
  const { toasts, dismiss, pause, resume } = useToastStore();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
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
      className={cn(
        "pointer-events-auto flex max-w-[70vw] items-center gap-2 rounded-card border px-3.5 py-2 text-sm shadow-card",
        isError ? "border-error/30 bg-surface text-error" : "border-ok/30 bg-surface text-text",
      )}
    >
      {isError ? (
        <XCircle size={15} className="shrink-0 text-error" />
      ) : (
        <CheckCircle2 size={15} className="shrink-0 text-ok" />
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
        className="shrink-0 text-muted hover:text-text"
        onClick={onDismiss}
      >
        <X size={14} />
      </button>
    </div>
  );
}
