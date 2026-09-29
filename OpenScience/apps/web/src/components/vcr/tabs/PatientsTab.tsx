import { CircleCheck, CircleDashed } from "lucide-react";
import { getVcrPatients, type VcrModelCard, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { Tag } from "@/components/ui/Tag";
import { VcrCountsBand } from "../VcrCounts";
import { VcrTrajectoryChart } from "../VcrCharts";
import { VcrTornadoChart } from "../VcrDiagrams";
import { SeriesLegend, SourceTag } from "../VcrMarks";
import { VcrValueText } from "../VcrNumber";
import { NotApplicableCard, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrHeadline, VcrTabError } from "../vcrTabKit";
import { intervalText, modelTierLabel, numberText, intendedUseLabel } from "../vcrText";

/**
 * 虚拟患者: what this kind of patient might do, under a named model and a
 * stated scenario — and never a claim about anybody real.
 *
 * Two things on this page are load-bearing. The model's chip carries its
 * credibility tier and **the highest intended use it can carry** (plan §8.2):
 * a literature model's output may support a design and may not support a
 * submission, and that ceiling travels with every number derived from it. And
 * the example patient shows the same random numbers under two assumptions
 * side by side, with the sentence that says what that is: an individual's two
 * outcomes can never both be observed.
 */
export function PatientsTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:patients`, () => getVcrPatients(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  if (!data.trajectories && !data.example && data.panels.length === 0) {
    return <VcrStepPending studyId={studyId} study={study} step="patients" />;
  }

  return (
    <div className="flex flex-col gap-6">
      {data.model && <ModelChipRow model={data.model} />}
      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {data.trajectories && (
          <ChartCard
            title="两种情景下的推演，以及个体之间的差异"
            legend={data.trajectories.series.map((series, index) => (
              <SeriesLegend key={series.key} label={series.label} source={series.source} ours={series.ours} tone={((index % 3) + 1) as 1 | 2 | 3} />
            ))}
            footnote="浅色带为模型的预测区间；细线是个体轨迹，不是观察记录。"
          >
            <VcrTrajectoryChart
              series={data.trajectories.series}
              xLabels={data.trajectories.ticks}
              xLabel={data.trajectories.xLabel}
              yLabel={data.trajectories.yLabel}
            />
          </ChartCard>
        )}

        {data.example && (
          <Card
            header={(
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-section font-semibold text-text">{data.example.id}</h2>
                <SourceTag source={data.example.source} />
              </div>
            )}
          >
            {data.example.origin && <p className="text-caption text-text-3">{data.example.origin}</p>}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              {data.example.baseline.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-2 border-b border-faint pb-1.5">
                  <dt className="shrink-0 text-caption text-text-3">{row.label}</dt>
                  <dd className="flex min-w-0 items-baseline gap-1.5 text-ui tabular-nums text-text">
                    {row.value}
                    <SourceTag source={row.source} />
                  </dd>
                </div>
              ))}
            </dl>
            {data.example.inScope && (
              <p className={cn("mt-3 flex items-center gap-1.5 text-caption", data.example.inScope.ok ? "text-ok" : "text-warn-strong")}>
                {data.example.inScope.ok ? <CircleCheck size={16} aria-hidden="true" /> : <CircleDashed size={16} aria-hidden="true" />}
                {data.example.inScope.text}
              </p>
            )}
            {data.example.scenarios && (
              <div className="mt-4 rounded-card border border-border bg-surface-1 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-ui font-medium text-text">{data.example.scenarios.note ?? "同一组随机数，两种假设"}</p>
                  {data.example.scenarios.difference && (
                    <p className="text-caption tabular-nums text-text-3">{data.example.scenarios.difference}</p>
                  )}
                </div>
                <VcrTrajectoryChart series={data.example.scenarios.series} height={160} />
              </div>
            )}
            {data.example.note && (
              <p className="mt-3 text-caption text-text-3">{data.example.note}</p>
            )}
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {data.panels.map((panel) => (
          <Card key={panel.key} title={panel.title}>
            {panel.note && <p className="mb-3"><Tag>{panel.note}</Tag></p>}
            {panel.rows && panel.rows.length > 0 && (
              <ul className="flex flex-col gap-2.5">
                {panel.rows.map((row) => (
                  <li key={row.label}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-ui text-text-2">{row.label}</span>
                      <span className="text-ui font-medium tabular-nums text-text"><VcrValueText value={row.value} /></span>
                    </div>
                    {row.value.interval && (
                      <p className="text-caption tabular-nums text-text-3">{intervalText(row.value.interval, row.value.precision)}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {panel.series && panel.series.length > 0 && (
              <VcrTrajectoryChart series={panel.series} height={150} />
            )}
            {panel.footnote && <p className="mt-2 text-caption text-text-3">{panel.footnote}</p>}
          </Card>
        ))}

        {data.sensitivity && data.sensitivity.rows.length > 0 && (
          <Card title="哪些假设影响最大">
            <VcrTornadoChart
              rows={data.sensitivity.rows}
              centre={data.sensitivity.rows.reduce((sum, row) => sum + (row.low + row.high) / 2, 0) / data.sensitivity.rows.length}
              formatValue={(value) => numberText(value, 1)}
            />
            {data.sensitivity.measure && <p className="mt-2 text-caption text-text-3">{data.sensitivity.measure}</p>}
          </Card>
        )}
      </div>

      {!data.model && (
        <NotApplicableCard
          title="还没有选定模型"
          reason="没有声明适用范围的模型，就没有能承载预期用途的推演。"
          options={["换一个适用范围覆盖本人群的模型", "先用文献模型或情景模型，并把结论标到对应用途", "提一个数据需求，用授权数据拟合"]}
        />
      )}

      <VcrCountsBand counts={data.counts} />
    </div>
  );
}

/** The model's line above the charts: which model, what it covers, how far its output may be carried. */
function ModelChipRow({ model }: { model: VcrModelCard }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-border bg-surface px-4 py-2.5">
      <span className="flex items-center gap-2 text-ui font-medium text-text">
        <Tag tone="accent">{modelTierLabel(model.tier)}</Tag>
        {model.name}
        {model.version && <span className="text-text-3">{model.version}</span>}
      </span>
      {model.scope && <span className="min-w-0 flex-1 truncate text-caption text-text-3">{model.scope}</span>}
      <span className="shrink-0 text-caption text-text-2">
        预期用途上限
        <span className="ml-1.5 font-medium text-text">{intendedUseLabel(model.useCeiling)}</span>
      </span>
    </div>
  );
}
