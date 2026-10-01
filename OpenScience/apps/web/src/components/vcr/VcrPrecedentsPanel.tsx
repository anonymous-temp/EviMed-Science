import { VcrRegistryCoverage } from "./VcrRegistryCoverage";
import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { getVcrPrecedents, type VcrPrecedent } from "@/lib/vcrClient";
import { safeLink } from "@/lib/frontierClient";
import { cn } from "@/lib/cn";
import { drawnColumns, type DataColumn } from "@/components/ui/DataTable";
import { SearchInput } from "@/components/ui/SearchInput";
import { useVcrLoad, VcrFacts, VcrTabError, VcrToolbar } from "./vcrTabKit";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { numberText } from "./vcrText";

/** What a registry's enrolment figure is: what happened, or what a sponsor hoped for. */
const ENROLMENT_KIND: Readonly<Record<string, string>> = Object.freeze({ actual: "实际", anticipated: "预计", estimated: "预计" });

/**
 * 试验先例: what comparable trials actually planned and what they actually
 * enrolled.
 *
 * Planned and actual are two columns and never one. A registry's estimated
 * enrolment is what a sponsor hoped for and is the thing being tested here;
 * using it as a historical benchmark would feed this platform's own forecasts
 * the optimism it exists to correct (plan §6.4).
 *
 * Hidden knowledge:
 *  - `q` is the server's own query word; the search asks for it on Enter.
 *  - **A library that is not composed on this deployment is not an empty
 *    one.** The server answers `available: false` with a sentence, and that
 *    sentence is what shows — never a table that reads as 「没有先例」.
 */
export function VcrPrecedentsPanel() {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const { state, reload } = useVcrLoad(`vcr:precedents:${asked}`, () => getVcrPrecedents(asked ? { q: asked } : {}));
  if (state.kind === "error" && state.off) return <p className="py-12 text-center text-ui text-text-3">{VCR_OFF_SENTENCE}</p>;
  if (state.kind === "ready" && !state.data.available) {
    return (
      <p data-vcr-precedents-unavailable="" className="py-12 text-center text-ui text-text-3">
        {state.data.message ?? "试验先例库在本部署尚未接入。"}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "ready" && <VcrRegistryCoverage sources={state.data.registryCoverage} />}
      <VcrToolbar summary={state.kind === "ready" ? `${state.data.precedents.length} 项` : undefined}>
        <SearchInput
          label="搜索先例"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value.trim()) setAsked("");
          }}
          onKeyDown={(event) => { if (event.key === "Enter") setAsked(query.trim()); }}
        />
      </VcrToolbar>

      {state.kind === "loading" ? <VcrTabSkeleton />
        : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} />
          : state.data.precedents.length === 0
            ? <p className="py-6 text-ui text-text-3">{asked ? "没有找到先例。换一个检索词试试。" : "先例库里还没有先例。"}</p>
            : (
              <VcrPrecedentTable
                rows={state.data.precedents}
                footnote={state.data.sources ?? "计划值取自登记记录的预计字段，只用于对照；历史基准只用实际值。"}
              />
            )}
    </div>
  );
}

/** Whether a row has anything past its one line to open. */
function hasDetail(row: VcrPrecedent): boolean {
  return Boolean(row.title || row.eligibilityText || row.countries?.length || row.interventions?.length
    || row.endpoints?.length || row.enrollmentKind || row.hasResults != null || safeLink(row.source));
}

/**
 * The precedent table both the library and a study's 数据与证据 tab read.
 *
 * One line per trial, planned and actual in columns of their own; a row opens
 * to the rest of what the registry says (plan §6.4) — the title, countries,
 * interventions, endpoints and the eligibility **as written**, beside the
 * normalised population it was reduced to, so a reader can check the
 * reduction. The source opens only through a checked `http(s)` link.
 */
export function VcrPrecedentTable({ rows, footnote, withUse = false }: {
  rows: readonly VcrPrecedent[];
  footnote?: ReactNode;
  /** The 「用于」 column: which parameter of this study the trial fed. */
  withUse?: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const columns: Array<DataColumn<VcrPrecedent>> = [
    {
      key: "registry",
      header: "登记号",
      rowHeader: true,
      cell: (row) => {
        const expandable = hasDetail(row);
        const body = (
          <span className="block min-w-0">
            <span className="block tabular-nums text-text">{row.registryId}</span>
            <span className="block text-caption text-text-3">{[row.registry, row.population].filter(Boolean).join(" · ")}</span>
          </span>
        );
        if (!expandable) return body;
        return (
          <button
            type="button"
            aria-expanded={open.has(row.id)}
            aria-controls={`vcr-precedent-${row.id}`}
            onClick={() => toggle(row.id)}
            className="flex w-full items-start gap-1 text-left"
          >
            <ChevronRight
              size={16}
              aria-hidden="true"
              className={cn("mt-0.5 shrink-0 text-text-3 transition-transform duration-fast", open.has(row.id) && "rotate-90")}
            />
            {body}
          </button>
        );
      },
    },
    { key: "design", header: "设计", isEmpty: (row) => !row.design, cell: (row) => row.design ?? "—" },
    { key: "planned", header: "计划入组", align: "right", isEmpty: (row) => row.planned == null, cell: (row) => <span className="text-text-3">{numberText(row.planned, 0)}</span> },
    { key: "actual", header: "实际入组", align: "right", isEmpty: (row) => row.actual == null, cell: (row) => <span className="font-medium">{numberText(row.actual, 0)}</span> },
    { key: "sites", header: "中心数", align: "right", isEmpty: (row) => row.sites == null, cell: (row) => numberText(row.sites, 0) },
    { key: "plannedMonths", header: "计划入组月数", align: "right", isEmpty: (row) => row.plannedMonths == null, cell: (row) => <span className="text-text-3">{numberText(row.plannedMonths, 0)}</span> },
    { key: "actualMonths", header: "实际入组月数", align: "right", isEmpty: (row) => row.actualMonths == null, cell: (row) => numberText(row.actualMonths, 0) },
    { key: "rate", header: "每中心每月", align: "right", isEmpty: (row) => row.perSitePerMonth == null, cell: (row) => numberText(row.perSitePerMonth, 2) },
    ...(withUse ? [{ key: "usedFor", header: "用于", isEmpty: (row: VcrPrecedent) => !row.usedFor, cell: (row: VcrPrecedent) => row.usedFor ?? "—" }] : []),
  ];
  const drawn = drawnColumns(columns, rows);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] border-collapse">
          <caption className="sr-only">试验先例</caption>
          <thead>
            <tr className="border-b border-border">
              {drawn.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn("sticky top-0 z-sticky bg-bg px-2 pb-2 pt-1 text-compact font-normal text-text-3", column.align === "right" ? "text-right" : "text-left")}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.id}>
                <tr data-vcr-precedent={row.registryId} className="border-b border-faint">
                  {drawn.map((column) => {
                    const shared = cn("px-2 py-2.5 align-top text-ui text-text", column.align === "right" ? "text-right tabular-nums" : "text-left");
                    return column.rowHeader
                      ? <th key={column.key} scope="row" className={cn(shared, "font-normal")}>{column.cell(row)}</th>
                      : <td key={column.key} className={shared}>{column.cell(row)}</td>;
                  })}
                </tr>
                {open.has(row.id) && (
                  <tr id={`vcr-precedent-${row.id}`} data-vcr-precedent-detail={row.registryId} className="border-b border-faint bg-surface-1">
                    <td colSpan={drawn.length} className="px-4 py-3">
                      <PrecedentDetail row={row} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {footnote != null && <p className="mt-2 text-caption text-text-3">{footnote}</p>}
    </div>
  );
}

/** A precedent opened: everything the registry says, the eligibility as written beside the normalised population. */
function PrecedentDetail({ row }: { row: VcrPrecedent }) {
  const link = safeLink(row.source);
  const facts = [
    ...(row.title ? [{ label: "标题", value: row.title }] : []),
    ...(row.countries?.length ? [{ label: "国家/地区", value: row.countries.join("、") }] : []),
    ...(row.interventions?.length ? [{ label: "干预", value: row.interventions.join("、") }] : []),
    ...(row.endpoints?.length ? [{ label: "终点", value: row.endpoints.join("、") }] : []),
    ...(row.enrollmentKind ? [{ label: "入组人数", value: ENROLMENT_KIND[row.enrollmentKind] ?? row.enrollmentKind }] : []),
    ...(row.hasResults != null ? [{ label: "结果", value: row.hasResults ? "已公布结果" : "未公布结果" }] : []),
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <VcrFacts rows={facts} />
      {(row.population || row.eligibilityText) && (
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-caption text-text-3">人群（标准化）</dt>
            <dd className="mt-1 text-ui text-text">{row.population ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-3">入排条件原文</dt>
            <dd data-vcr-eligibility-text="" className="mt-1 text-ui text-text-2">{row.eligibilityText ?? "—"}</dd>
          </div>
        </dl>
      )}
      {link && (
        <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ui text-link hover:underline">
          打开登记记录
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
