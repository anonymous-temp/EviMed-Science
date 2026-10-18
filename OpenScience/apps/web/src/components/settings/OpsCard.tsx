import type { ReactNode } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";

/**
 * The operator console's one card (R19.1, the walk of the owner's account; DESIGN.md rules 4 and 7).
 *
 * 运维 was five cards that each wrote the same shell by hand — a bordered box, a header with a 16 px title, a refresh icon and a second
 * bordered box of rows divided by a rule *above* every row but the first — and so drew, on the owner's page, seven colours of text (a green
 * 「通过」 and a blue 「已完成」 for the same good state), four kinds of border (the rule above a row was a different kind from the rule
 * under the header), nine size-and-weight pairs and a refresh drawn as an icon in four cards and as a word in the fifth. They are one
 * component now:
 *
 *  - the title is 14 / 600 like a `Panel`'s, and the one refresh is an icon button;
 *  - a row is a list item whose rule is its *top* (the body's rule under the header is the same kind, and so is a `Panel`'s and a list's),
 *    so the card has two strokes, the box and the rule;
 *  - **a good state has no colour**: a check that passed, a task that finished, an event that went through is the page's ordinary text.
 *    Only what needs a person is coloured — amber for a thing to look at, red for one that failed (`OPS_TONE`);
 *  - an identifier an operator searches the logs for is not page text: it is a copy button (`CopyId`) whose tooltip holds it, beside a
 *    name in words.
 */
export function OpsCard({ title, description, refresh, trailing, children }: {
  title: string;
  description?: string;
  /** The card's refresh: its accessible name, whether it is reading now, and what it does. */
  refresh?: { label: string; loading: boolean; onRefresh: () => void; disabled?: boolean };
  /** Beside the refresh: a count, a state. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-5 rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui font-semibold text-text">{title}</h2>
          {description && <p className="mt-0.5 text-caption text-text-3">{description}</p>}
        </div>
        {trailing}
        {refresh && (
          <IconButton
            icon={RefreshCw}
            label={refresh.label}
            size="sm"
            disabled={refresh.loading || refresh.disabled}
            className={cn("[&_svg]:transition-transform", refresh.loading && "[&_svg]:animate-spin")}
            onClick={refresh.onRefresh}
          />
        )}
      </header>
      {/* The rule under the header is the body's own top rule: every rule on the page is the top of the thing below it (`divide-y`'s kind, a
          Panel's, a list's), so the page has one kind of rule and not a top and a bottom. */}
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

/** The card's body: a padded box with the rows in it. */
export function OpsBody({ children }: { children: ReactNode }) {
  return <div className="px-5 py-4">{children}</div>;
}

/** The rows of a card — a list, because a ledger is one — in the box that holds them. */
export function OpsRows({ label, children }: { label: string; children: ReactNode }) {
  return <ul aria-label={label} className="overflow-hidden rounded-input border border-border">{children}</ul>;
}

/** One row. The rule is its top, the first row has none: the stroke of `divide-y`, a panel and every list. */
export function OpsRow({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn("flex min-h-10 items-center gap-2.5 border-t border-border bg-surface px-3 py-2 text-ui first:border-t-0", className)}>{children}</li>;
}

/** What a list says when it has nothing: one line in the box where the rows would be. */
export function OpsNothing({ children }: { children: ReactNode }) {
  return <li className="bg-surface px-3 py-2.5 text-ui text-text-3">{children}</li>;
}

/**
 * The colour of a state: none for a good one. The cards used a green for a passed check and a blue for a finished task and a pass of the
 * security log — three colours for one thing — and the walk counts every colour of text on a page.
 */
export const OPS_TONE = { ok: "", quiet: "text-text-3", warn: "text-warn", failed: "text-error" } as const;
export type OpsTone = keyof typeof OPS_TONE;

/**
 * An identifier for whoever has to search the logs: a copy button, not a line of text. The tooltip holds the value, the click puts it on
 * the clipboard. What the row says in words stays beside it.
 */
export function CopyId({ value, label }: { value: string; label: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("已复制");
    } catch {
      toast.error("没有复制成功");
    }
  };
  return <IconButton icon={Copy} label={label} size="sm" title={value} onClick={() => void copy()} />;
}
