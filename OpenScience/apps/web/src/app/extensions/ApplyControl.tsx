import { Button } from "@/components/ui/Button";

/** A saved configuration requests an apply; its separate status reports actual activation. */
export function ApplyControl({ label, checked, disabled, onChange }: {
  label: string; checked: boolean; disabled?: boolean; showLabel?: boolean; onChange: (next: boolean) => void;
}) {
  return <Button size="sm" variant="text" disabled={disabled} aria-label={`${checked ? "应用停用" : "应用启用"}：${label}`}
    onClick={() => onChange(!checked)}>{checked ? "应用停用" : "应用启用"}</Button>;
}
