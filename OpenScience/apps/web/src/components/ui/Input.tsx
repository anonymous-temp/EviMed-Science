import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Text field primitives (spec §18.2): default / focus / error (error border +
 * message slot below) / disabled. Both forward refs and take an optional
 * `label` (associated via id) and `error` (wired with aria-invalid +
 * aria-errormessage).
 *
 * With neither `label` nor `error` they render the bare control, so existing
 * label-wrapping markup (icon inputs, search boxes) can adopt them in place.
 * `inputClasses` exposes the same look for <select> and read-only displays.
 *
 * 36 px tall (`h-control`; appendix E #9) and 8 px round, so a field, the
 * button beside it and the kernel's own inputs line up. 16 px text below
 * 768 px, so iOS does not zoom the page when a field takes focus (§18.1).
 *
 * Focus is the border turning `--focus` plus a 1 px inner line of the same
 * colour — 2 px in all — and the line is an *outline*, not a `ring-*` box
 * shadow: forced-colours mode removes shadows, and the field's focus went with
 * it (appendix E #1). The global rule gives every text field a transparent
 * outline; these utilities colour it and pull it inside the border.
 */

const controlBase = cn(
  "w-full rounded border bg-surface px-3 text-ui text-text outline-none transition-colors duration-fast max-md:text-body",
  "placeholder:text-text-3 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-3",
  "focus:outline-1 focus:-outline-offset-2",
);

function borderClasses(error: boolean): string {
  return error
    ? "border-error focus:border-error focus:outline-error"
    // `border-control`: a text field's edge is the only thing that says where
    // it is, so it gets the 3:1 control boundary, not the decorative hairline.
    : "border-border-control focus:border-focus focus:outline-focus";
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
  children: ReactNode;
}

/** Label above, control in the middle, error message below — one field block. */
function FieldShell({ id, label, error, children }: FieldShellProps) {
  if (!label && !error) return <>{children}</>;
  return (
    <div>
      {label != null && (
        <label htmlFor={id} className="mb-2 block text-ui font-medium text-text">
          {label}
        </label>
      )}
      {children}
      {error != null && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-ui text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  /** Error message shown under the control; also switches to error styling. */
  error?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hasError = error != null;
  return (
    <FieldShell id={inputId} label={label} error={error}>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={hasError || undefined}
        aria-errormessage={hasError ? `${inputId}-error` : undefined}
        className={inputClasses({ error: hasError, className })}
        {...rest}
      />
    </FieldShell>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: ReactNode;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hasError = error != null;
  return (
    <FieldShell id={inputId} label={label} error={error}>
      <textarea
        ref={ref}
        id={inputId}
        aria-invalid={hasError || undefined}
        aria-errormessage={hasError ? `${inputId}-error` : undefined}
        className={textareaClasses({ error: hasError, className })}
        {...rest}
      />
    </FieldShell>
  );
});
