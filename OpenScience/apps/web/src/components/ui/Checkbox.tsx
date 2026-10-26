import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode } from "react";
/**
 * Component: Checkbox; owner: H; rules: DS21, AT48/49.
 * Anatomy: native checkbox with linked label and feedback.
 * Variants: native controls with explicit labels.
 * States: native checked/disabled, imperative mixed state, error and help.
 * Hit area: label includes a minimum 44px target.
 * Keyboard: native traversal and activation; composition is preserved.
 * Long content: labels and feedback retain text; no list scroller is added.
 * Theme: semantic surface, control border, text and error roles.
 * Responsive: full available width; no fixed viewport dimensions.
 * Verification: InputPrimitives.test.tsx; InputPrimitivesGallery; manual AT review pending.
 */
export function Checkbox({ label, mixed = false, hint, error, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; mixed?: boolean; hint?: string; error?: string }) {
 const generated = useId(); const id = props.id ?? generated; const ref = useRef<HTMLInputElement>(null);
 useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
 return <div><label htmlFor={id} className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 text-ui"><input {...props} ref={ref} id={id} type="checkbox" aria-checked={mixed ? "mixed" : props.checked} aria-invalid={!!error || undefined} aria-describedby={hint || error ? `${id}-help` : undefined} className="h-4 w-4 accent-accent" />{label}</label>{(error || hint) && <p id={`${id}-help`} className={error ? "text-error text-ui" : "text-text-2 text-ui"}>{error || hint}</p>}</div>;
}
