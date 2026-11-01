import { useLayoutEffect, useRef } from "react";

/** A native selection control, including the mixed state of a paged catalogue. */
export function SelectionCheckbox({ label, checked, mixed = false, disabled = false, onChange, showLabel = false }: {
  label: string; checked: boolean; mixed?: boolean; disabled?: boolean; onChange(value: boolean): void; showLabel?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <label className="relative z-sticky inline-flex min-h-sm cursor-pointer items-center gap-2 text-ui text-text-2 has-[:disabled]:cursor-not-allowed">
    <input ref={input} type="checkbox" aria-label={label} checked={checked} disabled={disabled}
      onChange={event => onChange(event.target.checked)} className="h-4 w-4 shrink-0 accent-accent disabled:opacity-50" />
    {showLabel && <span>{label}</span>}
  </label>;
}
