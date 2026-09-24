import { cn } from "@/lib/cn";

/**
 * The one on/off control. There were four — a sliding track, a ghost button
 * reading 「已启用/已禁用」, a ghost button reading 「已开启/已关闭」 and a
 * pressed pill (inventory §2.4); a switch says its state by its position, so
 * it needs no word beside it.
 *
 * `label` is the accessible name; render it visibly beside the switch only
 * where the row does not already name what it switches.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  showLabel = false,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Print the label before the switch (a page-header switch such as 「记忆」). */
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={showLabel ? undefined : label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "group inline-flex shrink-0 items-center gap-2 text-ui text-text-2 outline-none disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {showLabel && <span>{label}</span>}
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-fast",
          checked ? "bg-accent" : "bg-border-control",
        )}
      >
        <span
          className={cn(
            "absolute h-4 w-4 rounded-full bg-surface shadow-pop transition-transform duration-fast",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}
