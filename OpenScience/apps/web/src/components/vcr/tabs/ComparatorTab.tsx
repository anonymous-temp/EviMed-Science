import { CircleCheck } from "lucide-react";
import { VCR_COMPARATOR_ROUTE_LABELS_ZH } from "@evimed/domain";
import { getVcrComparator, type VcrComparatorTab as ComparatorData, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { Tag } from "@/components/ui/Tag";
import { VcrCountsBand } from "../VcrCounts";
import { VcrSurvivalChart } from "../VcrCharts";
import { VcrSmdDot } from "../VcrDiagrams";
import { ConclusionChip, ReviewChip, SeriesLegend, SourceTag } from "../VcrMarks";
import { VcrValueText } from "../VcrNumber";
import { NotEstimableCard, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrFacts, VcrHeadline, VcrSection, VcrTabError } from "../vcrTabKit";
import { conclusionLabel, intervalText, reviewLabel } from "../vcrText";

const ROUTE_LABELS = VCR_COMPARATOR_ROUTE_LABELS_ZH as Record<string, string>;

/** What a route's state is called when it is not one of the three conclusions. */
const ROUTE_STATE_WORDS: Record<string, string> = {
  not_applicable: "不适用",
  scenario: "情景",
  design_only: "设计期可用",
};

/**
 * 对照: who this study should be compared with, and how much that comparison
 * can carry.
 *
 * The five routes are a rail rather than a choice the reader has to make:
 * each one says what it is at this study's data tier, and the two that cannot
 * apply say so with their reason attached. 「不可估计」 is a finished result
 * with a gap list and what each gap would answer — the card, not a blank.
 *
 * The curves are the module's hardest visual rule: a Kaplan-Meier
 * reconstructed out of a published figure is drawn dashed, always, and the
 * quality-control table beside it says how close the reconstruction came to
 * the numbers the paper printed. A dashed curve that passed QC is still not a
 * curve anybody measured.
 */
export function ComparatorTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:comparator`, () => getVcrComparator(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  if (data.routes.length === 0 && data.curves.length === 0 && !data.gaps) {
    return <VcrStepPending studyId={studyId} study={study} step="comparator" />;
  }

  return (
    <div className="flex flex-col gap-6">
      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title="对照路线">
            <ol className="flex flex-col gap-1">
              {data.routes.map((route, index) => (
                <li
                  key={route.route}
                  data-vcr-route={route.route}
                  className={cn(
                    "rounded border-l-2 px-3 py-2.5",
                    route.selected ? "border-accent bg-accent-soft" : "border-transparent",
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="w-4 shrink-0 text-caption tabular-nums text-text-3">{index + 1}</span>
                    <span className="min-w-0 flex-1 text-ui font-medium text-text">{ROUTE_LABELS[route.route] ?? route.route}</span>
                  </div>
                  <p className="ml-6 mt-1.5">
                    {route.state === "estimable" || route.state === "limited" || route.state === "not_estimable"
                      ? <ConclusionChip state={route.state} />
                      : <Tag>{ROUTE_STATE_WORDS[route.state] ?? route.state}</Tag>}
                  </p>
                  {(route.reason || route.note) && (
                    <p className="ml-6 mt-1.5 text-caption text-text-3">{route.reason ?? route.note}</p>
                  )}
                </li>
              ))}
            </ol>
          </Card>

          {data.methods && data.methods.length > 0 && (
            <Card title="方法与版本">
              <ul className="flex flex-col gap-2">
                {data.methods.map((method) => (
                  <li key={method.label} className="flex items-baseline justify-between gap-3 text-caption">
                    <span className="flex min-w-0 items-center gap-1.5 text-ui text-text">
                      {method.passed && <CircleCheck size={16} aria-hidden="true" className="shrink-0 text-ok" />}
                      <span className="truncate">{method.label}</span>
                      {method.version && <span className="shrink-0 text-text-3">{method.version}</span>}
                    </span>
                    {method.note && <span className="shrink-0 text-text-3">{method.note}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.e10 && data.e10.length > 0 && (
            <Card title="外部对照适用情境">
              <ul className="flex flex-col gap-2.5">
                {data.e10.map((condition) => (
                  <li key={condition.key}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 text-ui text-text">{condition.label}</span>
                      <Tag tone={condition.state === "met" ? "neutral" : "warn"} className={cn(condition.state === "met" && "bg-ok-soft text-ok")}>
                        {condition.state === "met" ? "满足" : condition.state === "partial" ? "部分" : "存疑"}
                      </Tag>
                    </div>
                    {condition.note && <p className="mt-0.5 text-caption text-text-3">{condition.note}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {data.curves.length > 0 && (
            <ChartCard
              title="对照组的生存曲线与合并估计"
              legend={(
                <>
                  {data.curves.map((curve, index) => (
                    <SeriesLegend key={curve.key} label={curve.label} source={curve.source} ours={curve.ours} tone={((index % 3) + 1) as 1 | 2 | 3} />
                  ))}
                  {data.rmst?.tau != null && (
                    <span className="inline-flex items-center gap-1.5 text-caption text-text-3">
                      <span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-tag bg-chart-band" />
                      {`${data.rmst.tau} 个月内曲线下面积`}
                    </span>
                  )}
                </>
              )}
              footnote="虚线为从已发表图表重建的伪个体数据，不是观察到的曲线。"
              meta={<span className="flex items-center gap-1.5"><ConclusionChip state={data.verdict?.conclusion ?? null} /><ReviewChip state={data.verdict?.review ?? null} /></span>}
            >
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
                <VcrSurvivalChart curves={data.curves} rmst={data.rmst ? { tau: data.rmst.tau ?? null, label: data.rmst.label } : null} />
                <ComparatorNumbers data={data} />
              </div>
            </ChartCard>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {data.estimand && (
              <Card
                header={(
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-section font-semibold text-text">估计目标</h2>
                    <SourceTag source={data.estimand.source ?? undefined} />
                    <span className="flex-1" />
                    <ReviewChip state={data.estimand.review ?? null} />
                  </div>
                )}
              >
                <VcrFacts rows={data.estimand.rows.map((row) => ({ label: row.label, value: row.value }))} />
                {data.estimand.note && (
                  <p className="mt-3 rounded bg-surface-1 px-3 py-2 text-caption text-text-2">{data.estimand.note}</p>
                )}
              </Card>
            )}

            {data.comparability.length > 0 && (
              <Card title="与本研究人群的可比性">
                <table className="w-full border-collapse text-caption">
                  <caption className="sr-only">本研究人群与对照人群的基线比较</caption>
                  <thead>
                    <tr className="border-b border-border text-text-3">
                      <th scope="col" className="py-1 pr-2 text-left font-normal">特征</th>
                      <th scope="col" className="py-1 px-2 text-right font-normal">本研究</th>
                      <th scope="col" className="py-1 px-2 text-right font-normal">对照</th>
                      <th scope="col" className="py-1 pl-2 text-right font-normal">|SMD|</th>
                      <th scope="col" className="w-16 py-1 pl-2 font-normal"><span className="sr-only">界值 0.1</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.comparability.map((row) => (
                      <tr key={row.key} className={cn("border-b border-faint", row.flagged && "bg-warn-soft")}>
                        <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text">{row.label}</th>
                        <td className="py-1.5 px-2 text-right tabular-nums text-text"><VcrValueText value={row.ours} /></td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-text-2"><VcrValueText value={row.theirs} /></td>
                        <td className={cn("py-1.5 pl-2 text-right tabular-nums", row.flagged ? "font-medium text-warn-strong" : "text-text-2")}>
                          {row.smd != null ? row.smd.toFixed(2) : "—"}
                        </td>
                        <td className="py-1.5 pl-2"><VcrSmdDot smd={row.smd} label={row.label} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.comparabilityNote && <p className="mt-2 text-caption text-text-3">{data.comparabilityNote}</p>}
              </Card>
            )}
          </div>
        </div>
      </div>

      {data.gaps && (
        <NotEstimableCard
          title={data.gaps.title ?? "真实外部对照：不可估计"}
          needs={data.gaps.needs}
          items={data.gaps.items}
          conclusion={data.gaps.conclusion}
        />
      )}

      <VcrCountsBand counts={data.counts} />

      {data.verdict && (
        <p data-vcr-verdict="" className="flex flex-wrap items-center gap-2 text-caption text-text-3">
          本页结论：
          <ConclusionChip state={data.verdict.conclusion} />
          <ReviewChip state={data.verdict.review} />
          {!data.verdict.reviewed && <span>未复核</span>}
          <span className="sr-only">{`${conclusionLabel(data.verdict.conclusion)}，${reviewLabel(data.verdict.review)}`}</span>
        </p>
      )}
    </div>
  );
}

/** The two numbers a comparator page is read for, beside the curves. */
function ComparatorNumbers({ data }: { data: ComparatorData }) {
  return (
    <div className="flex flex-col gap-4">
      {data.rmst && (
        <div>
          <p className="flex items-center gap-1.5 text-caption text-text-3">
            {data.rmst.label ?? "限制平均生存时间"}
            <SourceTag source={data.rmst.value.source} />
          </p>
          <p className="mt-1 text-metric font-semibold tabular-nums text-text"><VcrValueText value={data.rmst.value} /></p>
          <p className="text-caption tabular-nums text-text-3">{intervalText(data.rmst.value.interval, data.rmst.value.precision)}</p>
        </div>
      )}
      {data.median && (
        <div>
          <p className="flex items-center gap-1.5 text-caption text-text-3">
            中位数
            <SourceTag source={data.median.source} />
          </p>
          <p className="mt-1 text-heading font-semibold tabular-nums text-text"><VcrValueText value={data.median} /></p>
          <p className="text-caption tabular-nums text-text-3">{intervalText(data.median.interval, data.median.precision)}</p>
        </div>
      )}
      {data.qc.length > 0 && (
        <VcrSection title="重建质控" className="mt-2" meta={`${data.qc.filter((check) => check.passed).length} / ${data.qc.length} 通过`}>
          <ul className="flex flex-col gap-2">
            {data.qc.map((check) => (
              <li key={check.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-caption text-text-2">
                    {check.passed && <CircleCheck size={16} aria-hidden="true" className="shrink-0 text-ok" />}
                    <span className="truncate">{check.label}</span>
                  </span>
                  <span className="shrink-0 text-caption tabular-nums text-text">{check.value}</span>
                </div>
                {check.threshold && <p className="ml-5 text-meta text-text-3">{`界值 ${check.threshold}`}</p>}
              </li>
            ))}
          </ul>
        </VcrSection>
      )}
    </div>
  );
}
