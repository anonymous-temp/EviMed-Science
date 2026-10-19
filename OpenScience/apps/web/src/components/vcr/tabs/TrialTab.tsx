import { useRef, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { getVcrTrial, recordVcrDecision, type VcrDesign, type VcrStudy, type VcrTrialTab as TrialData } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid, type ChartGridCell } from "@/components/ui/ChartGrid";
import { DataTable, InlineBar, type DataColumn } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Headline } from "@/components/ui/Headline";
import { Textarea } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import type { NotePart } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { EmptyState } from "@/components/cards/EmptyState";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { VcrSeriesLegend, VcrTrajectoryChart } from "../VcrCharts";
import { VcrMilestoneTimeline, VcrTradeoffScatter, canDrawTradeoff } from "../VcrDiagrams";
import { VcrPredictionsDrawer } from "../VcrPredictionsDrawer";
import { RegulatoryContactForm, VcrRegulatoryLog } from "../VcrRegulatoryLog";
import { VcrScheduleCard } from "../VcrSchedule";
import { VcrNumber } from "../VcrNumber";
import { VcrSettingsDrawer } from "../VcrSettingsDrawer";
import { VcrToolbarActions, type VcrToolbarAction } from "../VcrToolbarActions";
import { PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useStudyFrame, useVcrPrimary, useVcrToolbar } from "../studyFrameContext";
import { pairRows, useVcrLoad, VcrTabError } from "../vcrTabKit";
import { intervalText, mcseText, numberText, valueText } from "../vcrText";

/**
 * Whether a design has been computed: it holds a number of a result. A design with only its configured sample size (or its cost) has
 * been written, not run — the rule `designsSentence` applies on the server — and is neither compared nor chosen on that.
 */
export const designRan = (design: Pick<VcrDesign, "measures" | "dominated">): boolean =>
  // A dominated design was computed — dominance is decided on its numbers — and the server sends none for it (it prints one sentence instead).
  design.dominated === true || Object.keys(design.measures ?? {}).some((key) => key !== "sample_size" && key !== "cost");

/** Whether a design has a run to open: a record of its own, or at least how many replicates and by what method. */
const hasRun = (design: VcrDesign): boolean => Boolean(design.record || design.replicates != null || design.method);

/** What a design that has not been computed says where its numbers would be. */
const NOT_RUN = "还没算";

/**
 * What 「加一个方案」 and 「改假设」 put in the conversation's composer — never sent. A design is described and a hypothesis argued
 * in a sentence, which is the conversation's work (the model writes the structure, the platform computes it); the page's own edit
 * of a design is a number on its row (「改设定」).
 */
export const VCR_ADD_DESIGN_DRAFT = "再加一个试验方案：";
export const VCR_CHANGE_ASSUMPTION_DRAFT = "我想改一下试验的假设：";

type TrialView = "designs" | "schedule" | "regulatory";

/**
 * 试验: what each design would actually do, and what choosing one costs.
 *
 * The page is a conclusion and a table (R19, plan §5.3; audit B §4.4). The conclusion is one sentence — what each design needs and
 * how the designs did — and the table under it is the comparison: events, patients, simulated power (a bar and its number, with the
 * Monte-Carlo error beside it) and what the other measures came out at. A row opens the run behind it. What explains the table
 * follows it: the simulation's setup, the power curve and the trade-offs side by side, the grid, the milestones, the forecasts.
 *
 * Three kinds of record live on this step and the page shows one at a time (a switch in the band): the designs, the protocol's
 * visit schedule and the log of contacts with a regulator. The things a reader does about the designs — choose one, add one,
 * argue a hypothesis, register a prediction — are the band's buttons.
 *
 * Four rules hold this page together.
 *
 *  - **Every simulated number carries its Monte-Carlo standard error.** 71% and 71% ±0.4 are different claims, and a design chosen
 *    on the difference between two numbers inside each other's simulation error was chosen by noise. A predicted interval is
 *    printed under its number with its name.
 *  - **A design another dominates carries no numbers.** It is greyed with the server's one sentence on why — never one the page
 *    wrote for it.
 *  - **The platform never picks a design.** The brand blue is a recorded decision (`chosen`) and nothing else. The reader writes
 *    the comparison goal first, then chooses and says why; 「写入决策记录」 stays inert until both the goal and a choice are there.
 *  - **Forecasts are registered before their outcome** (plan §5.4): each one carries the time it was frozen at and — once the
 *    actual data arrive — the prediction beside what happened.
 *
 * The run behind a row (its method, its replicates, its seed and the check of the closed form against the simulation) is the row's
 * record, behind a press on it; the check is a ✓ or a ⚠ with the two numbers, and no sentence about it stands on the page.
 */
export function TrialTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:trial`, () => getVcrTrial(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  return <TrialView studyId={studyId} study={study} data={state.data} reload={reload} />;
}

function TrialView({ studyId, study, data, reload }: { studyId: string; study: VcrStudy; data: TrialData; reload: () => void }) {
  const frame = useStudyFrame();
  const [view, setView] = useState<TrialView>("designs");
  const [choosing, setChoosing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [editing, setEditing] = useState<VcrDesign | null>(null);
  const [recording, setRecording] = useState(false);
  const [opened, setOpened] = useState<VcrDesign | null>(null);

  const failed = study.steps.trial?.status === "failed";
  const canWrite = study.abilities.includes("write");
  // The protocol's visit schedule and the regulatory log are records of the study, not results of this step: a study that has either is not empty.
  const hasDesigns = data.designs.length > 0 || data.ademp.length > 0 || data.forecasts.length > 0 || data.milestones.length > 0;
  const nothing = !hasDesigns && !data.schedule && data.regulatory.length === 0;
  const noneRan = !data.designs.some(designRan);
  const decided = Boolean(data.decision?.chosen);
  // 「登记预测」 is the lead's (and only where the deployment has a registry); a reader who may not file still opens what has been filed.
  const canFile = Boolean(study.features?.predictions) && study.abilities.includes("manage_study");
  const hasForecasts = data.forecasts.length > 0;

  // One kind of record at a time: the switch exists when the step holds more than one kind.
  const views: Array<{ value: TrialView; label: string; count?: number }> = [];
  if (hasDesigns) views.push({ value: "designs", label: "方案", ...(data.designs.length > 0 ? { count: data.designs.length } : {}) });
  if (data.schedule) views.push({ value: "schedule", label: "访视" });
  if (data.regulatory.length > 0 || canWrite) views.push({ value: "regulatory", label: "监管", ...(data.regulatory.length > 0 ? { count: data.regulatory.length } : {}) });
  const shown: TrialView = views.some((entry) => entry.value === view) ? view : views[0]?.value ?? "designs";

  // 「加一个方案」 and 「改假设」 say it in the conversation: the draft waits in the composer, and the reader sends it.
  const draft = (text: string) => () => frame?.openChat(text);

  const actions: VcrToolbarAction[] = [];
  if (shown === "designs" && !nothing) {
    if (canWrite) {
      if (!noneRan && decided) actions.push({ key: "choose", label: "改选方案", onSelect: () => setChoosing(true) });
      if (frame) {
        actions.push({ key: "add", label: "加一个方案", quiet: !noneRan, onSelect: draft(VCR_ADD_DESIGN_DRAFT) });
        actions.push({ key: "change", label: "改假设", quiet: true, onSelect: draft(VCR_CHANGE_ASSUMPTION_DRAFT) });
      }
    }
    if ((!noneRan && canFile) || hasForecasts) actions.push({ key: "register", label: "登记预测", onSelect: () => setRegistering(true) });
  }
  if (shown === "regulatory" && canWrite && data.regulatory.length > 0) actions.push({ key: "record", label: "添加监管沟通", onSelect: () => setRecording(true) });

  useVcrToolbar(!nothing && (views.length > 1 || actions.length > 0)
    ? {
      label: "试验的筛选与操作",
      ...(views.length > 1
        ? { filters: [{ kind: "chips" as const, label: "记录", neutral: views[0].value, value: shown, onChange: (next: string) => setView(next as TrialView), options: views }] }
        : {}),
      ...(shown === "designs" && data.designs.length > 0 && views.length === 1 ? { summary: `${data.designs.length} 个方案` } : {}),
      ...(actions.length > 0 ? { actions: <VcrToolbarActions actions={actions} /> } : {}),
    }
    : null);

  // 「选定方案」 is the page's next thing for the reader until a design is chosen: the header's primary, not a button in the band.
  useVcrPrimary(shown === "designs" && !nothing && canWrite && !noneRan && !decided ? { label: "选定方案", onSelect: () => setChoosing(true) } : null);

  if (nothing) {
    return failed
      ? <VcrStepFailed studyId={studyId} study={study} step="trial" partial={data.partial} />
      : <VcrStepPending studyId={studyId} study={study} step="trial" />;
  }

  const chosenDesign = data.designs.find((design) => design.id === data.decision?.chosen) ?? null;
  const headline: NotePart[] = [];
  if (data.headline) headline.push(data.headline);
  if (decided && data.decision?.recordedAt) {
    headline.push(data.headline ? " 已选定方案 " : "已选定方案 ");
    headline.push(chosenDesign ? { n: chosenDesign.code, onOpen: () => setOpened(chosenDesign), label: `方案 ${chosenDesign.code}，看它是怎么算的` } : (data.decision.chosenLabel ?? ""));
    if (data.decision.rationale) headline.push(`，理由：${data.decision.rationale}`);
  }

  return (
    <div className="flex flex-col gap-6">
      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="trial" partial={data.partial} />
        : data.partial && <PartialResultNote sentence={data.partial.sentence} resume={{ studyId, study, step: "trial" }} />}

      {shown === "designs" && (
        <Stale note={data.stale}>
          <DesignsView
            studyId={studyId}
            study={study}
            data={data}
            headline={headline}
            noneRan={noneRan}
            failed={failed}
            onOpen={setOpened}
            onEdit={canWrite ? setEditing : null}
          />
        </Stale>
      )}

      {shown === "schedule" && data.schedule && <VcrScheduleCard schedule={data.schedule} />}

      {shown === "regulatory" && (data.regulatory.length > 0
        ? <VcrRegulatoryLog contacts={data.regulatory} />
        : (
          <EmptyState
            title="还没有监管沟通记录"
            action={canWrite ? <Button variant="secondary" onClick={() => setRecording(true)}>记录监管沟通</Button> : undefined}
            reason={canWrite ? undefined : "与监管机构沟通之后，由有写入权限的成员记录在这里。"}
          />
        ))}

      {registering && (
        <VcrPredictionsDrawer
          studyId={studyId}
          designs={data.designs}
          forecasts={data.forecasts}
          canFile={canFile}
          onFiled={reload}
          onClose={() => setRegistering(false)}
        />
      )}

      {choosing && (
        <Drawer title="选定方案" onClose={() => setChoosing(false)} widthClassName="max-w-md">
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

      {recording && (
        <Drawer title="添加监管沟通记录" onClose={() => setRecording(false)} widthClassName="max-w-md">
          <RegulatoryContactForm studyId={studyId} onAdded={() => { setRecording(false); reload(); }} />
        </Drawer>
      )}

      {opened && <DesignRecordDrawer design={opened} onClose={() => setOpened(null)} onEdit={canWrite ? () => { setEditing(opened); setOpened(null); } : null} />}

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

/* ------------------------------------------------------------------------- the designs */

function DesignsView({ studyId, study, data, headline, noneRan, failed, onOpen, onEdit }: {
  studyId: string;
  study: VcrStudy;
  data: TrialData;
  headline: NotePart[];
  noneRan: boolean;
  failed: boolean;
  onOpen: (design: VcrDesign) => void;
  onEdit: ((design: VcrDesign) => void) | null;
}) {
  const chosenCodes = data.designs.filter((design) => design.chosen).map((design) => design.code);
  // The trade-off is drawn only when there is something to place: two designs with a duration and an assurance. A card whose chart
  // draws nothing is a title over an empty box.
  const tradeoff = data.designs.length > 1 && canDrawTradeoff(data.designs, "duration_months", "assurance");
  const powerCurve = data.powerCurve && data.powerCurve.series.length > 0 ? data.powerCurve : null;
  const cells: ChartGridCell[] = [];
  if (powerCurve) {
    cells.push({
      key: "power-curve",
      node: (
        <ChartCard title="功效随真实效应的变化" legend={<VcrSeriesLegend series={powerCurve.series} />}>
          <VcrTrajectoryChart
            series={powerCurve.series}
            xLabel={powerCurve.xLabel}
            yLabel={powerCurve.yLabel}
            // The server sends the curve as percentages, like every design measure: 0 to 100 is its whole range.
            domain={[0, 100]}
            formatY={(value) => `${Math.round(value)}%`}
          />
          {powerCurve.markers && powerCurve.markers.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-x-4 text-caption text-text-3">
              {powerCurve.markers.map((marker) => (
                <span key={marker.label} data-vcr-marker={marker.kind ?? ""} className="inline-flex items-center gap-1.5">
                  {marker.label}
                  {marker.kind === "assumed" && <Tag>假设</Tag>}
                </span>
              ))}
            </p>
          )}
        </ChartCard>
      ),
    });
  }
  if (tradeoff) {
    cells.push({
      key: "tradeoff",
      node: (
        <ChartCard title="周期、成本与成功把握的取舍">
          <VcrTradeoffScatter
            designs={data.designs}
            xKey="duration_months"
            yKey="assurance"
            sizeKey="cost"
            xLabel="末例入组中位（月）"
            yLabel="成功把握"
            sizeLabel="气泡面积 = 成本"
          />
        </ChartCard>
      ),
    });
  }
  if (data.grid && data.grid.rows.length > 0) {
    cells.push({
      key: "grid",
      // Five scenarios do not fit in half a page: the grid takes the row, and its last column is not cut.
      ...(data.grid.columns.length > 3 ? { span: 2 as const } : {}),
      node: (
        <Card title={data.grid.measure ? `设计网格：${data.grid.measure}` : "设计网格"}>
          {data.grid.xLabel && <p className="mb-2 text-caption text-text-3">{data.grid.xLabel}</p>}
          <HeatGrid
            label={data.grid.measure ?? "设计网格"}
            columns={data.grid.columns}
            rows={data.grid.rows.map((row) => ({ key: row.key, header: row.header, cells: row.cells }))}
            legend={{ low: "低", high: "高" }}
          />
        </Card>
      ),
    });
  }
  if (data.milestones.length > 0) {
    cells.push({ key: "milestones", node: <Card title="里程碑"><VcrMilestoneTimeline milestones={data.milestones} chosen={chosenCodes} /></Card> });
  }

  const setup: Fact[] = data.ademp.map((line) => ({ label: line.label, value: line.text }));
  return (
    <div className="flex flex-col gap-6">
      {headline.length > 0 && <Headline parts={headline} />}

      {noneRan
        ? <NotComputedDesigns designs={data.designs} studyId={studyId} study={study} failed={failed} />
        : (
          <div>
            <DataTable
              label="方案的对比"
              columns={designColumns(data, onEdit, onOpen)}
              rows={data.designs}
              rowKey={(design) => design.id}
              highlight={(design) => Boolean(design.chosen)}
              rowAttrs={(design) => ({
                "data-vcr-design": design.code,
                ...(design.dominated ? { "data-vcr-dominated": "" } : {}),
                ...(design.chosen ? { "data-vcr-chosen": "" } : {}),
              })}
              onRowOpen={(design) => { if (hasRun(design)) onOpen(design); }}
            />
            {data.footnotes?.map((note, index) => (
              <p key={note} className="mt-1.5 text-caption text-text-3">
                <span aria-hidden="true" className="mr-1 tabular-nums">{index + 1}</span>
                {note}
              </p>
            ))}
          </div>
        )}

      {/* How the simulation was set up, folded under the comparison it explains: the lines are what a reviewer checks, not what a
          reader of the table needs first. */}
      {setup.length > 0 && (
        <Disclosure summary="模拟设定">
          <div data-vcr-setup=""><FactList rows={setup} max={setup.length} /></div>
        </Disclosure>
      )}

      {cells.length > 0 && <ChartGrid rows={pairRows(cells)} />}
    </div>
  );
}

/**
 * The designs a conversation wrote that nothing has computed: each with 「还没算」, and under them what is happening to that — being
 * done now, did not finish, or waiting for its start. No table, no metric column and no choice: there is nothing to compare yet.
 */
function NotComputedDesigns({ designs, studyId, study, failed }: { designs: readonly VcrDesign[]; studyId: string; study: VcrStudy; failed: boolean }) {
  if (designs.length === 0) return null;
  return (
    <div data-vcr-not-computed="">
      <List label="还没算的方案" divided>
        {designs.map((design) => (
          <ListRow
            key={design.id}
            title={design.name}
            leading={<span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-tag bg-surface-2 text-meta text-text-2">{design.code}</span>}
            trailing={<Tag>{NOT_RUN}</Tag>}
            titleProps={{ "data-vcr-design": design.code }}
          />
        ))}
      </List>
      {/* A step that did not finish already says so at the top of the tab, with 接着做. */}
      {!failed && <div className="mt-4"><VcrStepPending studyId={studyId} study={study} step="trial" /></div>}
    </div>
  );
}

/**
 * The grid's columns, from the payload's own list. A dominated design says what beat it under its name and draws no numbers;
 * power is a bar and its number.
 */
function designColumns(data: TrialData, onEdit: ((design: VcrDesign) => void) | null, onOpen: ((design: VcrDesign) => void) | null): Array<DataColumn<VcrDesign>> {
  return [
    {
      key: "design",
      header: "方案",
      rowHeader: true,
      cell: (design) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-tag text-meta",
              design.dominated ? "bg-surface-2 text-text-3" : design.chosen ? "bg-accent text-accent-fg" : "bg-surface-2 text-text-2")}
            >
              {design.code}
            </span>
            {/* The keyboard's way into the run behind the row; a press anywhere else on the row does the same for a pointer. */}
            {onOpen && hasRun(design)
              ? (
                <button type="button" aria-label={`打开方案 ${design.code} 的计算详情`} onClick={() => onOpen(design)} className={cn("rounded text-left font-normal hover:underline", design.dominated ? "text-text-3" : "text-text")}>
                  {design.name}
                </button>
              )
              : <span className={design.dominated ? "text-text-3" : "text-text"}>{design.name}</span>}
            {design.dominated && <Tag>{design.dominatedBy ? `被 ${design.dominatedBy} 占优` : "被占优"}</Tag>}
          </span>
          {/* A dominated design says why under its name, in the column that is wide enough for a sentence; its numbers are not drawn. */}
          {design.note && <span {...(design.dominated ? { "data-vcr-dominated-note": "" } : {})} className="text-caption text-text-3">{design.note}</span>}
        </span>
      ),
    },
    ...data.columns.map((column): DataColumn<VcrDesign> => ({
      key: column.key,
      header: column.unit ? `${column.label}（${column.unit}）` : column.label,
      align: "right",
      isEmpty: (design) => design.measures[column.key]?.value == null && !design.measures[column.key]?.text,
      cell: (design) => {
        // A dominated design gives no numbers at all; what it was beaten by is said in its first cell.
        if (design.dominated) return null;
        const value = design.measures[column.key];
        if (!value) return <span data-vcr-not-run={designRan(design) ? undefined : ""} className="text-text-3">{designRan(design) ? "—" : NOT_RUN}</span>;
        const mcse = mcseText(value.mcse);
        // A Monte-Carlo interval is the standard error said again (±1.96 of it); a predicted one — when the last patient comes in — is a
        // different claim, and is printed under its number with its name.
        const interval = value.interval && value.interval.kind !== "monte_carlo" ? intervalText(value.interval, value.precision) : "";
        return (
          <span data-vcr-measure={column.key} data-vcr-source={value.source} className="flex flex-col items-end">
            <span className="inline-flex items-baseline gap-1">
              <VcrNumber value={value} label={`${design.code} ${column.label}`} className="font-normal">
                <span className="tabular-nums">{valueText(value)}</span>
              </VcrNumber>
              {mcse && (
                <Tooltip content="蒙特卡洛标准误">
                  <span data-vcr-mcse="" className="text-meta font-normal text-text-3">{mcse}</span>
                </Tooltip>
              )}
            </span>
            {/* Power is the measure the page is read for, so it is drawn as a length as well as a number (a table with bars). */}
            {column.key === "power" && typeof value.value === "number" && (
              <span className="mt-1 block w-24">
                <InlineBar value={value.value} max={100} tone={design.chosen ? "own" : "rival"} label={`${design.code} 功效 ${valueText(value)}`} />
              </span>
            )}
            {interval && <span data-vcr-interval="" className="text-meta font-normal text-text-3">{interval}</span>}
          </span>
        );
      },
    })),
    {
      key: "replicates",
      header: <span className="whitespace-nowrap">模拟次数</span>,
      align: "right",
      isEmpty: (design) => design.dominated === true || design.replicates == null,
      cell: (design) => (design.replicates == null || design.dominated
        ? <span className="text-text-3">—</span>
        : <span data-vcr-replicates="" className="whitespace-nowrap tabular-nums text-text-2">{numberText(design.replicates, 0)}</span>),
    },
    {
      key: "method",
      header: <span className="whitespace-nowrap">来源</span>,
      isEmpty: (design) => !design.method || design.dominated === true,
      cell: (design) => (design.method && !design.dominated ? <span data-vcr-method="" className="whitespace-nowrap text-caption text-text-3">{design.method}</span> : null),
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
 * 方案记录: the run behind a row — how the numbers were made, how many replicates, the seed that makes them again, and the check of
 * the closed form against the simulation, as the two numbers and a mark (✓ they agree within what was allowed, ⚠ they do not). It
 * used to stand under the table as a card of sentences; a reader checking a run opens it, a reader choosing a design does not need it.
 */
function DesignRecordDrawer({ design, onClose, onEdit }: { design: VcrDesign; onClose: () => void; onEdit: (() => void) | null }) {
  const record = design.record;
  const check = record?.check ?? null;
  const rows: Fact[] = [];
  const method = record?.method ?? design.method;
  if (method) rows.push({ label: "方法", value: method });
  const replicates = record?.replicates ?? design.replicates;
  if (replicates != null) rows.push({ label: "模拟次数", value: numberText(replicates, 0) });
  if (record?.seed != null) rows.push({ label: "随机种子", value: String(record.seed) });
  if (check && check.analytic != null && check.simulated != null) {
    const ok = check.agrees;
    rows.push({
      label: "与解析值核对",
      value: (
        <span data-vcr-check={ok === null ? "unknown" : ok ? "agrees" : "differs"} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="tabular-nums">{`解析 ${numberText(check.analytic)} · 仿真 ${numberText(check.simulated)}`}</span>
          {check.differencePoints != null && (
            <span className="tabular-nums text-text-2">{`相差 ${numberText(check.differencePoints)} 个百分点${check.allowedPoints != null ? `（容许 ${numberText(check.allowedPoints)}）` : ""}`}</span>
          )}
          {ok === true && <span role="img" aria-label="一致" className="inline-flex text-ok"><CircleCheck size={16} aria-hidden="true" /></span>}
          {ok === false && <span role="img" aria-label="不一致" className="inline-flex text-warn-strong"><TriangleAlert size={16} aria-hidden="true" /></span>}
          {check.approximate && <Tag>一阶近似</Tag>}
        </span>
      ),
    });
  }
  return (
    <Drawer title={`方案 ${design.code} · ${design.name}`} onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-design-record={design.code} className="flex flex-col gap-4">
        {rows.length > 0 && <FactList rows={rows} />}
        {onEdit && <div><Button variant="secondary" size="sm" onClick={onEdit}>改设定</Button></div>}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------------- the decision */

/**
 * 选定方案: the reader's comparison goal, the design they chose, and why — in a drawer opened from the band.
 *
 * The goal comes first and is required — a decision with no goal is a pick, not a decision (plan §5.4) — and the other reasonable
 * designs are recorded beside the choice. The platform records the decision; it does not make it, and the brand blue on the page
 * follows the record, never this form's own state. One request at a time: a decision written twice is two records.
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
  // A design nobody has computed is not chosen on: there is no number to choose it by.
  const notRun = new Set(designs.filter((design) => !designRan(design)).map((design) => design.id));
  const options = (decision?.options.length
    ? decision.options
    : designs.map((design) => ({ id: design.id, label: design.code, name: design.name, disabled: design.dominated })))
    .map((option) => (notRun.has(option.id) ? { ...option, disabled: true } : option));
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
        placeholder="先写比较目标，再选一个方案。例如：成功把握不低于 70% 的前提下，末例入组不晚于 18 个月，成本最低……"
      />
      <fieldset>
        <legend className="text-caption text-text-3">选定方案</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {options.map((option) => (
            <Tooltip key={option.id} content={option.name ?? option.label}>
              <label
                className={cn(
                  "inline-flex h-control cursor-pointer items-center gap-1.5 rounded px-3 text-ui",
                  option.disabled ? "cursor-not-allowed bg-surface-1 text-text-3" : chosen === option.id ? "bg-accent-soft text-accent" : "bg-surface-2 text-text-2",
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
        {decision?.recordedAt && <span className="text-caption tabular-nums text-text-3">{`上次记录于 ${decision.recordedAt}`}</span>}
      </div>
    </form>
  );
}
