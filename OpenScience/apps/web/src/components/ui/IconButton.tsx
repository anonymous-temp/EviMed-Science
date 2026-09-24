import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A button that is only an icon: 24 inside a row, 32 in a page header or the
 * sidebar. The label is required, because it is the button's whole name —
 * it becomes the accessible name and the tooltip.
 *
 * There were three hand-written recipes (32, 28 and 24 px, two different
 * hover grounds, `rounded` and `rounded-input` mixed) across a dozen files.
 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  /** The accessible name and tooltip. */
  label: string;
  size?: "sm" | "md";
  /** Red on hover, for a destructive action. */
  destructive?: boolean;
  /** Pressed or open state (a toggled filter, an open menu). */
  active?: boolean;
}

export function iconButtonClasses({ size = "md", destructive = false, active = false, className }: {
  size?: "sm" | "md";
  destructive?: boolean;
  active?: boolean;
  className?: string;
} = {}): string {
  return cn(
    "inline-grid shrink-0 place-items-center rounded text-text-3 outline-none transition-colors duration-fast",
    "hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40",
    size === "sm" ? "h-6 w-6" : "h-8 w-8",
    destructive && "hover:text-danger",
    active && "bg-surface-2 text-text",
    className,
  );
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = "md", destructive = false, active = false, type = "button", className, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={iconButtonClasses({ size, destructive, active, className })}
      {...rest}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
});
