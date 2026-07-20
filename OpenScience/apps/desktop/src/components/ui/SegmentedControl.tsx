import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Segmented switch (P2-1, spec §7) with real radiogroup semantics: the group
 * is a radiogroup, each option a radio with aria-checked, only the checked
 * option is tabbable (roving tabindex), and arrow keys / Home / End move the
 * selection — focus follows selection, as in a native radio group. Fully
 * controlled: `value` + `onChange`.
 *
 * Visual: the existing inset-track switch used by Settings (theme) and Memory
 * (current/archived) — one implementation now, no second copy to drift.
 */
export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedControlOption<T>[];
  "aria-label": string;
  className?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    const radios = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[index]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = selectedIndex >= last ? 0 : selectedIndex + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = selectedIndex <= 0 ? last : selectedIndex - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  return (
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex: the checked radio is the tab stop, not the group (WAI radio pattern).
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn("inline-flex rounded-input border border-border bg-surface-2 p-0.5", className)}
    >
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => select(i)}
            className={cn(
              "rounded-md px-3 py-1.5 text-ui outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-accent",
              checked ? "bg-surface font-medium text-text shadow-card" : "text-muted hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
