import { CircleCheck, TriangleAlert } from "lucide-react";
import type { VcrPopulationCheck } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { ChartCard } from "@/components/ui/ChartCard";
import { numberText } from "../vcrText";

/**
 * The generated population against a SECOND baseline table, variable by variable (remediation plan D2).
 *
 * Every figure and every sentence is the server's (`vcrPopulationCheck.mjs`); the page works out nothing. A row is 接近 or 有差距 by
 * the floor the server names, a mark for the reader and never a pass or a fail, and a variable the check could not put side by side
 * says why in its row. The card says whether the second table was made from other evidence than the population (an independent
 * comparison) or from the same (a comparison with the inputs), and under the table what it did not look at — the correlation between
 * variables and the shape of each distribution — because a check of margins is not a validation of the population.
 */
export function PopulationCheckCard({ check }: { check: VcrPopulationCheck }) {
  return (
    <div data-vcr-population-check="" data-vcr-independent={check.independent ? "true" : "false"}>
      <ChartCard
        title={check.title}
        meta={check.ofEarlierVersion ? "对照的是人群的上一版" : undefined}
        footnote={<span className="flex flex-col gap-1"><span>{check.sentence}</span><span>{check.covered}</span></span>}
      >
        <table className="w-full border-separate border-spacing-0 text-ui">
          <caption className="sr-only">生成的人群和第二份基线表，逐个变量对照</caption>
          <thead>
            <tr className="text-caption text-text-3">
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-left font-normal">变量</th>
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-right font-normal">生成的人群</th>
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-right font-normal">第二份基线表</th>
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-right font-normal">差别</th>
              <th scope="col" className="w-8 border-b border-border px-2 pb-2 pt-1 font-normal"><span className="sr-only">接近还是有差距</span></th>
            </tr>
          </thead>
          <tbody>
            {check.rows.map((row) => (
              <tr key={row.key} data-vcr-check-row={row.key} data-vcr-check-state={row.state}>
                <th scope="row" className="border-b border-faint px-2 py-2.5 text-left font-normal text-text">
                  {row.label}
                  {row.note && <span className="block text-caption text-text-3">{row.note}</span>}
                </th>
                <td className="border-b border-faint px-2 py-2.5 text-right tabular-nums text-text">{row.ours ?? "—"}</td>
                <td className="border-b border-faint px-2 py-2.5 text-right tabular-nums text-text-2">{row.theirs ?? "—"}</td>
                <td className={cn("whitespace-nowrap border-b border-faint px-2 py-2.5 text-right tabular-nums", row.state === "apart" ? "text-warn-strong" : "text-text-2")}>
                  {row.smd !== null ? numberText(row.smd) : row.totalVariation !== null ? `${numberText(row.totalVariation)}（总变异距离）` : row.stateLabel}
                </td>
                <td className="border-b border-faint px-2 py-2.5 text-center">
                  {row.state === "apart" ? (
                    <span role="img" aria-label="和第二份基线表有差距" className="inline-flex text-warn-strong"><TriangleAlert size={16} aria-hidden="true" /></span>
                  ) : row.state === "close" ? (
                    <span role="img" aria-label="和第二份基线表接近" className="inline-flex text-ok"><CircleCheck size={16} aria-hidden="true" /></span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartCard>
    </div>
  );
}
