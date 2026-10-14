import { cn } from "@/lib/cn";
import { NoteParts, type NotePart } from "@/components/ui/Note";

/**
 * The one sentence at the top of a data page or a tab: what the numbers below it add up to (R19, plan §2.1 T4). It is the
 * page's finding and never a description of the page, and every figure in it that counts something is a link to the things
 * counted — `{ n: 4, onOpen }` narrows the list below to those four.
 *
 * It is the memory map's sentence generalised (`headline()` in `mapModel.ts` is the model): parts, not a string, so a number can
 * be a control without the sentence being cut by hand.
 *
 * `PageShell`'s `headline` slot draws it between the sticky band and the body; a page does not place it by hand. `data-headline`
 * is what the walk reads.
 */
export interface HeadlineProps {
  parts: readonly NotePart[];
  /** For `aria-labelledby` on the region the sentence introduces. */
  id?: string;
  className?: string;
}

export function Headline({ parts, id, className }: HeadlineProps) {
  return (
    <p data-headline="" id={id} className={cn("text-section text-text", className)}>
      <NoteParts parts={parts} />
    </p>
  );
}
