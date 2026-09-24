import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Menu } from "@/components/ui/Menu";

/**
 * Filters: one row of quiet chips, and what does not fit goes into a chip of
 * the same kind that opens a menu (2026-09-23 plan §4).
 *
 * A chip is 32 px high, 14 px text, fully round, with no border: unselected it
 * is plain text, selected it sits on the grey ground. The frontier feed used
 * to wrap into a second row that held nothing but 「只看收藏」, beside a native
 * select dressed as a pill (inventory §2.1, §2.5). One dimension, one control:
 * a single-choice dimension is `FilterChips` (six chips at most, the rest in
 * 「更多 ▾」), another dimension is a `FilterSelect` at the row's end, and an
 * on/off filter is a `FilterChip` with `pressed`.
 */

export interface FilterOption<V extends string = string> {
  value: V;
  label: string;
  /** A count after the label (「未读 2」). */
  count?: number;
}

export function filterChipClasses({ selected = false, className }: { selected?: boolean; className?: string } = {}): string {
  return cn(
    "inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 text-ui outline-none transition-colors duration-fast",
    selected ? "bg-surface-2 font-medium text-text hover:bg-surface-3" : "text-text-2 hover:bg-surface-2 hover:text-text",
    className,
  );
}

/** One chip that toggles (「☆ 收藏」), or the trigger of a menu. */
export const FilterChip = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed?: boolean;
  icon?: LucideIcon;
  /** Draws the ▾ of a chip that opens a menu. */
  menu?: boolean;
}>(function FilterChip({ pressed, icon: Icon, menu = false, className, children, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={menu ? undefined : pressed}
      className={filterChipClasses({ selected: Boolean(pressed), className })}
      {...rest}
    >
      {Icon && <Icon size={16} aria-hidden="true" />}
      {children}
      {menu && <ChevronDown size={16} className="text-text-3" aria-hidden="true" />}
    </button>
  );
});

/** A dimension as a chip that opens a single-choice menu (「专科 ▾」). */
export function FilterSelect<V extends string>({
  label,
  options,
  value,
  onChange,
  allLabel,
}: {
  /** The chip's text while nothing is chosen, and the menu's name. */
  label: string;
  options: readonly FilterOption<V>[];
  value: V | null;
  onChange: (value: V | null) => void;
  /** The option that clears the choice; absent means the choice cannot be cleared. */
  allLabel?: string;
}) {
  const chosen = options.find((option) => option.value === value) ?? null;
  return (
    <Menu
      label={label}
      items={[
        ...(allLabel ? [{ label: allLabel, checked: chosen === null, onSelect: () => onChange(null) }] : []),
        ...options.map((option) => ({ label: option.label, checked: option.value === value, onSelect: () => onChange(option.value) })),
      ]}
    >
      <FilterChip menu pressed={chosen !== null} aria-label={chosen ? `${label}：${chosen.label}` : label}>
        {chosen?.label ?? label}
      </FilterChip>
    </Menu>
  );
}

export function FilterChips<V extends string>({
  label,
  options,
  value,
  onChange,
  maxVisible = 6,
  moreLabel = "更多",
  trailing,
  className,
}: {
  /** The dimension's name, for assistive technology (「栏目」). */
  label: string;
  options: readonly FilterOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Chips shown inline; the rest go into the 「更多 ▾」 chip. */
  maxVisible?: number;
  moreLabel?: string;
  /** Other dimensions and toggles, at the row's end. */
  trailing?: ReactNode;
  className?: string;
}) {
  const inline = options.length > maxVisible ? options.slice(0, maxVisible) : options;
  const overflow = options.length > maxVisible ? options.slice(maxVisible) : [];
  const overflowChosen = overflow.find((option) => option.value === value) ?? null;
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <div role="group" aria-label={label} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {inline.map((option) => (
          <FilterChip key={option.value} pressed={option.value === value} onClick={() => onChange(option.value)}>
            {option.label}
            {option.count !== undefined && <span className="tabular-nums text-text-3">{option.count}</span>}
          </FilterChip>
        ))}
        {overflow.length > 0 && (
          <Menu
            label={`${label}：${moreLabel}`}
            align="start"
            items={overflow.map((option) => ({ label: option.label, checked: option.value === value, onSelect: () => onChange(option.value) }))}
          >
            <FilterChip menu pressed={overflowChosen !== null}>{overflowChosen?.label ?? moreLabel}</FilterChip>
          </Menu>
        )}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </div>
  );
}
