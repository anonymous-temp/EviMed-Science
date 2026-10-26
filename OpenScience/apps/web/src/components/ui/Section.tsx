import { createContext, useContext, useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type HeadingLevel = 2 | 3 | 4 | 5 | 6;
/** The level a block's heading takes where it stands: 2 at the page's level, one more inside each `Section` or card. */
const BlockHeadingLevel = createContext<HeadingLevel>(2);

/**
 * The heading level of a card that stands where it is mounted (a `ChartCard`, a step's state card): `h2` at the page's level, `h3`
 * inside a `Section`, `h4` inside a `level="sub"` one. A card that always said `h3` skipped a level wherever it followed the page's
 * title directly (axe `heading-order`, the 虚拟临床研究 推演 and 试验设计 tabs, r19-guards2).
 */
export function useBlockHeadingLevel(): HeadingLevel {
  return useContext(BlockHeadingLevel);
}

/** What is inside a block whose heading is `level`: its own headings are one level below it. */
/**
 * Component: HeadingLevelScope; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Context provider for child block headings; no DOM wrapper.
 * Variants: Numeric parent heading level.
 * States: Derived child level is parent + 1, capped at six.
 * Hit area: No DOM or interaction target.
 * Keyboard: No focus behavior.
 * Long content: Children pass through unchanged.
 * Theme: No styling.
 * Responsive: No layout.
 * Verification: DataPrimitives.test.tsx and ChartCard.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function HeadingLevelScope({ level, children }: { level: number; children: ReactNode }) {
  return <BlockHeadingLevel.Provider value={Math.min(6, level + 1) as HeadingLevel}>{children}</BlockHeadingLevel.Provider>;
}

/** A heading at the level of where it stands (`useBlockHeadingLevel`): a part of a card, a group of a list. */
/**
 * Component: BlockHeading; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Semantic h2-h6 selected by surrounding HeadingLevelScope.
 * Variants: Caller className and content.
 * States: Context determines level; no interactive state.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Heading text retained without clipping.
 * Theme: Caller chooses semantic text classes.
 * Responsive: Native block flow.
 * Verification: DataPrimitives.test.tsx and ChartCard.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function BlockHeading({ className, children }: { className?: string; children: ReactNode }) {
  const Heading = `h${useBlockHeadingLevel()}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return <Heading className={className}>{children}</Heading>;
}

/**
 * The one block heading of a page or a tab (R19, plan §3): the heading at 18 / 600, a count after it and, at the far end, a
 * slot for the controls of that block alone — a `Toolbar` over one table, a 「下载」 button. It replaces `TabSection` (geo),
 * `VcrSection` (vcr) and the `Panel` title that outsized its box; the same heading drawn four ways was four chances at a type
 * size of its own.
 *
 * `level="sub"` is the nested case: a block inside a block takes the 14 / 600 rung and the next heading level, so the outline
 * still reads page title, block, part — and a section never adds a size beyond the four a page may hold.
 *
 * ```tsx
 * <Section title="试验先例" count={12} toolbar={<Toolbar filters={…} />}>
 *   <DataTable … />
 * </Section>
 * ```
 */
/**
 * Component: Section; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Named section with heading/count, toolbar and nested heading context.
 * Variants: section/sub; compact preserves semantic rank.
 * States: Static grouping; caller owns child read states.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Heading/count retained; header wraps toolbar.
 * Theme: Main or compact secondary text; token spacing.
 * Responsive: Wrapping header and min-width-zero title.
 * Verification: DataPrimitives.test.tsx and Composition.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function Section({ title, count, toolbar, level = "section", compact = false, className, children }: {
  title: string;
  /** A grey count at the heading's end: 12, or 「3 / 12」. */
  count?: number | string;
  /** The controls of this block alone, at the heading's far end. */
  toolbar?: ReactNode;
  level?: "section" | "sub";
  /** Quiet catalogue groups retain their semantic heading level without competing with item titles. */
  compact?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  const Heading = level === "sub" ? "h3" : "h2";
  return (
    <section aria-labelledby={headingId} className={cn(level === "sub" || compact ? "mt-6 first:mt-0" : "mt-8 first:mt-0", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <Heading id={headingId} className={cn("min-w-0 font-semibold", compact ? "text-ui text-text-2" : level === "sub" ? "text-ui text-text" : "text-section text-text")}>{title}</Heading>
          {count !== undefined && <span className="shrink-0 text-caption tabular-nums text-text-3">{count}</span>}
        </div>
        {toolbar}
      </div>
      <HeadingLevelScope level={level === "sub" ? 3 : 2}>{children}</HeadingLevelScope>
    </section>
  );
}
