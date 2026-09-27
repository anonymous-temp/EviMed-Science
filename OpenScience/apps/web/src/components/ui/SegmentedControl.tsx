import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Segmented switch (P2-1, spec §7) with real radiogroup semantics: the group
 * is a radiogroup, each option a radio with aria-checked, only the checked
 * option is tabbable (roving tabindex), and arrow keys / Home / End move the
 * selection — focus follows selection, as in a native radio group. Fully
 * controlled: `value` + `onChange`.
 *
 * Visual (spec §20.2): an inset track at the height of the row it sits in —
 * 36 (`md`, the default) or 28 (`sm`) — with the selected segment lifted onto
 * the surface. Keyboard focus is the global outline, not a `ring-*` shadow
 * that forced-colours mode would erase (appendix E #1); the selected
 * segment's hairline ring is decoration, and forced colours underline the
 * checked radio instead (the token package's accessibility layer).
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
  size = "md",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedControlOption<T>[];
  "aria-label": string;
  /** The height of the row it sits in: `md` 36, `sm` 28. */
  size?: "sm" | "md";
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
      className={cn(
        "inline-flex items-stretch rounded border border-border-control bg-surface-1 p-0.5",
        size === "sm" ? "h-sm" : "h-control",
        className,
      )}
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
              // A control nested in another wears the outer radius minus the
              // padding: 8 - 2 = 6.
              "rounded-md px-3 outline-none transition-colors duration-fast",
              size === "sm" ? "text-compact" : "text-ui",
              checked ? "bg-surface font-medium text-text ring-1 ring-border" : "text-text-3 hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
