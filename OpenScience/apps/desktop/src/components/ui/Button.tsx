import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one button (P2-1, spec §7): variant primary(accent)/ghost/danger ×
 * size sm/md, with hover/active/disabled/loading states and a focus-visible
 * ring. `loading` shows an inline spinner and blocks clicks. Defaults to
 * type="button" so it never submits a form by accident.
 *
 * `buttonClasses` exposes the same look as a class string for the rare cases
 * that cannot render a <button> (e.g. an <a> that must keep link semantics).
 */

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90 active:opacity-80",
  ghost: "border border-border bg-surface text-text hover:bg-surface-2 active:bg-border/40",
  danger: "bg-error text-error-fg hover:opacity-90 active:opacity-80",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 gap-1 px-3 text-ui-sm",
  md: "h-9 gap-1.5 px-3.5 text-ui",
};

const spinnerSizes: Record<ButtonSize, number> = { sm: 12, md: 14 };

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
    "inline-flex shrink-0 items-center justify-center rounded-input font-medium outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
    "disabled:cursor-not-allowed disabled:opacity-50",
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
