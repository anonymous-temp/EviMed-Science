import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { getVcrTrial, recordVcrDecision, type VcrDesign, type VcrStudy, type VcrTrialTab as TrialData } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Tag } from "@/components/ui/Tag";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { VcrCountsBand } from "../VcrCounts";
import { VcrTrajectoryChart } from "../VcrCharts";
import { VcrTradeoffScatter } from "../VcrDiagrams";
import { ReviewChip, SeriesLegend } from "../VcrMarks";
import { VcrNumber } from "../VcrNumber";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrHeadline, VcrSection, VcrTabError } from "../vcrTabKit";
import { mcseText, numberText, valueText } from "../vcrText";

/**
 * 试验: what each design would actually do, and what choosing one costs.
 *
 * Three rules hold this page together.
 *
 *  - **Every simulated number carries its Monte-Carlo standard error.** 71%
 *    and 71% ±0.4 are different claims, and a design chosen on the difference
 *    between two numbers inside each other's simulation error was chosen by
 *    noise.
 *  - **A design another dominates carries no numbers.** It is greyed with the
 *    one sentence that says why; printing its figures invites a comparison
 *    that is already settled.
 *  - **The platform never picks a design.** The reader writes the comparison
 *    goal and makes the choice; 「选定方案」 stays inert until they do. A
 *    trade-off between power, duration and cost is a decision about their
 *    programme, not a maximum this page can find.
 */
export function TrialTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:trial`, () => getVcrTrial(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  if (data.designs.length === 0 && data.ademp.length === 0) {
    return <VcrStepPending studyId={studyId} study={study} step="trial" />;
  }

  return (
    <div className="flex flex-col gap-6">
      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

      {data.ademp.length > 0 && (
        <Card
          header={(
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-section font-semibold text-text">模拟设定</h2>
              <Tag title="目的 · 数据生成机制 · 估计目标 · 分析方法 · 性能指标">ADEMP</Tag>
              <span className="flex-1" />
              <ReviewChip state={data.ademReview ?? null} />
            </div>
          )}
        >
          <dl className="divide-y divide-faint">
            {data.ademp.map((line) => (
              <div key={line.key} className="grid grid-cols-[1.5rem_6rem_1fr] gap-3 py-2">
                <dt aria-hidden="true" className="text-caption font-medium tabular-nums text-text-3">{line.key.toUpperCase()}</dt>
                <dt className="text-caption text-text-3">{line.label}</dt>
                <dd className="min-w-0 text-ui text-text">{line.text}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {data.designs.length > 0 && (
        <VcrSection title="方案的运行特征" meta="± 为蒙特卡洛标准误">
          <DataTable
            label="方案的运行特征"
            columns={designColumns(data)}
            rows={data.designs}
            rowKey={(design) => design.id}
            highlight={(design) => Boolean(design.chosen)}
            rowAttrs={(design) => ({ "data-vcr-design": design.code, ...(design.dominated ? { "data-vcr-dominated": "" } : {}) })}
          />
          {data.footnotes?.map((note, index) => (
            <p key={note} className="mt-1.5 text-caption text-text-3">
              <span aria-hidden="true" className="mr-1 tabular-nums">{index + 1}</span>
              {note}
            </p>
          ))}
        </VcrSection>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {data.powerCurve && (
          <ChartCard
            title="功效随真实效应的变化"
            legend={data.powerCurve.series.map((series, index) => (
              <SeriesLegend key={series.key} label={series.label} source={series.source} ours={series.ours} tone={((index % 3) + 1) as 1 | 2 | 3} />
            ))}
            footnote="浅色分布为证据给出的设计先验；带“假设”标签的竖线是情景设定值，不是估计。"
          >
            <VcrTrajectoryChart
              series={data.powerCurve.series}
              xLabel={data.powerCurve.xLabel}
              yLabel={data.powerCurve.yLabel}
              domain={[0, 1]}
              formatY={(value) => `${Math.round(value * 100)}%`}
            />
            {data.powerCurve.markers && data.powerCurve.markers.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-x-4 text-caption text-text-3">
                {data.powerCurve.markers.map((marker) => (
                  <span key={marker.label} className="inline-flex items-center gap-1.5">
                    {marker.label}
                    {marker.kind === "assumed" && <Tag>假设</Tag>}
                  </span>
                ))}
              </p>
            )}
          </ChartCard>
        )}

        <div className="flex flex-col gap-4">
          <DecisionCard studyId={studyId} decision={data.decision} designs={data.designs} />
          {data.runRecord.length > 0 && (
            <Card title="本次运行">
              <ul className="flex flex-col gap-3">
                {data.runRecord.map((record) => (
                  <li key={record.key} className="flex items-start gap-2">
                    {record.ok && <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />}
                    <span className="min-w-0">
                      <span className="block text-ui text-text">{record.title}</span>
                      {record.detail && <span className="block text-caption text-text-3">{record.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {data.grid && data.grid.rows.length > 0 && (
        <VcrSection title={data.grid.measure ? `设计网格：${data.grid.measure}` : "设计网格"} meta={data.grid.xLabel}>
          <HeatGrid
            label={data.grid.measure ?? "设计网格"}
            columns={data.grid.columns}
            rows={data.grid.rows.map((row) => ({ key: row.key, header: row.header, cells: row.cells }))}
            legend={{ low: "低", high: "高" }}
          />
          {data.grid.yLabel && <p className="mt-2 text-caption text-text-3">{data.grid.yLabel}</p>}
        </VcrSection>
      )}

      {data.designs.length > 1 && (
        <VcrSection title="周期、成本与成功把握的取舍">
          <VcrTradeoffScatter
            designs={data.designs}
            xKey="duration_months"
            yKey="assurance"
            sizeKey="cost"
            xLabel="末例入组中位（月）"
            yLabel="成功把握"
            sizeLabel="气泡面积 = 成本"
            formatY={(value) => `${numberText(value * (value <= 1 ? 100 : 1), 0)}%`}
          />
        </VcrSection>
      )}

      <VcrCountsBand counts={data.counts} />
    </div>
  );
}

/**
 * The grid's columns, from the payload's own list. A dominated design prints
 * one sentence across the measure columns instead of numbers.
 */
function designColumns(data: TrialData): Array<DataColumn<VcrDesign>> {
  return [
    {
      key: "design",
      header: "方案",
      rowHeader: true,
      cell: (design) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-tag text-meta font-semibold",
              design.dominated ? "bg-surface-2 text-text-3" : design.chosen ? "bg-accent text-accent-fg" : "bg-surface-2 text-text-2")}
            >
              {design.code}
            </span>
            <span className={design.dominated ? "text-text-3" : "text-text"}>{design.name}</span>
            {design.dominated && <Tag>{design.dominatedBy ? `被 ${design.dominatedBy} 占优` : "被占优"}</Tag>}
          </span>
          {design.note && !design.dominated && <span className="text-caption text-text-3">{design.note}</span>}
        </span>
      ),
    },
    ...data.columns.map((column): DataColumn<VcrDesign> => ({
      key: column.key,
      header: column.unit ? `${column.label}（${column.unit}）` : column.label,
      align: "right",
      isEmpty: (design) => design.measures[column.key]?.value == null && !design.measures[column.key]?.text,
      cell: (design) => {
        // A dominated design says why once, across the row, and gives no
        // numbers at all — see the page's own note.
        if (design.dominated) {
          return column.key === data.columns[0]?.key
            ? <span className="text-text-3">{design.note ?? "样本更多、周期更长，成功把握不更高"}</span>
            : null;
        }
        const value = design.measures[column.key];
        if (!value) return <span className="text-text-3">—</span>;
        return (
          <span className="flex flex-col items-end">
            <VcrNumber value={value} label={`${design.code} ${column.label}`}>
              <span className={cn("tabular-nums", design.chosen && "font-medium")}>{valueText(value)}</span>
            </VcrNumber>
            {value.mcse != null && <span className="text-meta font-normal text-text-3">{mcseText(value.mcse)}</span>}
          </span>
        );
      },
    })),
  ];
}

/**
 * The decision: the reader's comparison goal, and the design they chose.
 *
 * 「选定方案」 is inert until a design is picked, and the line under it says so
 * in the page's own words. The platform records the decision; it does not make
 * it.
 */
function DecisionCard({ studyId, decision, designs }: {
  studyId: string;
  decision: TrialData["decision"];
  designs: readonly VcrDesign[];
}) {
  const [goal, setGoal] = useState(decision?.goal ?? "");
  const [chosen, setChosen] = useState<string | null>(decision?.chosen ?? null);
  const [busy, setBusy] = useState(false);
  const options = decision?.options ?? designs.map((design) => ({ id: design.id, label: design.code, disabled: design.dominated }));

  const save = () => {
    if (!chosen) return;
    setBusy(true);
    void recordVcrDecision(studyId, { goal: goal.trim() || undefined, chosen })
      .then(() => toast.success("已写入决策记录。"))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "决策记录暂时无法写入，请稍后重试。" })))
      .finally(() => setBusy(false));
  };

  return (
    <Card title="决策">
      <label className="block text-caption text-text-3" htmlFor="vcr-decision-goal">比较目标</label>
      <textarea
        id="vcr-decision-goal"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        rows={3}
        placeholder="例如：成功把握不低于 70% 的前提下，末例入组不晚于 18 个月，成本最低……"
        className="mt-1.5 w-full rounded border border-border-control bg-surface px-3 py-2 text-ui text-text outline-none placeholder:text-text-3"
      />
      <fieldset className="mt-3">
        <legend className="text-caption text-text-3">选定方案</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {options.map((option) => (
            <label
              key={option.id}
              className={cn(
                "inline-flex h-control cursor-pointer items-center gap-1.5 rounded px-3 text-ui",
                option.disabled ? "cursor-not-allowed bg-surface-1 text-text-3" : chosen === option.id ? "bg-accent-soft font-medium text-accent-strong" : "bg-surface-2 text-text-2",
              )}
            >
              <input
                type="radio"
                name="vcr-decision"
                value={option.id}
                disabled={option.disabled}
                checked={chosen === option.id}
                onChange={() => setChosen(option.id)}
                className="h-3.5 w-3.5 accent-accent"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={!chosen} loading={busy} onClick={save}>写入决策记录</Button>
        <span className="text-caption text-text-3">{decision?.note ?? "平台不自动选定方案。"}</span>
      </div>
    </Card>
  );
}
