import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";

/**
 * The pieces every memory row shares (2026-09-23 plan §5.6): a fixed left
 * column saying where the memory belongs, so every sentence starts on one
 * line; the one mark a memory keeps; and the row as it is while being edited.
 */

/** The left column: 关于你, 做法, or a project's name — 128 px of quiet text. */
export function RowOrigin({ label }: { label: string }) {
  return (
    <span title={label} className="w-32 self-start truncate pt-px text-caption text-text-3">
      {label}
    </span>
  );
}

/** EviMed inferred it: the researcher did not say it (principle 18). */
export function InferredMark() {
  return <span className="ml-1.5 whitespace-nowrap text-meta font-normal text-text-3">推断</span>;
}

/** One memory's words in a box, with 取消 and 保存, in the row's own place. */
export function EditingRow({ origin, label, value, busy, onChange, onCancel, onSave, maxLength }: {
  origin: string;
  /** The field's accessible name. */
  label: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  maxLength?: number;
}) {
  return (
    <li className="flex items-start gap-3 rounded px-2 py-3">
      <RowOrigin label={origin} />
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSave(); }}
      >
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
          rows={3}
          maxLength={maxLength}
          className="max-w-measure"
        />
        <div className="mt-2 flex gap-2">
          <Button type="submit" size="sm" loading={busy} disabled={!value.trim()}>保存</Button>
          <Button size="sm" variant="text" onClick={onCancel}>取消</Button>
        </div>
      </form>
    </li>
  );
}

/** What opens under a row's sentence. Above the row's stretched target, so a
 *  link in it is a link and a click in it does not close it. */
export function RowDetail({ children }: { children: ReactNode }) {
  return <div className="relative z-10 mt-2 max-w-measure space-y-2 border-l border-border pl-3 text-caption text-text-3">{children}</div>;
}
