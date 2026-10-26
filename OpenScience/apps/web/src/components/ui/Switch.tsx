import { webErrorMessage } from "@/lib/apiClient";
import { useEffect, useId, useRef, useState } from "react";
import { isAmbiguousMutationError } from "@/lib/useMutationState";
import { cn } from "@/lib/cn";

/**
 * Component: Switch; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: named switch track and linked inline failure.
 * Variants: label beside track or accessible name only.
 * States: optimistic flip locks pending; known rejection rolls back; ambiguous result waits.
 * Hit area: track inside named button.
 * Keyboard: native Space and Enter activate once.
 * Long content: caller label may wrap outside the track.
 * Theme: semantic accent and neutral track.
 * Responsive: shrinks only outside the fixed track.
 * Verification: Switch.test.tsx; touch/AT remain separate.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  showLabel = false,
  className,
  pending = false,
  error,
  reconciliationKey,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void | Promise<unknown>;
  pending?: boolean;
  /** Change after reading the authoritative state, including an unchanged false value. */
  reconciliationKey?: string | number;
  error?: string;
  label: string;
  disabled?: boolean;
  /** Print the label before the switch (a page-header switch such as 「记忆」). */
  showLabel?: boolean;
  className?: string;
}) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState(false);
  const locked = useRef(false);
  const errorId = useId();
  useEffect(() => { setUnresolved(false); setOptimistic(null); setLocalError(null); }, [reconciliationKey]);
  const shown = optimistic ?? checked;
  const activate = async () => {
    if (disabled || pending || locked.current || unresolved) return;
    locked.current = true; setLocalError(null);
    const next = !checked; setOptimistic(next);
    try { await onChange(next); setOptimistic(null); }
    catch (reason) {
      if (isAmbiguousMutationError(reason)) setUnresolved(true);
      else setOptimistic(null);
      setLocalError(webErrorMessage(reason, { fallback: "设置未能保存，请重试。" }));
    } finally { locked.current = false; }
  };
  return (<>
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      aria-busy={pending || optimistic !== null || undefined}
      aria-disabled={pending || optimistic !== null || undefined}
      aria-describedby={error || localError ? errorId : undefined}
      aria-label={showLabel ? undefined : label}
      disabled={disabled}
      onClick={() => { void activate(); }}
      className={cn(
        "group inline-flex shrink-0 items-center gap-2 text-ui text-text-2 outline-none disabled:cursor-not-allowed disabled:opacity-disabled",
        className,
      )}
    >
      {showLabel && <span>{label}</span>}
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-fast",
          shown ? "bg-accent" : "bg-border-control",
        )}
      >
        <span
          className={cn(
            "absolute h-4 w-4 rounded-full bg-surface shadow-e2 transition-transform duration-fast",
            shown ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
    {(error || localError) && <span id={errorId} className="text-caption text-error">{error || localError}{unresolved && "；结果待确认，请刷新状态"}</span>}
  </>);
}
