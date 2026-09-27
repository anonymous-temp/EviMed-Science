import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one button: three looks and three heights (2026-09-23 plan §4).
 *
 *  - `primary` — solid accent. A view has at most one.
 *  - `secondary` — a quiet grey ground and no border. There is no outline
 *    button any more: bordered buttons were on every row of every page, and
 *    a border is what made a list of six rows read as a form.
 *  - `text` — no ground at all, for a page-header action such as 「全部已读」.
 *  - `danger` — solid red, for the confirming button of a destructive
 *    confirmation and nowhere else. A destructive action that is not the
 *    view's main one is `secondary` or `text` with `destructive`.
 *
 * Heights (spec §16.3, appendix E #9): 28 inside a row, a table or a toolbar
 * (`sm`, 13 px text), 36 on a page, a form, a dialog (`md`, the default), 44
 * for a form's primary action and the login (`lg`) — the heights the Vue
 * shell's Element Plus theme already had, so one product has one set. They
 * are the token heights (`h-sm` / `h-control` / `h-form-primary`), not steps
 * of the spacing scale. The 2026-09-23 set was 24 / 32 / 40.
 *
 * `ghost` is the retired name of `secondary`; it renders the new look so a
 * page nobody has touched yet loses its border with everyone else's.
 *
 * `buttonClasses` exposes the same look as a class string for the rare cases
 * that cannot render a <button> (an <a> that must keep link semantics).
 */

export type ButtonVariant = "primary" | "secondary" | "text" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<Exclude<ButtonVariant, "ghost">, string> = {
  // `accent-pressed` rather than an opacity step: an alpha on a token colour
  // generates no CSS here, and a pressed accent is its own value.
  primary: "bg-accent text-accent-fg hover:bg-accent-pressed active:bg-accent-pressed",
  secondary: "bg-surface-2 text-text hover:bg-surface-3 active:bg-surface-3",
  text: "bg-transparent text-text-2 hover:bg-surface-2 hover:text-text active:bg-surface-3",
  danger: "bg-error text-error-fg hover:bg-danger-strong active:bg-danger-strong",
};

// Padding 10 / 14 / 18 and icon gap 4 / 6 / 8, from the size table (§16.3).
const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-sm gap-1 px-2.5 text-compact", // 28 — inside a row, a table, a toolbar
  md: "h-control gap-1.5 px-3.5 text-ui", // 36 — a page's controls, a form, a dialog
  lg: "h-form-primary gap-2 px-[18px] text-ui", // 44 — a form's primary action, the login
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  destructive = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Red text on a secondary or text button: a destructive action that is not the view's main one. */
  destructive?: boolean;
  className?: string;
} = {}): string {
  const look = variant === "ghost" ? "secondary" : variant;
  return cn(
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded font-medium outline-none transition-colors duration-fast",
    // No ring here: the global `:focus-visible` outline in index.css draws the
    // 2 px focus ring on every control alike.
    "disabled:cursor-not-allowed disabled:opacity-disabled",
    variantClasses[look],
    destructive && look !== "primary" && look !== "danger" && "text-danger hover:text-danger",
    sizeClasses[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Red text on a secondary or text button. */
  destructive?: boolean;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", destructive = false, loading = false, type = "button", disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, destructive, className })}
      {...rest}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});
