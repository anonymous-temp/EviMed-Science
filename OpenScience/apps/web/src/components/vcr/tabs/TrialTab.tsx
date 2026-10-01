import { useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import { getVcrTrial, recordVcrDecision, type VcrDesign, type VcrForecast, type VcrStudy, type VcrTrialTab as TrialData } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Textarea } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { VcrCountsBand } from "../VcrCounts";
import { VcrSeriesLegend, VcrTrajectoryChart } from "../VcrCharts";
import { VcrMilestoneTimeline, VcrTradeoffScatter } from "../VcrDiagrams";
import { ReviewChip } from "../VcrMarks";
import { VcrNumber } from "../VcrNumber";
import { PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrHeadline, VcrSection, VcrTabError } from "../vcrTabKit";
import { intervalText, mcseText, valueText } from "../vcrText";

/** What the decision card says under its button, when the server does not say it itself. */
const NO_AUTO_PICK = "平台不自动选定方案。";

/**
 * 试验: what each design would actually do, and what choosing one costs.
 *
 * Four rules hold this page together.
 *
 *  - **Every simulated number carries its Monte-Carlo standard error.** 71%
 *    and 71% ±0.4 are different claims, and a design chosen on the difference
 *    between two numbers inside each other's simulation error was chosen by
 *    noise. A predicted interval is printed under its number with its name.
 *  - **A design another dominates carries no numbers.** It is greyed with the
 *    server's one sentence on why — never one the page wrote for it.
 *  - **The platform never picks a design.** The brand blue is a recorded
 *    decision (`chosen`) and nothing else. The reader writes the comparison
 *    goal first, then chooses and says why; 「写入决策记录」 stays inert until
 *    both the goal and a choice are there.
 *  - **Forecasts are registered before their outcome** (plan §5.4): each one
 *    carries the hash and the time it was frozen at, and — once the actual
 *    data arrive — the prediction beside what happened.
 */
export function TrialTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:trial`, () => getVcrTrial(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const failed = study.steps.trial?.status === "failed";
  const nothing = data.designs.length === 0 && data.ademp.length === 0 && data.forecasts.length === 0 && data.milestones.length === 0;
  if (nothing) {
    return failed
      ? <VcrStepFailed studyId={studyId} study={study} step="trial" partial={data.partial} />
      : <VcrStepPending studyId={studyId} study={study} step="trial" />;
  }
  const chosenCodes = data.designs.filter((design) => design.chosen).map((design) => design.code);

  return (
    <div className="flex flex-col gap-6">
      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="trial" partial={data.partial} />
        : data.partial && <PartialResultNote done={data.partial.done} missing={data.partial.missing} />}

      <Stale note={data.stale}>
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
                rowAttrs={(design) => ({
                  "data-vcr-design": design.code,
                  ...(design.dominated ? { "data-vcr-dominated": "" } : {}),
                  ...(design.chosen ? { "data-vcr-chosen": "" } : {}),
                })}
              />
              {data.footnotes?.map((note, index) => (
                <p key={note} className="mt-1.5 text-caption text-text-3">
                  <span aria-hidden="true" className="mr-1 tabular-nums">{index + 1}</span>
                  {note}
                </p>
              ))}
            </VcrSection>
          )}

          {(data.powerCurve || (data.grid && data.grid.rows.length > 0)) && (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.powerCurve && (
                <ChartCard
                  title="功效随真实效应的变化"
                  legend={<VcrSeriesLegend series={data.powerCurve.series} />}
                >
                  <VcrTrajectoryChart
                    series={data.powerCurve.series}
                    xLabel={data.powerCurve.xLabel}
                    yLabel={data.powerCurve.yLabel}
                    // The server sends the curve as percentages, like every design measure: 0 to 100 is its whole range.
                    domain={[0, 100]}
                    formatY={(value) => `${Math.round(value)}%`}
                  />
                  {data.powerCurve.markers && data.powerCurve.markers.length > 0 && (
                    <p className="mt-2 flex flex-wrap gap-x-4 text-caption text-text-3">
                      {data.powerCurve.markers.map((marker) => (
                        <span key={marker.label} data-vcr-marker={marker.kind ?? ""} className="inline-flex items-center gap-1.5">
                          {marker.label}
                          {marker.kind === "assumed" && <Tag>假设</Tag>}
                        </span>
                      ))}
                    </p>
                  )}
                </ChartCard>
              )}

              {data.grid && data.grid.rows.length > 0 && (
                <Card title={data.grid.measure ? `设计网格：${data.grid.measure}` : "设计网格"}>
                  {data.grid.xLabel && <p className="mb-2 text-caption text-text-3">{data.grid.xLabel}</p>}
                  <HeatGrid
                    label={data.grid.measure ?? "设计网格"}
                    columns={data.grid.columns}
                    rows={data.grid.rows.map((row) => ({ key: row.key, header: row.header, cells: row.cells }))}
                    legend={{ low: "低", high: "高" }}
                  />
                </Card>
              )}
            </div>
          )}

          {(data.designs.length > 1 || data.milestones.length > 0) && (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.designs.length > 1 && (
                <Card title="周期、成本与成功把握的取舍">
                  <VcrTradeoffScatter
                    designs={data.designs}
                    xKey="duration_months"
                    yKey="assurance"
                    sizeKey="cost"
                    xLabel="末例入组中位（月）"
                    yLabel="成功把握"
                    sizeLabel="气泡面积 = 成本"
                  />
                </Card>
              )}
              {data.milestones.length > 0 && (
                <Card title="里程碑">
                  <VcrMilestoneTimeline milestones={data.milestones} chosen={chosenCodes} />
                </Card>
              )}
            </div>
          )}
        </div>
      </Stale>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {data.designs.length > 0
          ? (
            <DecisionCard
              // A recorded decision comes back from the server; the card
              // starts again from what was recorded rather than from what was
              // typed before it.
              key={data.decision?.recordedAt ?? "none"}
              studyId={studyId}
              decision={data.decision}
              designs={data.designs}
              canWrite={study.abilities.includes("write")}
              onRecorded={reload}
            />
          )
          : <span />}
        <div className="flex flex-col gap-4">
          {data.forecasts.length > 0 && <ForecastRegistry forecasts={data.forecasts} />}
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

      <VcrCountsBand counts={data.counts} />
    </div>
  );
}

/** The design a dominated row points at, in the server's words when it sent some. */
function dominatedSentence(design: VcrDesign): string {
  return design.note ?? (design.dominatedBy ? `被 ${design.dominatedBy} 占优` : "被占优");
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
        // numbers at all.
        if (design.dominated) {
          return column.key === data.columns[0]?.key
            ? <span data-vcr-dominated-note="" className="text-text-3">{dominatedSentence(design)}</span>
            : null;
        }
        const value = design.measures[column.key];
        if (!value) return <span className="text-text-3">—</span>;
        const mcse = mcseText(value.mcse);
        // A Monte-Carlo interval is the standard error said again (±1.96 of
        // it); a predicted one — when the last patient comes in — is a
        // different claim, and is printed under its number with its name.
        const interval = value.interval && value.interval.kind !== "monte_carlo" ? intervalText(value.interval, value.precision) : "";
        return (
          <span data-vcr-measure={column.key} data-vcr-source={value.source} className="flex flex-col items-end">
            <span className="inline-flex items-baseline gap-1">
              <VcrNumber value={value} label={`${design.code} ${column.label}`}>
                <span className={cn("tabular-nums", design.chosen && "font-medium")}>{valueText(value)}</span>
              </VcrNumber>
              {mcse && <span data-vcr-mcse="" className="text-meta font-normal text-text-3">{mcse}</span>}
            </span>
            {interval && <span data-vcr-interval="" className="text-meta font-normal text-text-3">{interval}</span>}
          </span>
        );
      },
    })),
  ];
}

/**
 * 预测登记: every forecast frozen before the data it predicts, with the hash
 * and the time that prove it was, and — once the actual data are in — what
 * was predicted beside what happened (plan §5.4, AC-23).
 */
function ForecastRegistry({ forecasts }: { forecasts: readonly VcrForecast[] }) {
  return (
    <Card title="预测登记">
      <ul className="flex flex-col gap-4">
        {forecasts.map((forecast) => {
          const compared = forecast.lines.some((line) => line.actual != null);
          return (
            <li key={forecast.id} data-vcr-forecast={forecast.id}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-ui font-medium text-text">{forecast.label}</span>
                <Tag>{`v${forecast.version}`}</Tag>
                <span data-vcr-forecast-hash="" className="text-caption tabular-nums text-text-3">{`哈希 ${forecast.hash.slice(0, 8)}`}</span>
              </p>
              {(forecast.frozenAt || forecast.comparedAt) && (
                <p className="mt-0.5 text-caption text-text-3">
                  {[forecast.frozenAt ? `冻结于 ${forecast.frozenAt}` : null, forecast.comparedAt ? `与实际对照于 ${forecast.comparedAt}` : null]
                    .filter(Boolean).join(" · ")}
                </p>
              )}
              <table className="mt-2 w-full border-collapse text-caption">
                <caption className="sr-only">{forecast.label}</caption>
                {compared && (
                  <thead>
                    <tr className="border-b border-border text-text-3">
                      <th scope="col" className="py-1 pr-2 text-left font-normal"><span className="sr-only">指标</span></th>
                      <th scope="col" className="py-1 px-2 text-right font-normal">预测</th>
                      <th scope="col" className="py-1 pl-2 text-right font-normal">实际</th>
                    </tr>
                  </thead>
                )}
                <tbody>
                  {forecast.lines.map((line) => (
                    <tr key={line.key} data-vcr-forecast-line={line.key} className="border-b border-faint">
                      <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text-2">{line.label}</th>
                      <td className="py-1.5 px-2 text-right tabular-nums text-text">{line.predicted}</td>
                      {compared && <td className="py-1.5 pl-2 text-right tabular-nums text-text">{line.actual ?? "—"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * The decision: the reader's comparison goal, the design they chose, and why.
 *
 * The goal comes first and is required — a decision with no goal is a pick,
 * not a decision (plan §5.4) — and the other reasonable designs are recorded
 * beside the choice. The platform records the decision; it does not make it,
 * and the brand blue on the page follows the record, never this card's own
 * state. One request at a time: a decision written twice is two records.
 */
function DecisionCard({ studyId, decision, designs, canWrite, onRecorded }: {
  studyId: string;
  decision: TrialData["decision"];
  designs: readonly VcrDesign[];
  /** Writing a decision is `write`'s; a reader without it sees the record and no button that would be refused. */
  canWrite: boolean;
  onRecorded: () => void;
}) {
  const [goal, setGoal] = useState(decision?.goal ?? "");
  const [chosen, setChosen] = useState<string | null>(decision?.chosen ?? null);
  const [rationale, setRationale] = useState(decision?.rationale ?? "");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const options = decision?.options.length
    ? decision.options
    : designs.map((design) => ({ id: design.id, label: design.code, name: design.name, disabled: design.dominated }));
  const ready = goal.trim().length > 0 && chosen !== null;

  const save = () => {
    if (!ready || holding.current) return;
    const design = designs.find((item) => item.id === chosen);
    const option = options.find((item) => item.id === chosen);
    // A record is read months later, away from the chip: it says 「方案 B 2:1 随机」, not 「2:1 随机」.
    const said = (code: string, name: string) => `方案 ${code} ${name}`.trim();
    const pick = {
      id: chosen,
      code: design?.code ?? option?.label ?? "",
      label: design ? said(design.code, design.name) : said(option?.label ?? "", option?.name ?? ""),
    };
    const alternatives = designs
      .filter((item) => !item.dominated && item.id !== chosen)
      .map((item) => ({ code: item.code, label: said(item.code, item.name) }));
    holding.current = true;
    setBusy(true);
    void recordVcrDecision(studyId, {
      question: goal.trim(),
      chosen: pick,
      alternatives,
      ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
    })
      .then(() => {
        toast.success("已写入决策记录。");
        onRecorded();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "决策记录暂时无法写入，请稍后重试。" })))
      .finally(() => {
        holding.current = false;
        setBusy(false);
      });
  };

  // Without `write` the card is the record and nothing to fill in: a form whose
  // only button would be refused is not offered.
  if (!canWrite) {
    if (!decision?.recordedAt) return null;
    return (
      <Card title="决策">
        <dl data-vcr-decision-record="" className="divide-y divide-faint">
          {[
            { label: "比较目标", value: decision.goal },
            { label: "选定方案", value: decision.chosenLabel ?? options.find((option) => option.id === decision.chosen)?.label },
            { label: "选择理由", value: decision.rationale },
          ].filter((row) => row.value).map((row) => (
            <div key={row.label} className="grid grid-cols-[6rem_1fr] gap-3 py-2">
              <dt className="text-caption text-text-3">{row.label}</dt>
              <dd className="min-w-0 text-ui text-text">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-caption tabular-nums text-text-3">{`记录于 ${decision.recordedAt}`}</p>
      </Card>
    );
  }

  return (
    <Card title="决策">
      <div data-vcr-decision="" className="flex flex-col gap-3">
        <Textarea
          id="vcr-decision-goal"
          label="比较目标"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          placeholder="例如：成功把握不低于 70% 的前提下，末例入组不晚于 18 个月，成本最低……"
        />
        <fieldset>
          <legend className="text-caption text-text-3">选定方案</legend>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {options.map((option) => (
              <Tooltip key={option.id} content={option.name ?? option.label}>
              <label
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
              </Tooltip>
            ))}
          </div>
        </fieldset>
        <Textarea
          id="vcr-decision-rationale"
          label="选择理由"
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          rows={2}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={!ready || busy} loading={busy} onClick={save}>写入决策记录</Button>
          <span className="text-caption text-text-3">{decision?.note ?? NO_AUTO_PICK}</span>
          {decision?.recordedAt && <span className="text-caption tabular-nums text-text-3">{`上次记录于 ${decision.recordedAt}`}</span>}
        </div>
      </div>
    </Card>
  );
}
