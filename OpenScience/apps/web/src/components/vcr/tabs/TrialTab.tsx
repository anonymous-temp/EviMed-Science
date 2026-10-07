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
import { Drawer } from "@/components/ui/Drawer";
import { Textarea } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { VcrSeriesLegend, VcrTrajectoryChart } from "../VcrCharts";
import { VcrMilestoneTimeline, VcrTradeoffScatter } from "../VcrDiagrams";
import { ReviewChip } from "../VcrMarks";
import { VcrFilePrediction } from "../VcrFilePrediction";
import { VcrNumber } from "../VcrNumber";
import { VcrSettingsDrawer } from "../VcrSettingsDrawer";
import { PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useOpenVcrConversation } from "../useOpenVcrConversation";
import { useVcrLoad, VcrHeadline, VcrTabError } from "../vcrTabKit";
import { intervalText, mcseText, numberText, valueText } from "../vcrText";

/** What the decision card says under its button, when the server does not say it itself. */
const NO_AUTO_PICK = "平台不自动选定方案。";

/**
 * What 「加一个方案」 and 「改假设」 put in the conversation's composer — never sent. A design is described and a hypothesis argued
 * in a sentence, which is the conversation's work (the model writes the structure, the platform computes it); the page's own edit
 * of a design is a number on its row (「改设定」).
 */
export const VCR_ADD_DESIGN_DRAFT = "再加一个试验方案：";
export const VCR_CHANGE_ASSUMPTION_DRAFT = "我想改一下试验的假设：";

/**
 * 试验: what each design would actually do, and what choosing one costs.
 *
 * The page is a conclusion and a table. The conclusion is one sentence — what each design needs and how the designs did — with
 * the three things a reader does about it beside it: 选定方案, 加一个方案, 改假设. The table under it is the comparison: events,
 * patients, simulated power with its Monte-Carlo error, how many replicates, and what the numbers come from. Everything that
 * explains the table (the simulation's setup, the power curve, the grid, the trade-offs, the milestones, the forecasts) follows it.
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
 *    carries the time it was frozen at and — once the actual data arrive —
 *    the prediction beside what happened.
 */
export function TrialTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:trial`, () => getVcrTrial(studyId));
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState<VcrDesign | null>(null);
  const openConversation = useOpenVcrConversation();
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
  const canWrite = study.abilities.includes("write");
  const decided = Boolean(data.decision?.chosen);

  // 「加一个方案」 and 「改假设」 say it in the conversation: the draft waits in the composer, and the reader sends it.
  const draft = (text: string) => {
    void openConversation({ projectId: study.projectId, sessionId: study.sessionId }, text)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" })));
  };

  return (
    <div className="flex flex-col gap-6">
      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="trial" partial={data.partial} />
        : data.partial && <PartialResultNote done={data.partial.done} missing={data.partial.missing} />}

      <Stale note={data.stale}>
        <div className="flex flex-col gap-6">
          <section data-vcr-conclusion="" className="rounded-card border border-border bg-surface p-5">
            {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}
            {decided && data.decision?.recordedAt && (
              <p data-vcr-decided="" className="mt-2 text-ui text-text-2">
                {`已选定${data.decision.chosenLabel ? `：${data.decision.chosenLabel}` : ""}${data.decision.rationale ? `，理由：${data.decision.rationale}` : ""}`}
              </p>
            )}
            {canWrite && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button variant={decided ? "secondary" : "primary"} onClick={() => setChoosing(true)}>{decided ? "改选方案" : "选定方案"}</Button>
                <Button variant="text" onClick={() => draft(VCR_ADD_DESIGN_DRAFT)}>加一个方案</Button>
                <Button variant="text" onClick={() => draft(VCR_CHANGE_ASSUMPTION_DRAFT)}>改假设</Button>
              </div>
            )}
          </section>

          {data.designs.length > 0 && (
            <div>
              <DataTable
                label="方案的对比"
                columns={designColumns(data, canWrite ? setEditing : null)}
                rows={data.designs}
                rowKey={(design) => design.id}
                highlight={(design) => Boolean(design.chosen)}
                rowAttrs={(design) => ({
                  "data-vcr-design": design.code,
                  ...(design.dominated ? { "data-vcr-dominated": "" } : {}),
                  ...(design.chosen ? { "data-vcr-chosen": "" } : {}),
                })}
              />
              <p className="mt-2 text-caption text-text-3">功效后的 ± 是蒙特卡洛标准误。点任一个数，看它用了哪些假设、哪次运行。</p>
              {data.footnotes?.map((note, index) => (
                <p key={note} className="mt-1.5 text-caption text-text-3">
                  <span aria-hidden="true" className="mr-1 tabular-nums">{index + 1}</span>
                  {note}
                </p>
              ))}
            </div>
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

          {data.ademp.length > 0 && (
            <Card
              header={(
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-section font-semibold text-text">模拟设定</h2>
                  <span className="flex-1" />
                  <ReviewChip state={data.ademReview ?? null} />
                </div>
              )}
            >
              <dl data-vcr-setup="" className="divide-y divide-faint">
                {data.ademp.map((line) => (
                  <div key={line.key} className="grid grid-cols-[7rem_1fr] gap-3 py-2">
                    <dt className="text-caption text-text-3">{line.label}</dt>
                    <dd className="min-w-0 text-ui text-text">{line.text}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </div>
      </Stale>

      {(data.forecasts.length > 0 || data.runRecord.length > 0 || (study.features?.predictions && study.abilities.includes("manage_study"))) && (
        <div className="grid gap-4 xl:grid-cols-2">
          {study.features?.predictions && study.abilities.includes("manage_study") && <VcrFilePrediction studyId={studyId} designs={data.designs} />}
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
      )}

      {choosing && (
        <Drawer title="选定方案" description="平台不自动选定方案：先写比较目标，再选一个，并说明理由。" onClose={() => setChoosing(false)} widthClassName="max-w-md">
          <DecisionForm
            // A recorded decision comes back from the server; the form starts again from what was recorded rather than from what was typed.
            key={data.decision?.recordedAt ?? "none"}
            studyId={studyId}
            decision={data.decision}
            designs={data.designs}
            onRecorded={() => { setChoosing(false); reload(); }}
          />
        </Drawer>
      )}

      {editing && (
        <VcrSettingsDrawer
          studyId={studyId}
          kind="trial_scenario"
          objectId={editing.id}
          title={`改设定：${editing.code} ${editing.name}`}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
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
function designColumns(data: TrialData, onEdit: ((design: VcrDesign) => void) | null): Array<DataColumn<VcrDesign>> {
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
    {
      key: "replicates",
      header: "模拟次数",
      align: "right",
      isEmpty: (design) => design.dominated === true || design.replicates == null,
      cell: (design) => (design.replicates == null || design.dominated
        ? <span className="text-text-3">—</span>
        : <span data-vcr-replicates="" className="tabular-nums text-text-2">{numberText(design.replicates, 0)}</span>),
    },
    {
      key: "method",
      header: "来源",
      isEmpty: (design) => !design.method || design.dominated === true,
      cell: (design) => (design.method && !design.dominated ? <span data-vcr-method="" className="text-caption text-text-3">{design.method}</span> : null),
    },
    ...(onEdit ? [{
      key: "edit",
      header: <span className="sr-only">操作</span>,
      align: "right" as const,
      cell: (design: VcrDesign) => (
        <Button size="sm" variant="text" data-vcr-edit={design.code} onClick={() => onEdit(design)} aria-label={`改设定：方案 ${design.code}`}>改设定</Button>
      ),
    }] : []),
  ];
}

/**
 * 预测登记: every forecast frozen before the data it predicts, with the time
 * it was frozen at, and — once the actual data are in — what was predicted
 * beside what happened (plan §5.4, AC-23). The hash that proves it is the
 * registry's, and stays there.
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
 * 选定方案: the reader's comparison goal, the design they chose, and why — in a drawer opened from the conclusion.
 *
 * The goal comes first and is required — a decision with no goal is a pick,
 * not a decision (plan §5.4) — and the other reasonable designs are recorded
 * beside the choice. The platform records the decision; it does not make it,
 * and the brand blue on the page follows the record, never this form's own
 * state. One request at a time: a decision written twice is two records.
 */
function DecisionForm({ studyId, decision, designs, onRecorded }: {
  studyId: string;
  decision: TrialData["decision"];
  designs: readonly VcrDesign[];
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

  return (
    <form data-vcr-decision="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
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
        <Button type="submit" disabled={!ready || busy} loading={busy}>写入决策记录</Button>
        <span className="text-caption text-text-3">{decision?.note ?? NO_AUTO_PICK}</span>
        {decision?.recordedAt && <span className="text-caption tabular-nums text-text-3">{`上次记录于 ${decision.recordedAt}`}</span>}
      </div>
    </form>
  );
}
