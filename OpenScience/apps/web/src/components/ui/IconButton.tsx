import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A button that is only an icon: 28 inside a row, a table or the composer's
 * toolbar (`sm`), 36 in a page header, the sidebar or a dialog's corner
 * (`md`) — spec §17.2, appendix E #9; the icon is 16 either way. The label is
 * required, because it is the button's whole name — it becomes the accessible
 * name and the tooltip.
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
    "hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-disabled",
    size === "sm" ? "h-sm w-7" : "h-control w-9",
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
