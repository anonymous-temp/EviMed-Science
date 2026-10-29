import { Announcer } from "@/lib/announce";
import { useRef, useState } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";
import { useToastStore, type Toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Component: Toaster; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: persistent announcer plus up to three transient cards.
 * Variants: success or error; optional actual undo/action.
 * States: explicit repeated event identities show a count; timer pauses while hovered or focused; errors persist.
 * Hit area: message, action and dismiss controls.
 * Keyboard: native buttons; never moves focus.
 * Long content: message expands on activation.
 * Theme: semantic status icons on neutral surface.
 * Responsive: safe-area bottom center stack.
 * Verification: toast.test.ts and announce.test.tsx; real AT remains separate.
 */
export function Toaster() {
  const { toasts, dismiss, pause, resume } = useToastStore();
  return (
    <><Announcer /><div className="pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-toast flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          toast={t}
          onDismiss={() => dismiss(t.id)}
          onPause={() => pause(t.id)}
          onResume={() => resume(t.id)}
        />
      ))}
    </div></>
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
  const hovered = useRef(false), focused = useRef(false);
  const resumeIfIdle = () => { if (!hovered.current && !focused.current) onResume(); };
  const isError = t.tone === "error";
  return (
    <div
      data-toast={t.id}
      data-toast-tone={t.tone}
      onMouseEnter={() => { hovered.current = true; onPause(); }}
      onMouseLeave={() => { hovered.current = false; resumeIfIdle(); }}
      onFocus={() => { focused.current = true; onPause(); }}
      onBlur={(event) => { if (event.currentTarget.contains(event.relatedTarget)) return; focused.current = false; resumeIfIdle(); }}
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
      {t.occurrences > 1 && <span className="shrink-0 text-caption text-text-2" aria-label={`重复 ${t.occurrences} 次`}>×{t.occurrences}</span>}
      {t.action && (
        <button
          type="button"
          className="shrink-0 text-link hover:underline"
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
