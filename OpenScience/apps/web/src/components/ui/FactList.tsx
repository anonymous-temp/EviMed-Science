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

function Rows({ rows }: { rows: readonly Fact[] }) {
  return (
    <>
      {rows.map((row, index) => (
        // A bottom hairline on every row but the last — the kind of line a table's rows have, so a record that holds both draws one.
        <div key={`${index}-${row.label}`} className="grid grid-cols-[6rem_1fr] gap-3 border-b border-faint py-2 last:border-b-0">
          <dt className="text-caption text-text-3">{row.label}</dt>
          <dd className="min-w-0 text-ui text-text">{row.value}</dd>
        </div>
      ))}
    </>
  );
}

export function FactList({ rows, max = 8, className }: { rows: readonly Fact[]; max?: number; className?: string }) {
  const shown = rows.slice(0, max);
  const rest = rows.slice(max);
  return (
    <div data-fact-list="" className={className}>
      <dl>
        <Rows rows={shown} />
      </dl>
      {rest.length > 0 && (
        <Disclosure summary={`全部 ${rows.length} 项`} className="mt-1">
          <dl>
            <Rows rows={rest} />
          </dl>
        </Disclosure>
      )}
    </div>
  );
}
