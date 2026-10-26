import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Component: Input; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: label, shared control, safe prefix/suffix/unit and help/error.
 * Variants: text, select, textarea; compact and standard geometry.
 * States: default, independent ink focus, error and disabled.
 * Hit area: standard 36px field; compact 28px control.
 * Keyboard: native editing, selection and composition.
 * Long content: hints/errors wrap; slots retain their space.
 * Theme: semantic field border, surface, ink and error roles.
 * Responsive: mobile text avoids focus zoom.
 * Verification: Input and NumberField behavioral tests.
 */

const controlBase = cn(
  "w-full rounded border bg-surface px-3 text-ui text-text outline-none transition-colors duration-fast max-md:text-body",
  "placeholder:text-text-3 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-3",
  "focus:outline-2 focus:outline-offset-2",
);

function borderClasses(error: boolean): string {
  return error
    ? "border-error focus:border-error focus:outline-focus-input"
    // `border-control`: a text field's edge is the only thing that says where
    // it is, so it gets the 3:1 control boundary, not the decorative hairline.
    : "border-border-control focus:border-focus-input focus:outline-focus-input";
}

export function inputClasses({ error = false, size = "md", className }: {
  error?: boolean;
  /** `md` 36 on a page or a form; `sm` 28 inside a table or a toolbar. */
  size?: "sm" | "md";
  className?: string;
} = {}): string {
  return cn(controlBase, size === "sm" ? "h-sm" : "h-control", borderClasses(error), className);
}

export function textareaClasses({ error = false, className }: { error?: boolean; className?: string } = {}): string {
  return cn(controlBase, "min-h-20 resize-y py-2", borderClasses(error), className);
}

interface FieldShellProps {
  id: string;
  label?: ReactNode;
  error?: ReactNode;
  /** What the field expects, said before anything goes wrong (`${id}-hint`); the error takes its place when there is one. */
  hint?: ReactNode;
  children: ReactNode;
}

/** Label above, control in the middle, error message (or the hint) below — one field block. */
function FieldShell({ id, label, error, hint, children }: FieldShellProps) {
  if (!label && !error && !hint) return <>{children}</>;
  return (
    <div className="min-w-0">
      {label != null && (
        <label htmlFor={id} className="mb-2 block text-ui text-text">
          {label}
        </label>
      )}
      {children}
      {error != null ? (
        <p id={`${id}-error`} role="alert" className="mt-2 text-ui text-error">
          {error}
        </p>
      ) : hint != null && (
        <p id={`${id}-hint`} className="mt-2 text-caption text-text-3">
          {hint}
        </p>
      )}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: ReactNode;
  /** Error message shown under the control; also switches to error styling. */
  error?: ReactNode;
  /**
   * A control inside the field's right edge — the password field's 「显示密码」.
   * One `IconButton` `size="sm"` (28 in a 36 field); the text stops before it.
   */
  trailing?: ReactNode;
  prefix?: ReactNode;
  suffix?: ReactNode;
  unit?: string;
  /** What the field expects, under the control and in its description (`aria-describedby`), until an error replaces it. */
  hint?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, id, className, trailing, prefix, suffix, unit, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hasError = error != null;
  const control = (
    <input
      ref={ref}
      id={inputId}
      aria-invalid={hasError || undefined}
      aria-errormessage={hasError ? `${inputId}-error` : undefined}
      aria-describedby={!hasError && hint != null ? `${inputId}-hint` : undefined}
      className={inputClasses({ error: hasError, className: cn(trailing != null && "pr-11", className) })}
      {...rest}
    />
  );
  return (
    <FieldShell id={inputId} label={label} error={error} hint={hint}>
      {trailing == null && prefix == null && suffix == null && !unit ? control : (
        <div className="flex items-center gap-2">
          {prefix != null && <span className="shrink-0 text-ui text-text-3">{prefix}</span>}
          <div className="relative min-w-0 flex-1">{control}
          <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div></div>
          {(suffix != null || unit) && <span className="shrink-0 text-ui text-text-3">{suffix}{unit}</span>}
        </div>
      )}
    </FieldShell>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
}

/** Native selection uses the same field shell and control geometry as text/date/time inputs. */
/**
 * Component: Select; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Labelled native select with linked error/hint and caller options.
 * Variants: Native select options and attributes.
 * States: Error takes precedence over hint; IDs are generated unless supplied; native disabled remains native.
 * Hit area: Full-width shared input geometry; child action supplies its own target.
 * Keyboard: Native editing/selection; no submit or composition interception.
 * Long content: Native option presentation is browser-owned; label/error/hint wrap.
 * Theme: Surface/control-border/error and ink-focus roles.
 * Responsive: Fluid width; text size increases below md.
 * Verification: Input.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, id, className, children, ...rest }, ref,
) {
  const autoId = useId(), inputId = id ?? autoId, hasError = error != null;
  return <FieldShell id={inputId} label={label} error={error} hint={hint}>
    <select ref={ref} id={inputId} aria-invalid={hasError || undefined}
      aria-errormessage={hasError ? `${inputId}-error` : undefined}
      aria-describedby={!hasError && hint != null ? `${inputId}-hint` : undefined}
      className={inputClasses({ error: hasError, className })} {...rest}>{children}</select>
  </FieldShell>;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
}

/**
 * Component: Textarea; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Labelled native textarea with linked error/hint.
 * Variants: Native textarea attributes; vertically resizable.
 * States: Error takes precedence over hint; IDs are generated unless supplied; native disabled remains native.
 * Hit area: Full-width shared input geometry; child action supplies its own target.
 * Keyboard: Native editing/selection; no submit or composition interception.
 * Long content: Multiline text scrolls; minimum height and user vertical resizing retained.
 * Theme: Surface/control-border/error and ink-focus roles.
 * Responsive: Fluid width; text size increases below md.
 * Verification: Input.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hasError = error != null;
  return (
    <FieldShell id={inputId} label={label} error={error} hint={hint}>
      <textarea
        ref={ref}
        id={inputId}
        aria-invalid={hasError || undefined}
        aria-errormessage={hasError ? `${inputId}-error` : undefined}
        aria-describedby={!hasError && hint != null ? `${inputId}-hint` : undefined}
        className={textareaClasses({ error: hasError, className })}
        {...rest}
      />
    </FieldShell>
  );
});
