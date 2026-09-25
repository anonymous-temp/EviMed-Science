import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { setGeoBudget } from "@/lib/geoClient";
import { trapTab } from "@/lib/focusTrap";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/**
 * A daily cap to prefill beside a total: a tenth of it, on round hundreds,
 * so a budget lasts at least ten days of placements and a day can still take
 * one order. Only a starting value — the reader changes it freely.
 */
export function suggestedDaily(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(total, Math.max(100, Math.ceil(total / 10 / 100) * 100));
}

/** A money field's text as yuan: a positive number with at most two decimals, else null. */
export function readYuan(text: string): number | null {
  const trimmed = text.trim().replace(/[,，¥￥]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 「设置投放预算」 — the first of the program's two human stops (build spec §0
 * ruling 4). Two numbers in 元: the total for the coverage window and the most
 * a single day may spend, the total prefilled with the tier's suggestion. The
 * control plane enforces both (and the per-order cap); this only asks.
 *
 * A dialog in the shape of `ConfirmDialog`: focus lands on the first field,
 * Tab stays inside, Escape and the backdrop cancel, and focus goes back to
 * whatever opened it.
 */
export function BudgetDialog({
  geoId,
  initial,
  suggestedTotal,
  onSaved,
  onCancel,
}: {
  geoId: string;
  /** The budget already set, when this is a change. */
  initial: { totalCny: number; dailyCny: number } | null;
  suggestedTotal: number | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const startTotal = initial?.totalCny ?? (suggestedTotal && suggestedTotal > 0 ? suggestedTotal : null);
  const startDaily = initial?.dailyCny ?? (startTotal ? suggestedDaily(startTotal) : null);
  const [total, setTotal] = useState(startTotal ? String(startTotal) : "");
  const [daily, setDaily] = useState(startDaily ? String(startDaily) : "");
  const [error, setError] = useState<{ field: "total" | "daily" | "form"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel.current();
      if (event.key === "Tab") trapTab(dialogRef.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const totalCny = readYuan(total);
    const dailyCny = readYuan(daily);
    if (totalCny === null) return setError({ field: "total", message: "请填一个大于 0 的金额，单位元。" });
    if (dailyCny === null) return setError({ field: "daily", message: "请填一个大于 0 的金额，单位元。" });
    if (dailyCny > totalCny) return setError({ field: "daily", message: "每天最多花的钱不能超过总预算。" });
    setError(null);
    setSaving(true);
    void setGeoBudget(geoId, { totalCny, dailyCny })
      .then(() => onSaved())
      .catch((caught: unknown) => {
        setSaving(false);
        setError({ field: "form", message: webErrorMessage(caught, { fallback: "预算没有保存，请稍后重试。" }) });
      });
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-card border border-border bg-surface p-6 shadow-modal"
      >
        <h2 id={titleId} className="text-ui font-semibold text-text">设置投放预算</h2>
        <form className="mt-4 flex flex-col gap-4" onSubmit={submit} noValidate>
          <Input
            ref={firstRef}
            label="总预算（元）"
            inputMode="decimal"
            autoComplete="off"
            value={total}
            onChange={(event) => setTotal(event.target.value)}
            error={error?.field === "total" ? error.message : undefined}
          />
          <Input
            label="每天最多（元）"
            inputMode="decimal"
            autoComplete="off"
            value={daily}
            onChange={(event) => setDaily(event.target.value)}
            error={error?.field === "daily" ? error.message : undefined}
          />
          {error?.field === "form" && <p role="alert" className="text-ui text-danger">{error.message}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={onCancel}>取消</Button>
            <Button type="submit" loading={saving}>保存</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
