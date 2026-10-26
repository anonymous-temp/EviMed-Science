import { useId, type InputHTMLAttributes, type ReactNode } from "react";
/**
 * Component: Radio; owner: H; rules: DS21, AT48/49.
 * Anatomy: native named radio; caller owns fieldset and legend.
 * Variants: native controls with explicit labels.
 * States: native checked/disabled; error text replaces hint; fieldset belongs to caller.
 * Hit area: label includes a minimum 44px target.
 * Keyboard: native traversal and activation; composition is preserved.
 * Long content: labels and feedback retain text; no list scroller is added.
 * Theme: native radio accent and secondary feedback text; invalid styling is not added.
 * Responsive: full available width; no fixed viewport dimensions.
 * Verification: InputPrimitives.test.tsx; InputPrimitivesGallery; manual AT review pending.
 */
export function Radio({ label, hint, error, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { name: string; label: ReactNode; hint?: string; error?: string }) {
 const generated = useId(); const id = props.id ?? generated;
 return <div><label htmlFor={id} className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 text-ui"><input {...props} id={id} type="radio" aria-describedby={hint || error ? `${id}-help` : undefined} className="h-4 w-4 accent-accent" />{label}</label>{(hint || error) && <p id={`${id}-help`} className="text-ui text-text-2">{error || hint}</p>}</div>;
}
