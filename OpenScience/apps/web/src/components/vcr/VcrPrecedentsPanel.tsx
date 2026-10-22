import { registryCoverageSummary, VcrRegistryCoverage } from "./VcrRegistryCoverage";
import { useState } from "react";
import { ExternalLink, Library } from "lucide-react";
import { getVcrPrecedents, type VcrPrecedent } from "@/lib/vcrClient";
import { safeLink } from "@/lib/frontierClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { FactList, type Fact } from "@/components/ui/FactList";
import { EmptyState } from "@/components/cards/EmptyState";
import { useVcrToolbar } from "./studyFrameContext";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { VcrReferenceSearch } from "./VcrReferenceSearch";
import { numberText } from "./vcrText";

/** What a registry's enrolment figure is: what happened, or what a sponsor hoped for. */
const ENROLMENT_KIND: Readonly<Record<string, string>> = Object.freeze({ actual: "实际", anticipated: "预计", estimated: "预计" });

/**
 * 参考试验: what comparable trials actually planned and what they actually
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
  const off = state.kind === "error" && state.off === true;
  // The search and the count are the page's one toolbar, beside its views; a library that is not composed here has neither.
  useVcrToolbar(off
    ? null
    : {
      label: "参考试验的检索",
      search: {
        label: "搜索登记试验",
        value: query,
        onChange: (next) => {
          setQuery(next);
          if (!next.trim()) setAsked("");
        },
        onClear: () => { setQuery(""); setAsked(""); },
        inputProps: { onKeyDown: (event) => { if (event.key === "Enter") setAsked(query.trim()); } },
      },
      summary: !asked && state.kind === "ready" ? `已保存 ${state.data.precedents.length} 项` : undefined,
    });
  if (off) return <EmptyState icon={Library} title={VCR_OFF_SENTENCE} />;

  return (
    <div className="flex flex-col gap-4">
      {asked && <VcrReferenceSearch key={asked} query={asked} onApplied={reload} />}
      {!asked && <Button variant="text" onClick={() => { setQuery("diabetes"); setAsked("diabetes"); }}>检索示例：diabetes</Button>}
      {!asked && (state.kind === "loading" ? <VcrTabSkeleton />
        : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} />
          : !state.data.available ? <div data-vcr-precedents-unavailable=""><EmptyState icon={Library} title={state.data.message ?? "参考试验库在本部署尚未接入。"} /></div>
            : state.data.precedents.length === 0
            ? (
              <EmptyState
                icon={Library}
                title={asked ? "没有找到已保存的参考试验" : "尚未保存参考试验"}
                action={asked ? <Button variant="secondary" onClick={() => { setQuery(""); setAsked(""); }}>清除检索</Button> : undefined}
              />
            )
            : <VcrPrecedentTable rows={state.data.precedents} />)}

      {/* What the registries could and could not be read for is the answer to 「为什么没有这一条」, one click under the precedents rather than above them. */}
      {!asked && state.kind === "ready" && (state.data.registryCoverage?.length ?? 0) > 0 && (
        <Disclosure
          summary={(
            <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-semibold text-text">注册源覆盖</span>
              <span data-vcr-coverage-summary="" className="text-caption text-text-3">{registryCoverageSummary(state.data.registryCoverage ?? [])}</span>
            </span>
          )}
        >
          <VcrRegistryCoverage sources={state.data.registryCoverage} heading={false} />
        </Disclosure>
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
 * One line per trial, planned and actual in columns of their own (the names say what a sponsor hoped for and what happened, so no
 * sentence has to — plan §6.4); a row opens to the rest of what the registry says in a drawer: the title, countries,
 * interventions, endpoints and the eligibility **as written**, beside the normalised population it was reduced to, so a reader can
 * check the reduction. The registry number in the first cell is the keyboard's way in. The source opens only through a checked
 * `http(s)` link.
 */
export function VcrPrecedentTable({ rows, withUse = false }: {
  rows: readonly VcrPrecedent[];
  /** The 「用于」 column: which parameter of this study the trial fed. */
  withUse?: boolean;
}) {
  const [opened, setOpened] = useState<VcrPrecedent | null>(null);
  const columns: Array<DataColumn<VcrPrecedent>> = [
    {
      key: "registry",
      header: "登记号",
      rowHeader: true,
      cell: (row) => {
        // The registry number is the row's one control — plain text in the accent colour, one line — and what the registry says about
        // the trial is a line of the table under it.
        const caption = [row.registry, row.population].filter(Boolean).join(" · ");
        return (
          <span className="block min-w-0">
            {hasDetail(row)
              ? (
                <button
                  type="button"
                  aria-label={`打开 ${row.registryId} 的登记记录`}
                  onClick={() => setOpened(row)}
                  className="text-left tabular-nums text-link hover:underline"
                >
                  {row.registryId}
                </button>
              )
              : <span className="block tabular-nums text-text">{row.registryId}</span>}
            {caption && <span className="block text-caption text-text-3">{caption}</span>}
          </span>
        );
      },
    },
    { key: "design", header: "设计", isEmpty: (row) => !row.design, cell: (row) => row.design ?? "—" },
    { key: "planned", header: "计划入组", align: "right", isEmpty: (row) => row.planned == null, cell: (row) => <span className="text-text-3">{numberText(row.planned, 0)}</span> },
    { key: "actual", header: "实际入组", align: "right", isEmpty: (row) => row.actual == null, cell: (row) => <span>{numberText(row.actual, 0)}</span> },
    { key: "sites", header: "中心数", align: "right", isEmpty: (row) => row.sites == null, cell: (row) => numberText(row.sites, 0) },
    { key: "plannedMonths", header: "计划入组月数", align: "right", isEmpty: (row) => row.plannedMonths == null, cell: (row) => <span className="text-text-3">{numberText(row.plannedMonths, 0)}</span> },
    { key: "actualMonths", header: "实际入组月数", align: "right", isEmpty: (row) => row.actualMonths == null, cell: (row) => numberText(row.actualMonths, 0) },
    { key: "rate", header: "每中心每月", align: "right", isEmpty: (row) => row.perSitePerMonth == null, cell: (row) => numberText(row.perSitePerMonth, 2) },
    ...(withUse ? [{ key: "usedFor", header: "用于", isEmpty: (row: VcrPrecedent) => !row.usedFor, cell: (row: VcrPrecedent) => row.usedFor ?? "—" }] : []),
  ];

  return (
    <>
      <DataTable
        label="参考试验"
        minWidth="min-w-[48rem]"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ "data-vcr-precedent": row.registryId })}
        onRowOpen={(row) => { if (hasDetail(row)) setOpened(row); }}
      />
      {opened && (
        <Drawer title={opened.registryId} onClose={() => setOpened(null)} widthClassName="max-w-lg">
          <PrecedentDetail row={opened} />
        </Drawer>
      )}
    </>
  );
}

/** A precedent opened: everything the registry says, the eligibility as written beside the normalised population. */
function PrecedentDetail({ row }: { row: VcrPrecedent }) {
  const link = safeLink(row.source);
  const facts: Fact[] = [
    ...(row.title ? [{ label: "标题", value: row.title }] : []),
    ...(row.countries?.length ? [{ label: "国家/地区", value: row.countries.join("、") }] : []),
    ...(row.interventions?.length ? [{ label: "干预", value: row.interventions.join("、") }] : []),
    ...(row.endpoints?.length ? [{ label: "终点", value: row.endpoints.join("、") }] : []),
    ...(row.enrollmentKind ? [{ label: "入组人数", value: ENROLMENT_KIND[row.enrollmentKind] ?? row.enrollmentKind }] : []),
    ...(row.hasResults != null ? [{ label: "结果", value: row.hasResults ? "已公布结果" : "未公布结果" }] : []),
    ...(row.population ? [{ label: "人群（标准化）", value: row.population }] : []),
    ...(row.eligibilityText ? [{ label: "入排条件原文", value: <span data-vcr-eligibility-text="">{row.eligibilityText}</span> }] : []),
  ];
  return (
    <div data-vcr-precedent-detail={row.registryId} className="flex flex-col gap-4">
      <FactList rows={facts} />
      {link && (
        <a href={link} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "text", size: "sm", className: "w-fit text-link" })}>
          打开登记记录
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
