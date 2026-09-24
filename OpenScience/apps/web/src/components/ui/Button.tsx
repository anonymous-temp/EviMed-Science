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
 * Heights: 24 inside a row (`sm`), 32 on a page (`md`), 40 for a form's
 * primary button (`lg`). The shell mixed 28 / 32 / 36 / 40 / 44 on one screen.
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

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-6 gap-1 px-2 text-ui", // 24 — inside a row
  md: "h-8 gap-1.5 px-3 text-ui", // 32 — a page's controls
  lg: "h-10 gap-2 px-4 text-ui", // 40 — a form's primary button
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
    "disabled:cursor-not-allowed disabled:opacity-40",
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
