import { cn } from "@/lib/cn";

/**
 * A variable's distribution in the space of a table cell: one bar per bin, the tallest as high as the cell, no axis and no number —
 * the table has the numbers, this is only the shape (is it a bell, is it lopsided). The bins are the engine's own, equal-width
 * counts of the generated records, drawn as they came.
 *
 * Decoration for a screen reader: the cell beside it says the mean and the spread in words.
 */
export function VcrMiniHistogram({ counts, className }: { counts: readonly number[]; className?: string }) {
  const tallest = Math.max(1, ...counts);
  return (
    <span aria-hidden="true" data-vcr-histogram={counts.length} data-forced-colors="preserve" className={cn("inline-flex h-6 items-end gap-px", className)}>
      {counts.map((count, index) => (
        <span
          key={index}
          className="w-1.5 rounded-t-sm bg-accent"
          style={{ height: `${Math.max(count > 0 ? 8 : 4, Math.round((count / tallest) * 100))}%` }}
        />
      ))}
    </span>
  );
}
