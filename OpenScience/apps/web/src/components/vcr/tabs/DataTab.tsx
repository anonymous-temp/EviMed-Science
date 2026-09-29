import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { getVcrData, type VcrAssumption, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { FilterChips } from "@/components/ui/FilterChips";
import { Tag } from "@/components/ui/Tag";
import { VcrForestPlot } from "../VcrDiagrams";
import { ReviewChip, SourceTag } from "../VcrMarks";
import { VcrValueText } from "../VcrNumber";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrHeadline, VcrSection, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { intervalText, numberText, valueText } from "../vcrText";

type Filter = "all" | "key" | "ai_set" | "reviewed" | "changed";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = Object.freeze([
  { value: "all", label: "全部" },
  { value: "key", label: "关键假设" },
  { value: "ai_set", label: "AI 设定" },
  { value: "reviewed", label: "已复核" },
  { value: "changed", label: "有变更" },
]);

function matches(assumption: VcrAssumption, filter: Filter): boolean {
  switch (filter) {
    case "key": return Boolean(assumption.key);
    case "ai_set": return assumption.value.review === "ai_set";
    case "reviewed": return assumption.value.review === "reviewed";
    case "changed": return assumption.value.review === "changed_after_review";
    default: return true;
  }
}

/**
 * 数据与证据: every parameter the study rests on, as a card, and the sentence
 * in the literature each one was read out of.
 *
 * The forest plot here is the reason the tab exists. It draws the pooled
 * estimate **and the prediction interval** as separate marks, because the
 * design being built is the next study rather than the average of the past
 * ones; a sample size taken off a confidence interval alone is a sample size
 * computed against a precision nobody has.
 *
 * Every card carries its review state as a label on a live value: the number
 * is in use now, and 「AI 设定」 says who set it, not that it is pending
 * (plan §10).
 */
export function DataTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const { state, reload } = useVcrLoad(`${studyId}:data`, () => getVcrData(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  if (data.assumptions.length === 0 && data.precedents.length === 0) {
    return <VcrStepPending studyId={studyId} study={study} step="evidence" />;
  }
  const shown = data.assumptions.filter((assumption) => matches(assumption, filter));
  const selected = data.assumptions.find((assumption) => assumption.id === (openId ?? data.selectedId))
    ?? shown[0] ?? data.assumptions[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
      {data.status && data.status.length > 0 && (
        <VcrToolbar summary={data.status.map((item) => `${item.label} ${item.value}`).join(" · ")} />
      )}
      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card
          header={(
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-section font-semibold text-text">假设卡</h2>
              <span className="text-caption tabular-nums text-text-3">{data.assumptions.length}</span>
            </div>
          )}
        >
          <FilterChips label="假设卡" options={[...FILTERS]} value={filter} onChange={setFilter} className="mb-3" />
          <ul className="flex flex-col gap-1">
            {shown.map((assumption) => (
              <li key={assumption.id}>
                <button
                  type="button"
                  data-vcr-assumption={assumption.id}
                  aria-current={selected?.id === assumption.id ? "true" : undefined}
                  onClick={() => setOpenId(assumption.id)}
                  className={cn(
                    "w-full rounded px-2.5 py-2 text-left outline-none hover:bg-surface-1",
                    selected?.id === assumption.id && "bg-accent-soft",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-ui text-text">{assumption.name}</span>
                    <span className="shrink-0 text-ui font-medium tabular-nums text-text">
                      {valueText(assumption.value)}
                      {assumption.value.unit && <span className="ml-0.5 font-normal text-text-3">{assumption.value.unit}</span>}
                    </span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <SourceTag source={assumption.value.source} />
                    {assumption.summary && <span className="min-w-0 truncate text-caption text-text-3">{assumption.summary}</span>}
                    <span className="flex-1" />
                    <ReviewChip state={assumption.value.review} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        {selected && <AssumptionDetail assumption={selected} />}
      </div>

      {data.precedents.length > 0 && (
        <VcrSection title="试验先例" meta={data.precedentSources ?? `${data.precedents.length} 项`}>
          <DataTable
            label="试验先例"
            minWidth="min-w-[48rem]"
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
              { key: "usedFor", header: "用于", isEmpty: (row) => !row.usedFor, cell: (row) => row.usedFor ?? "—" },
            ]}
            rows={data.precedents}
            rowKey={(row) => row.id}
            rowAttrs={(row) => ({ "data-vcr-precedent": row.registryId })}
            footnote={data.precedentNote ?? "计划值取自登记记录的预计字段，只用于对照；历史基准只用实际值。"}
          />
        </VcrSection>
      )}

      {data.snapshots && data.snapshots.length > 0 && (
        <VcrSection title="数据快照与质量">
          <ul className="grid gap-4 lg:grid-cols-2">
            {data.snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <Card title={snapshot.label}>
                  <p className="text-caption tabular-nums text-text-3">
                    {[snapshot.at, snapshot.rows != null ? `${numberText(snapshot.rows, 0)} 行` : null].filter(Boolean).join(" · ")}
                  </p>
                  {snapshot.quality && (
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {snapshot.quality.map((check) => (
                        <li key={check.label} className="flex items-baseline justify-between gap-3 text-caption">
                          <span className="min-w-0 truncate text-text-2">{check.label}</span>
                          <span className={cn("shrink-0 tabular-nums", check.passed === false ? "text-warn-strong" : "text-text")}>{check.value}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </VcrSection>
      )}
    </div>
  );
}

/** One assumption card, opened: where its number came from and what uses it. */
function AssumptionDetail({ assumption }: { assumption: VcrAssumption }) {
  const detail = assumption.detail;
  return (
    <Card
      header={(
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-section font-semibold text-text">{assumption.name}</h2>
          <SourceTag source={assumption.value.source} />
          <ReviewChip state={assumption.value.review} />
          {assumption.version != null && <span className="text-caption text-text-3">{`版本 ${assumption.version}`}</span>}
        </div>
      )}
    >
      {detail?.subtitle && <p className="text-caption text-text-3">{detail.subtitle}</p>}

      <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-metric font-semibold tabular-nums text-text"><VcrValueText value={assumption.value} /></span>
        {assumption.value.interval && (
          <span className="text-ui tabular-nums text-text-2">{intervalText(assumption.value.interval, assumption.value.precision)}</span>
        )}
      </p>
      {detail?.stats && detail.stats.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption tabular-nums text-text-3">
          {detail.stats.map((stat) => <span key={stat.label}>{`${stat.label} ${stat.value}`}</span>)}
        </p>
      )}

      {detail?.forest && detail.forest.length > 0 && (
        <div className="mt-4">
          <VcrForestPlot rows={detail.forest} unit={assumption.value.unit} />
          {detail.forestNote && <p className="mt-2 text-caption text-text-3">{detail.forestNote}</p>}
        </div>
      )}

      {detail?.distribution && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-caption text-text-3">
          <Tag>仿真用分布</Tag>
          {detail.distribution.family}
          {detail.distribution.note && <span>{detail.distribution.note}</span>}
        </p>
      )}

      {detail?.quote && (
        <figure className="mt-4 rounded-card border border-border bg-surface-1 p-3">
          <blockquote className="text-ui text-text">{`“${detail.quote}”`}</blockquote>
          <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-caption text-text-3">
            {detail.quoteSource && <span>{`— ${detail.quoteSource}`}</span>}
            {detail.quoteLink && (
              <a href={detail.quoteLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
                打开原文
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            )}
          </figcaption>
        </figure>
      )}

      {detail?.usedBy && detail.usedBy.length > 0 && (
        <VcrSection title="被这些结果使用" className="mt-6" meta={`${detail.usedBy.length}`}>
          <ul className="divide-y divide-faint">
            {detail.usedBy.map((user) => (
              <li key={user.id} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-ui text-text">{user.label}</span>
                {user.note && <span className="shrink-0 text-caption text-text-3">{user.note}</span>}
              </li>
            ))}
          </ul>
        </VcrSection>
      )}

      {detail?.versions && detail.versions.length > 0 && (
        <VcrSection title="版本记录" className="mt-6" meta="下游结果随版本重算">
          <ol className="divide-y divide-faint">
            {detail.versions.map((version) => (
              <li key={version.version} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="w-8 shrink-0 text-caption tabular-nums text-text-3">{`v${version.version}`}</span>
                <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{version.at ?? ""}</span>
                <span className="min-w-0 flex-1 text-ui text-text">{version.text}</span>
                {version.note && <span className="shrink-0 text-caption text-text-3">{version.note}</span>}
              </li>
            ))}
          </ol>
        </VcrSection>
      )}
    </Card>
  );
}
