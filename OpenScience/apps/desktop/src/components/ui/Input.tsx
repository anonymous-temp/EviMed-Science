import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Text field primitives (P2-1, spec §7): default / focus(accent border + ring)
 * / error(error border + message slot below) / disabled. Both forward refs and
 * take an optional `label` (associated via id) and `error` (wired with
 * aria-invalid + aria-errormessage).
 *
 * With neither `label` nor `error` they render the bare control, so existing
 * label-wrapping markup (icon inputs, search boxes) can adopt them in place.
 * `inputClasses` exposes the same look for <select> and read-only displays.
 */

const controlBase = cn(
  "w-full rounded-input border bg-surface px-3 text-ui text-text outline-none transition-colors",
  "placeholder:text-muted disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted",
);

function borderClasses(error: boolean): string {
  return error
    ? "border-error focus:border-error focus-visible:ring-2 focus-visible:ring-error/40"
    : "border-border focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40";
}

export function inputClasses({ error = false, className }: { error?: boolean; className?: string } = {}): string {
  return cn(controlBase, "h-9", borderClasses(error), className);
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
        <label htmlFor={id} className="mb-1.5 block text-ui-sm font-medium text-text">
          {label}
        </label>
      )}
      {children}
      {error != null && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-ui-sm text-error">
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
