import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronRight, CircleCheck, CircleDashed, Download } from "lucide-react";
import {
  downloadVcrRecords,
  getVcrPatients,
  runVcrStep,
  type VcrCalibrationRow,
  type VcrPatientsTab as PatientsData,
  type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid, type ChartGridCell } from "@/components/ui/ChartGrid";
import { Disclosure } from "@/components/ui/Disclosure";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Headline } from "@/components/ui/Headline";
import { Note, type NotePart } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import type { ToolbarChips, ToolbarFilter } from "@/components/ui/Toolbar";
import { Tooltip } from "@/components/ui/Tooltip";
import { VcrSeriesLegend, VcrTrajectoryChart } from "../VcrCharts";
import { VcrTornadoChart } from "../VcrDiagrams";
import { VcrNumber } from "../VcrNumber";
import { VcrSettingsDrawer } from "../VcrSettingsDrawer";
import { PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useStudyFrame, useVcrToolbar } from "../studyFrameContext";
import { useVcrLoad, VcrTabError } from "../vcrTabKit";
import { useVcrRun } from "../useVcrRun";
import { VcrToolbarActions, type VcrToolbarAction } from "../VcrToolbarActions";
import { VcrLongitudinalPanel, hasLongitudinal, useLongitudinal } from "../VcrLongitudinalPanel";
import { CalibrationStrip } from "../patients/CalibrationStrip";
import { DistributionGrid } from "../patients/DistributionGrid";
import { ModelRecordDrawer } from "../patients/ModelRecordDrawer";
import { PatientRecordDrawer } from "../patients/PatientRecordDrawer";
import { PatientTable } from "../patients/PatientTable";
import { baselineVariables, variableFilters, variableLabels } from "../patients/patientFilters";
import { intervalText, numberText } from "../vcrText";

/** The id the calibration strip has on the page, so the headline's number can take the reader to it. */
const CALIBRATION_ID = "vcr-calibration";

/** The model's name as the toolbar's button says it: whole where short, cut where it would crowd the row. */
const shortName = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);

/**
 * 虚拟患者: these people, who they are and what would become of them under a named model and a stated scenario — and never a claim
 * about anybody real (R19, plan §5.3; audit B §4.5).
 *
 * ```
 * [虚拟患者 | 预测验证] [分组 全部·试验·对照] [年龄 ▾] [ECOG ▾]      [模型 ›] [下载 CSV] [重新生成] [改设定]   ← the band's one row
 * 2,000 名虚拟患者 · 试验 1,000 · 对照 1,000 · 事件 1,210 · 对照组中位时间 3.9 个月（设定 4.1 ✓）
 * ┌ 两种情景下的推演 ───────────┐ ┌ 每个变量的分布，对照设定 ──────────┐
 * ┌ 患者 2,000 ─ 编号 分组 年龄 ECOG 时间 结局事件 …（排序·分页；点行 → 记录）┐
 * ┌ 设定、生成值与证据区间 ┐   哪些假设影响最大（折叠）
 * ```
 *
 * Hidden knowledge:
 *  - **The page lists people.** The table is the generated table itself, read by the server (`patients/rows`), and one patient's
 *    record is the drawer `?patient=<id>` opens. The tab used to show one example patient and no count.
 *  - **Everything above the content is the band's.** The filters, the model, the download and the rest are handed to the frame's
 *    one toolbar row (`useVcrToolbar`), so they neither scroll away nor sink under a chart; the second view (预测验证) swaps the
 *    body and keeps the same row.
 *  - **The second view exists only when there is something in it.** Follow-up history and an outside model's predictions are a
 *    feature of their own; with none of it the tab has no switch and no panel.
 *  - **Nothing here is computed.** The counts are the server's, the calibration is the server's (「设定 vs 生成 vs 证据区间」: the
 *    interval is the evidence's own and a ⚠ is a mark, not a verdict), and a distribution's ✓ is the engine's count of broken limits.
 *  - The model chip carries the model's name and opens its record — card, validation and ICH M15 assessment — in a drawer: the
 *    assessment is about the model the study uses, and it is no longer a folded table under the charts.
 *  - **A study with no patients yet is a recipe and an activity strip, and nothing else** — no panel, no assessment, no example.
 */
export function PatientsTab({ studyId, study, onStudyChanged }: { studyId: string; study: VcrStudy; onStudyChanged?: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:patients`, () => getVcrPatients(studyId));
  const longitudinal = useLongitudinal(studyId);
  const [view, setView] = useState<"patients" | "forecast">("patients");
  const forecastData = longitudinal.state.kind === "ready" && hasLongitudinal(longitudinal.state.data) ? longitudinal.state.data : null;
  const shown = forecastData && view === "forecast" ? "forecast" : "patients";
  const switcher: ToolbarChips | null = forecastData
    ? {
      kind: "chips",
      label: "视图",
      neutral: "patients",
      value: shown,
      onChange: (next) => setView(next === "forecast" ? "forecast" : "patients"),
      options: [{ value: "patients", label: "虚拟患者" }, { value: "forecast", label: "预测验证" }],
    }
    : null;

  if (shown === "forecast" && forecastData) {
    return (
      <VcrLongitudinalPanel
        studyId={studyId}
        canRun={study.abilities.includes("run")}
        data={forecastData}
        onReload={longitudinal.reload}
        switcher={switcher}
      />
    );
  }
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  return <PatientsView studyId={studyId} study={study} data={state.data} switcher={switcher} reload={reload} onStudyChanged={onStudyChanged} />;
}

function PatientsView({ studyId, study, data, switcher, reload, onStudyChanged }: {
  studyId: string;
  study: VcrStudy;
  data: PatientsData;
  switcher: ToolbarChips | null;
  reload: () => void;
  onStudyChanged?: () => void;
}) {
  const frame = useStudyFrame();
  const { run, busy } = useVcrRun(study);
  const [params, setParams] = useSearchParams();
  const [arm, setArm] = useState<string | null>(null);
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [modelOpen, setModelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const patient = params.get("patient");

  const failed = study.steps.patients?.status === "failed";
  const mayRun = study.abilities.includes("run");
  const mayWrite = study.abilities.includes("write");
  const stepStatus = study.steps.patients?.status;
  const working = stepStatus === "running" || stepStatus === "queued";
  const assessed = data.assessments.records.length > 0;
  // What the step has produced: with none of it the tab is the step's own recipe or activity and nothing more.
  const nothing = !data.model && !data.trajectories && !data.example && data.panels.length === 0 && !data.sensitivity && !data.records;
  const records = data.records;
  const arms = records?.arms ?? [];
  const labels = useMemo(() => variableLabels(data.profile), [data.profile]);
  const choices = useMemo(() => variableFilters(data.profile), [data.profile]);
  const eventsCanFilter = data.calibration?.endpoint === "time_to_event" && records !== null;

  const setColumn = useCallback((column: string, value: string | null) => {
    setColumns((current) => {
      const next = { ...current };
      if (value === null) delete next[column];
      else next[column] = value;
      return next;
    });
  }, []);
  const clearAll = useCallback(() => { setArm(null); setColumns({}); }, []);

  const openPatient = useCallback((id: string) => {
    setParams((current) => { const next = new URLSearchParams(current); next.set("patient", id); return next; }, { replace: true });
  }, [setParams]);
  const closePatient = useCallback(() => {
    setParams((current) => { const next = new URLSearchParams(current); next.delete("patient"); return next; }, { replace: true });
  }, [setParams]);

  const changed = () => { reload(); onStudyChanged?.(); };
  const download = () => {
    if (!records || downloading) return;
    setDownloading(true);
    void downloadVcrRecords(studyId, `records/${records.result}.csv`)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "记录暂时无法下载，请稍后重试。" })))
      .finally(() => setDownloading(false));
  };
  const regenerate = () => { void run(() => runVcrStep(studyId, "patients"), "这一步无法开始，请稍后重试。"); };

  // --- the band's one row ------------------------------------------------------------------------------------------------
  const filters: ToolbarFilter[] = [];
  if (switcher) filters.push(switcher);
  if (!nothing) {
    if (arms.length > 1) {
      filters.push({
        kind: "chips",
        label: "分组",
        neutral: "all",
        value: arm ?? "all",
        onChange: (next) => setArm(next === "all" ? null : next),
        options: [{ value: "all", label: "全部" }, ...arms.map((entry) => ({ value: entry.value, label: entry.label, count: entry.n }))],
      });
    }
    for (const choice of choices) {
      filters.push({
        kind: "select",
        label: choice.label,
        allLabel: "全部",
        options: choice.options,
        value: columns[choice.variable] ?? null,
        onChange: (next) => setColumn(choice.variable, next),
      });
    }
    if (eventsCanFilter) {
      filters.push({ kind: "toggle", label: "发生事件", pressed: columns.status === "1", onChange: (on) => setColumn("status", on ? "1" : null) });
    }
  }
  const actions: VcrToolbarAction[] = [];
  if (data.model || assessed) {
    actions.push({ key: "model", label: data.model ? `模型：${shortName(data.model.name)}` : "模型评估", icon: ChevronRight, quiet: true, onSelect: () => setModelOpen(true) });
  }
  if (!nothing) {
    if (records) actions.push({ key: "download", label: "下载 CSV", icon: Download, loading: downloading, onSelect: download });
    if (mayRun && !working) actions.push({ key: "regenerate", label: "重新生成", loading: busy, onSelect: regenerate });
    if (mayWrite) actions.push({ key: "settings", label: "改设定", quiet: true, onSelect: () => setSettingsOpen(true) });
  }
  const any = Object.keys(columns).length > 0 || arm !== null;
  useVcrToolbar(filters.length > 0 || actions.length > 0
    ? {
      label: "虚拟患者的筛选与操作",
      filters,
      ...(any ? { onClear: clearAll } : {}),
      ...(actions.length > 0 ? { actions: <VcrToolbarActions actions={actions} /> } : {}),
    }
    : null);

  const drawers = (
    <>
      {modelOpen && (
        <ModelRecordDrawer
          studyId={studyId}
          model={data.model}
          assessments={data.assessments}
          canEdit={study.abilities.includes("manage_study")}
          onSaved={changed}
          onClose={() => setModelOpen(false)}
        />
      )}
      {settingsOpen && (
        <VcrSettingsDrawer studyId={studyId} kind="population" title="改人群设定" onClose={() => setSettingsOpen(false)} onSaved={changed} />
      )}
    </>
  );

  if (nothing) {
    return (
      <>
        {failed
          ? <VcrStepFailed studyId={studyId} study={study} step="patients" partial={data.partial} />
          : <VcrStepPending studyId={studyId} study={study} step="patients" />}
        {drawers}
      </>
    );
  }

  // A chart is drawn only when it has a series to draw; a card whose plot is empty is a title over an empty box.
  const trajectories = data.trajectories && data.trajectories.series.length > 0 ? data.trajectories : null;
  const panels = data.panels.filter((panel) => (panel.rows?.length ?? 0) > 0 || (panel.series?.length ?? 0) > 0);
  const distributed = baselineVariables(data.profile).filter((row) => row.histogram || (row.levels && row.levels.length > 0));
  const calibration = data.calibration;
  const lead = calibration?.rows[0] ?? null;

  const headline = headlineParts({
    records,
    arms,
    eventsCanFilter,
    lead,
    generated: data.counts?.generatedRecords ?? null,
    onAll: clearAll,
    onArm: setArm,
    onEvents: () => setColumn("status", "1"),
    onCalibration: () => document.getElementById(CALIBRATION_ID)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
  });

  const gridRows: ChartGridCell[][] = [];
  const top: ChartGridCell[] = [];
  if (trajectories) {
    top.push({
      key: "trajectories",
      span: distributed.length > 0 ? 1 : 2,
      node: (
        <ChartCard title={data.headline ?? "两种情景下的推演"} legend={<VcrSeriesLegend series={trajectories.series} />}>
          <VcrTrajectoryChart series={trajectories.series} xLabels={trajectories.ticks} xLabel={trajectories.xLabel} yLabel={trajectories.yLabel} />
        </ChartCard>
      ),
    });
  }
  if (distributed.length > 0) {
    const broken = distributed.filter((row) => row.outOfBounds || (row.violations ?? 0) > 0).length;
    top.push({
      key: "distributions",
      span: trajectories ? 1 : 2,
      node: (
        <ChartCard title={broken > 0 ? `${broken} 个变量有记录越出设定的限定` : "每个变量的分布，对照设定"}>
          <DistributionGrid rows={distributed} />
        </ChartCard>
      ),
    });
  }
  if (top.length > 0) gridRows.push(top);
  if (data.example) gridRows.push([{ key: "example", span: 2, node: <ExampleCard example={data.example} /> }]);

  return (
    <>
      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="patients" partial={data.partial} />
        : data.partial && <PartialResultNote sentence={data.partial.sentence} resume={{ studyId, study, step: "patients" }} />}

      <Stale note={data.stale}>
        <div className="flex flex-col gap-6">
          {headline && <Headline parts={headline} />}

          {gridRows.length > 0 && <ChartGrid rows={gridRows} />}

          {records && (
            <PatientTable
              studyId={studyId}
              source="patients"
              result={records.result}
              title="患者"
              labels={labels}
              arm={arm}
              filters={columns}
              selected={patient}
              onOpen={openPatient}
            />
          )}

          {calibration && <CalibrationStrip calibration={calibration} id={CALIBRATION_ID} />}

          {panels.length > 0 && (
            <ChartGrid
              rows={chunk(panels, 2).map((pair) => pair.map((panel, index) => ({
                key: panel.key,
                span: pair.length === 1 ? 2 : 1,
                node: (
                  <ChartCard
                    key={`${panel.key}-${index}`}
                    title={panel.title}
                    meta={panel.note ?? undefined}
                    legend={panel.series && panel.series.length > 0 ? <VcrSeriesLegend series={panel.series} /> : undefined}
                    footnote={panel.footnote ?? undefined}
                  >
                    {panel.rows && panel.rows.length > 0 && (
                      <FactList
                        rows={panel.rows.map((row): Fact => ({
                          label: row.label,
                          value: (
                            <span data-vcr-panel-row={row.label} className="tabular-nums">
                              <VcrNumber value={row.value} label={`${panel.title} ${row.label}`} />
                              {row.value.interval && <span className="ml-2 text-caption text-text-3">{intervalText(row.value.interval, row.value.precision)}</span>}
                            </span>
                          ),
                        }))}
                      />
                    )}
                    {panel.series && panel.series.length > 0 && <VcrTrajectoryChart series={panel.series} height={150} />}
                  </ChartCard>
                ),
              })))}
            />
          )}

          {!data.model && (
            <Note
              tone="warn"
              action={frame ? <Button size="sm" variant="secondary" onClick={() => frame.openChat("换一个适用范围覆盖本人群的模型：")}>换一个模型</Button> : undefined}
            >
              {NO_MODEL_SENTENCE}
            </Note>
          )}

          {data.sensitivity && data.sensitivity.rows.length > 0 && (
            <Disclosure summary={`哪些假设影响最大${data.sensitivity.measure ? ` · ${data.sensitivity.measure}` : ""}`}>
              <VcrTornadoChart
                rows={data.sensitivity.rows}
                centre={data.sensitivity.base?.value ?? null}
                centreLabel={data.sensitivity.base ? <VcrNumber value={data.sensitivity.base} label="基准" /> : undefined}
              />
            </Disclosure>
          )}
        </div>
      </Stale>

      {patient && records && (
        <PatientRecordDrawer studyId={studyId} patientId={patient} result={records.result} labels={labels} onClose={closePatient} />
      )}
      {drawers}
    </>
  );
}

/** What stands over a result whose model the library does not hold: it can name no use the result may be carried to. */
const NO_MODEL_SENTENCE = "这些结果没有选定的模型，不能标出它可以承载的预期用途。";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * The tab's one sentence, from what the server counted: how many people, in which arms, how many had the event, and the one
 * calibration that matters first — every figure a way to what it counts (rule 7).
 */
function headlineParts({ records, arms, eventsCanFilter, lead, generated, onAll, onArm, onEvents, onCalibration }: {
  records: PatientsData["records"];
  arms: NonNullable<PatientsData["records"]>["arms"];
  eventsCanFilter: boolean;
  lead: VcrCalibrationRow | null;
  generated: number | null;
  onAll: () => void;
  onArm: (arm: string) => void;
  onEvents: () => void;
  onCalibration: () => void;
}): NotePart[] | null {
  const total = records?.rows ?? generated;
  if (total === null || total === undefined) return null;
  const parts: NotePart[] = [{ n: numberText(total, 0), onOpen: onAll, label: `${numberText(total, 0)} 名，看全部` }, records ? " 名虚拟患者" : " 条生成记录"];
  if (arms.length > 1) {
    for (const entry of arms) parts.push(" · ", `${entry.label} `, { n: numberText(entry.n, 0), onOpen: () => onArm(entry.value), label: `${entry.label} ${numberText(entry.n, 0)} 名，只看这些` });
    const events = arms.every((entry) => entry.events !== null) ? arms.reduce((sum, entry) => sum + (entry.events ?? 0), 0) : null;
    if (events !== null && eventsCanFilter) parts.push(" · 事件 ", { n: numberText(events, 0), onOpen: onEvents, label: `事件 ${numberText(events, 0)} 例，只看发生事件的` });
  }
  if (lead && lead.generated !== null) {
    const unit = lead.unit ? ` ${lead.unit}` : "";
    parts.push(` · ${lead.label} `, { n: numberText(lead.generated), onOpen: onCalibration, label: `${lead.label} ${numberText(lead.generated)}，看设定与证据区间` });
    parts.push(`${unit}`);
    if (lead.declared !== null) parts.push(`（设定 ${numberText(lead.declared)}${lead.status === "within" ? " ✓" : lead.status === "outside" ? " ⚠" : ""}）`);
  }
  return parts;
}

/** The engine's own example patient: who they are, their baseline, and the same random numbers under the two assumptions. */
function ExampleCard({ example }: { example: NonNullable<PatientsData["example"]> }) {
  const scenarios = example.scenarios && example.scenarios.series.length > 0 ? example.scenarios : null;
  const facts: Fact[] = example.baseline.map((row) => ({ label: row.label, value: row.value }));
  return (
    <ChartCard
      title={(
        <Tooltip content={[example.record.id, example.record.origin].filter(Boolean).join(" · ")}>
          <span data-vcr-example="">{example.title}</span>
        </Tooltip>
      )}
      meta={scenarios?.difference ?? undefined}
      legend={scenarios ? (
        <>
          <VcrSeriesLegend series={scenarios.series} />
          {/* What the individual lines are, said where they are drawn: one person's trajectories under each assumption are model output. */}
          <span data-vcr-legend-individual="" className="inline-flex items-center"><Tag>个体（模拟）</Tag></span>
        </>
      ) : undefined}
    >
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          {facts.length > 0 && <FactList rows={facts} />}
          {example.inScope && (
            <p className={`inline-flex items-center gap-1.5 text-ui ${example.inScope.ok ? "text-ok" : "text-warn-strong"}`}>
              {example.inScope.ok ? <CircleCheck size={16} aria-hidden="true" /> : <CircleDashed size={16} aria-hidden="true" />}
              {example.inScope.text}
            </p>
          )}
        </div>
        {scenarios && <div data-vcr-scenarios=""><VcrTrajectoryChart series={scenarios.series} height={160} /></div>}
      </div>
    </ChartCard>
  );
}
