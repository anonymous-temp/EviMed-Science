import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one button (P2-1, spec §7): variant primary(accent)/ghost/danger ×
 * size sm/md/lg, with hover/active/disabled/loading states and the global
 * focus ring. `loading` shows an inline spinner and blocks clicks. Defaults to
 * type="button" so it never submits a form by accident.
 *
 * Heights come from the one table (DESIGN.md): 28 compact, 32 standard, 40 for
 * a form's primary button and nothing else. The shell used to mix 32 / 36 / 40
 * on one screen, which is half of what made it read as a different product
 * from the conversation beside it.
 *
 * `buttonClasses` exposes the same look as a class string for the rare cases
 * that cannot render a <button> (e.g. an <a> that must keep link semantics).
 */

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  // `accent-pressed` rather than an opacity step: an alpha on a token colour
  // generates no CSS here, and a pressed accent is its own value.
  primary: "bg-accent text-accent-fg hover:opacity-90 active:bg-accent-pressed",
  // The secondary button's border is its only edge: the control boundary.
  ghost: "border border-strong bg-surface text-text hover:bg-surface-2 active:bg-surface-2",
  danger: "bg-error text-error-fg hover:opacity-90 active:opacity-80",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-7 gap-1 px-2 text-ui", // 28 — dense rows and toolbars
  md: "h-8 gap-1 px-3 text-ui", // 32 — the standard control
  lg: "h-10 gap-2 px-4 text-ui", // 40 — a form's primary button
};

const spinnerSizes: Record<ButtonSize, number> = { sm: 12, md: 14, lg: 16 };

export function buttonClasses({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded font-medium outline-none transition-colors",
    // No ring here: the global `:focus-visible` outline in index.css draws the
    // 2 px focus ring on every control alike. This ring's offset defaulted to
    // white and drew a white halo on dark surfaces (review B §2.1).
    "disabled:cursor-not-allowed disabled:opacity-40",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, type = "button", disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, className })}
      {...rest}
    >
      {loading && <Loader2 size={spinnerSizes[size]} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});
