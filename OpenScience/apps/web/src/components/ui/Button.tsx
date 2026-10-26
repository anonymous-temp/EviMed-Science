import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Component: Button; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: optional spinner slot and visible action label.
 * Variants: primary, secondary, text, danger; ghost aliases secondary; sm/md/lg.
 * States: loading keeps focus and guards activation even with legacy disabled=busy; idle prerequisites use native disabled.
 * Hit area: token control heights; caller chooses size.
 * Keyboard: native Enter/Space with busy duplicate guards.
 * Long content: single-line intrinsic label width.
 * Theme: semantic action and foreground tokens.
 * Responsive: intrinsic or caller full width.
 * Verification: Button.test.tsx; browser geometry and AT remain separate.
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
  // 28 — inside a row, a table, a toolbar. 14 / 400 like the chip beside it and the page's own text: a small control at 13 / 400 (and,
  // before that, 13 / 500) was a size pair of its own on every page that held a toolbar (the walk's `type-pairs`), and the fonts a Chinese
  // reader's Windows carries draw 500 as 400 anyway. Since R19.2 that holds for every size: the base is `font-normal`, and what makes a
  // button a button is its ground, its border and its colour.
  sm: "h-sm gap-1 px-2.5 text-ui",
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
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded font-normal outline-none transition-colors duration-fast",
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
  /** Shows a spinner, sets aria-busy and guards activation without losing focus. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", destructive = false, loading, type = "button", disabled, className, children, onClick, onKeyDown, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled && !loading}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, destructive, className })}
      {...rest}
      onClick={(event) => { if (loading) { event.preventDefault(); event.stopPropagation(); return; } onClick?.(event); }}
      onKeyDown={(event) => { if (loading && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); return; } onKeyDown?.(event); }}
    >
      {loading !== undefined && <span aria-hidden="true" className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        {loading && <Loader2 size={16} className="animate-spin" />}
      </span>}
      {children}
    </button>
  );
});
