import { useEffect, useRef, useState } from "react";
import { Input, type InputProps } from "./Input";
import { formatQuantity, parseQuantity, type QuantityPolicy } from "@/lib/quantity";

/**
 * Component: NumberField; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: labelled draft input, unit and persistent validation message.
 * Variants: scalar, percentage display and canonical fraction.
 * States: blank/invalid drafts survive; finite valid values are canonical.
 * Hit area: full native text input.
 * Keyboard: decimal input; native form validity blocks invalid submission.
 * Long content: hint and error wrap through Input.
 * Theme: shared Input semantic roles.
 * Responsive: shared Input touch geometry.
 * Verification: NumberField.test.tsx and lib/quantity.test.ts; native validity/AT remain browser checks.
 */
export function NumberField({ value, onValueChange, policy, example, ...props }: Omit<InputProps, "value" | "onChange" | "type" | "min" | "max" | "step"> & {
  value: unknown;
  onValueChange: (value: number | string | undefined) => void;
  policy: QuantityPolicy;
  example: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const lastEmitted = useRef<unknown>(value);
  const raw = draft !== null && Object.is(value, lastEmitted.current) ? draft : typeof value === "number" ? formatQuantity(value, policy) : typeof value === "string" ? value : "";
  const validate = (input: HTMLInputElement, next: string) => {
    const parsed = !props.required && next.trim() === "" ? { ok: true as const, value: undefined } : parseQuantity(next, policy);
    input.setCustomValidity(parsed.ok ? "" : parsed.error);
    setError(parsed.ok ? undefined : parsed.error);
    const emitted = parsed.ok ? parsed.value : next;
    lastEmitted.current = emitted;
    onValueChange(emitted);
    return parsed;
  };
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const replaced = !Object.is(value, lastEmitted.current);
    if (replaced) {
      lastEmitted.current = value;
      setDraft(null);
    }
    // An authoritative scenario change also replaces feedback, not just the
    // input's native validity. Untouched optional absence is not numeric zero.
    const optionalAbsence = !props.required && raw.trim() === "";
    const parsed = optionalAbsence ? { ok: true as const } : parseQuantity(raw, policy);
    input.setCustomValidity(parsed.ok ? "" : parsed.error);
    setError(parsed.ok ? undefined : parsed.error);
    // Revalidate at form submission too; a programmatic requestSubmit cannot reuse an old valid value.
    const submit = (event: Event) => {
      if (!props.required && input.value.trim() === "") return;
      const current = parseQuantity(input.value, policy);
      if (!current.ok) { input.setCustomValidity(current.error); setError(current.error); event.preventDefault(); event.stopImmediatePropagation(); input.reportValidity(); }
    };
    const form = input.form;
    form?.addEventListener("submit", submit, true);
    return () => form?.removeEventListener("submit", submit, true);
  }, [raw, policy, draft, value, props.required]);
  return <Input ref={inputRef} {...props} type="text" inputMode={policy.integer ? "numeric" : "decimal"} value={raw}
    unit={policy.unit} hint={<>{props.hint}{props.hint && " · "}例如 {example}</>} error={error ?? props.error}
    onChange={event => { setDraft(event.target.value); validate(event.currentTarget, event.target.value); }}
    onBlur={event => { const parsed = validate(event.currentTarget, event.currentTarget.value); if (parsed.ok) setDraft(parsed.value === undefined ? "" : formatQuantity(parsed.value, policy)); props.onBlur?.(event); }} />;
}
