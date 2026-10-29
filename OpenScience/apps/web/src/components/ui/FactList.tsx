import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";

/**
 * The one key / value list (R19, plan §3): a definition, an estimand, a source's identity — label at 12 in the secondary
 * colour, value at 14, a hairline between rows. It replaces `VcrFacts`, geo's `Identity` rows and the evidence card's
 * `EvidenceDisclosure`, which were one `dl` written three times.
 *
 * At most `max` (8) rows are drawn; the rest sit behind 「全部 N 项」. A list that needs more than eight rows is a table — or a
 * drawer — and says so by folding: the page never grows a column of seventeen technical parameters (the 方法库 right column).
 * A row with nothing to say is the caller's to leave out, not to draw as 「未注明」.
 */
export interface Fact {
  label: string;
  value: ReactNode;
}

function Rows({ rows, ruled }: { rows: readonly Fact[]; ruled: boolean }) {
  return (
    <>
      {rows.map((row, index) => (
        // A bottom hairline on every row but the last — the kind of line a table's rows have, so a record that holds both draws one.
        // In a framed card (`ruled={false}`) the card's frame is the one line and the rows are told apart by space (DESIGN.md: at most
        // one bordered container deep; separate by space first): a faint rule inside 总览's 项目 card was a fourth kind of border on a
        // data page held to three (the fixture walk of b559d4b7e).
        <div key={`${index}-${row.label}`} className={ruled ? "grid grid-cols-[6rem_1fr] gap-3 border-b border-faint py-2 last:border-b-0" : "grid grid-cols-[6rem_1fr] gap-3 py-1.5"}>
          <dt className="text-caption text-text-3">{row.label}</dt>
          <dd className="min-w-0 text-ui text-text">{row.value}</dd>
        </div>
      ))}
    </>
  );
}

/**
 * Component: FactList; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Definition rows plus a disclosure for rows beyond max.
 * Variants: Configurable first-row count, default eight.
 * States: Static source rows; native disclosure expands remainder.
 * Hit area: Only remainder disclosure is interactive.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Values retained; six-rem labels and min-w-0 values share each row.
 * Theme: Secondary label and main value text with faint dividers.
 * Responsive: Two-column facts remain at narrow widths; caller owns unbreakable values.
 * Verification: DataPrimitives.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function FactList({ rows, max = 8, ruled = true, className }: {
  rows: readonly Fact[];
  max?: number;
  /** `false` inside a framed card: no rule between rows, the card's frame is the line. */
  ruled?: boolean;
  className?: string;
}) {
  const shown = rows.slice(0, max);
  const rest = rows.slice(max);
  return (
    <div data-fact-list="" className={className}>
      <dl>
        <Rows rows={shown} ruled={ruled} />
      </dl>
      {rest.length > 0 && (
        <Disclosure summary={`全部 ${rows.length} 项`} className="mt-1">
          <dl>
            <Rows rows={rest} ruled={ruled} />
          </dl>
        </Disclosure>
      )}
    </div>
  );
}
