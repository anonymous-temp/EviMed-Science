import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * The one metadata tag: 22 px high (`h-tag`, spec §20.4 — it was 20), 12 px
 * text, a 6 px corner, a quiet ground and no border. It is not clickable — a
 * clickable chip is a filter (`FilterChips`). Its props have no handler and
 * no role on purpose: `<Tag onClick>` does not compile, and the shape of a tag
 * on a `<button>` (`tagClasses` outside this file) is what the layout lint
 * names. `data-tag` is what the walk and `pageComposition.test.tsx` read: a
 * tag inside a control, or with a role, is a control dressed as a label.
 *
 * Neutral is the default for metadata and popularity. `safety`, `accent`
 * and `warn` remain explicit tones; callers must assign a semantic role,
 * never infer evidence quality from popularity. There were about seventeen tag
 * recipes, five of them on one frontier card (2026-09-23 inventory §2.1); a
 * screen now carries at most two kinds — this one, and a filter chip.
 */
export type TagTone = "neutral" | "safety" | "accent" | "warn";

const toneClasses: Record<TagTone, string> = {
  neutral: "bg-surface-2 text-text-2",
  safety: "bg-danger-soft text-danger-strong",
  accent: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn-strong",
};

export function tagClasses({ tone = "neutral", className }: { tone?: TagTone; className?: string } = {}): string {
  return cn(
    "inline-flex h-tag shrink-0 items-center whitespace-nowrap rounded-tag px-1.5 text-meta font-normal",
    toneClasses[tone],
    className,
  );
}

/**
 * Component: Tag; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Static metadata span with optional label Tooltip.
 * Variants: neutral/safety/accent/warn; no action handlers.
 * States: Supplied tone; not a verification or interaction state.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Single-line nowrap metadata; tooltip may expand abbreviations.
 * Theme: Neutral metadata or explicit semantic tone; no inferred popularity meaning.
 * Responsive: Intrinsic nonshrinking h-tag label.
 * Verification: Primitives.test.tsx and lookKinds.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function Tag({
  tone = "neutral",
  title,
  className,
  children,
}: {
  tone?: TagTone;
  /** A tooltip (`Tooltip`), only when the tag abbreviates something: what it stands for. */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const tag = <span data-tag="" className={tagClasses({ tone, className })}>{children}</span>;
  return title ? <Tooltip content={title}>{tag}</Tooltip> : tag;
}
