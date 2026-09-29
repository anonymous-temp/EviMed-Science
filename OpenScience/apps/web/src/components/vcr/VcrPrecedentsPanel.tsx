import { useState } from "react";
import { getVcrPrecedents } from "@/lib/vcrClient";
import { DataTable } from "@/components/ui/DataTable";
import { SearchInput } from "@/components/ui/SearchInput";
import { useVcrLoad, VcrTabError, VcrToolbar } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";
import { numberText } from "./vcrText";

/**
 * 试验先例: what comparable trials actually planned and what they actually
 * enrolled.
 *
 * Planned and actual are two columns and never one. A registry's estimated
 * enrolment is what a sponsor hoped for and is the thing being tested here;
 * using it as a historical benchmark would feed this platform's own forecasts
 * the optimism it exists to correct (plan §6.4).
 */
export function VcrPrecedentsPanel() {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const { state, reload } = useVcrLoad(`vcr:precedents:${asked}`, () => getVcrPrecedents(asked ? { q: asked } : {}));

  return (
    <div className="flex flex-col gap-4">
      <VcrToolbar summary={state.kind === "ready" ? `${state.data.precedents.length} 项` : undefined}>
        <SearchInput
          label="搜索先例"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") setAsked(query.trim()); }}
        />
      </VcrToolbar>

      {state.kind === "loading" ? <VcrTabSkeleton />
        : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} />
          : (
            <DataTable
              label="试验先例"
              minWidth="min-w-[48rem]"
              emptyText="没有找到先例。换一个检索词，或者让 AI 去找。"
              columns={[
                {
                  key: "registry",
                  header: "登记号",
                  rowHeader: true,
                  cell: (row) => (
                    <span className="block">
                      <span className="block tabular-nums text-text">{row.registryId}</span>
                      <span className="block text-caption text-text-3">{[row.registry, row.population].filter(Boolean).join(" · ")}</span>
                    </span>
                  ),
                },
                { key: "design", header: "设计", isEmpty: (row) => !row.design, cell: (row) => row.design ?? "—" },
                {
                  key: "enrolment",
                  header: "计划 / 实际入组",
                  align: "right",
                  cell: (row) => (
                    <span className="tabular-nums">
                      <span className="text-text-3">{numberText(row.planned, 0)}</span>
                      <span className="mx-1 text-text-3">/</span>
                      <span className="font-medium text-text">{numberText(row.actual, 0)}</span>
                    </span>
                  ),
                },
                { key: "sites", header: "中心数", align: "right", isEmpty: (row) => row.sites == null, cell: (row) => numberText(row.sites, 0) },
                {
                  key: "months",
                  header: "入组月数",
                  align: "right",
                  isEmpty: (row) => row.plannedMonths == null && row.actualMonths == null,
                  cell: (row) => (
                    <span className="tabular-nums">
                      <span className="text-text-3">{numberText(row.plannedMonths, 0)}</span>
                      <span className="mx-1 text-text-3">→</span>
                      <span className="text-text">{numberText(row.actualMonths, 0)}</span>
                    </span>
                  ),
                },
                {
                  key: "rate",
                  header: "每中心每月",
                  align: "right",
                  isEmpty: (row) => row.perSitePerMonth == null,
                  cell: (row) => numberText(row.perSitePerMonth, 2),
                },
              ]}
              rows={state.data.precedents}
              rowKey={(row) => row.id}
              rowAttrs={(row) => ({ "data-vcr-precedent": row.registryId })}
              footnote={state.data.sources ?? "计划值取自登记记录的预计字段，只用于对照；历史基准只用实际值。"}
            />
          )}
    </div>
  );
}
