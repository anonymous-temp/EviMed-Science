import { Fragment, createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  cancelVcrLabCampaign, getVcrLabExperiment, listVcrLabExperiments,
  type VcrCampaignCandidate, type VcrCampaignView, type VcrConstraintVerdict, type VcrDesignExperimentView, type VcrLabEntry, type VcrRobustRow, type VcrRobustView,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { Tag, type TagTone } from "@/components/ui/Tag";
import type { ToolbarChips, ToolbarSelect } from "@/components/ui/Toolbar";
import { EmptyState } from "@/components/cards/EmptyState";
import { DRAFT_PREFIX } from "./vcrActionWords";
import { useStudyFrame, useVcrToolbar } from "./studyFrameContext";
import { VcrPremises } from "./VcrPremises";
import { VcrValueText } from "./VcrNumber";
import { VcrToolbarActions, type VcrToolbarAction } from "./VcrToolbarActions";
import { VcrTabError, useVcrLoad } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";
import { methodFieldText } from "./vcrMethodFieldText";
import { fieldLabel, hasFieldLabel } from "./vcrScenarioFieldLabels";
import { mcseText, numberText, valueText } from "./vcrText";

/**
 * 虚拟实验室 — the result surface of the lab inside a study (plan T09/T10, A07 A08 A09 A18).
 *
 * Two kinds of object live here and the page shows one at a time: a design search (a campaign: many candidate designs, a
 * screening pass and a re-check of the finalists) and a design comparison (an experiment: named arms on one frozen endpoint). The
 * object is picked in a select; its question is the heading.
 *
 * Hidden knowledge:
 *  - **Starting is the conversation's.** There is no form here: the empty state offers examples that fill the composer and send
 *    nothing, and the toolbar's only action is stopping a search that is running.
 *  - **The page says which pass a number is from.** “初筛” (few repetitions, only to rank and to set aside what clearly fails) and
 *    “复核” (the method's own repetitions, on a fresh batch of simulation) are told apart in the table and in the premises block, with one
 *    word each everywhere, because a coarse number can never make a candidate “satisfy” a constraint: only the re-check judges, and a
 *    value close to the limit reads “无法确定”, not a pass.
 *  - **Nothing is computed here.** Objective values, bounds and verdicts, the stop reason and the budget are the server's; the page
 *    only words them. The budget line carries queue time beside compute time, so a slow search is told apart from a heavy one.
 *  - **A running search is read again every few seconds** and stops being read when it stops; stopping keeps every finished candidate.
 *  - Candidates are paged twenty at a time; an experiment has few arms and is drawn whole.
 */
const PAGE = 20;
const POLL_MS = 5000;

const CANDIDATE_TONE: Record<string, TagTone> = { finalist: "accent", evaluated: "neutral", eliminated: "neutral", failed: "warn", unsupported: "warn", screened: "neutral", pending: "neutral" };
const ARM_STATUS: Record<string, string> = { complete: "已有结果", running: "计算中", failed: "没算成", unsupported: "无法计算", incomplete: "还没有结果" };
const STAGE_TEXT = { screening: "初筛", final: "复核" } as const;

export const VCR_LAB_EXAMPLES: ReadonlyArray<{ key: string; label: string; draft: string }> = [
  { key: "compare", label: "比较三个样本量方案", draft: "比较三个样本量方案：每组 100、150、200 人，同一终点、同一检验水准，给出每个方案的把握度和差值。" },
  { key: "search", label: "在预算内搜索样本量", draft: "在样本量 100 到 300 之间搜索满足把握度不低于 80%、第一类错误不超过 2.5% 的最小方案，计算预算 10 分钟。" },
  { key: "alzheimer", label: "比较三种药物效果假设", draft: "在轻中度阿尔茨海默病（ADAS-cog 11）的试验里比较三种药物效果假设：不用药、第 24 周症状改善 2.5 分、病情恶化减慢 30%，每组 200 人、观察 78 周，给出每种假设下的把握度和平均差值。" },
];

const op = (value: string) => (value === "<=" ? "不超过" : "不低于");

/** The bound of a constraint as it reads beside the judged value: a proportion judged in % is worded in %. */
function boundText(bound: number, judged: VcrConstraintVerdict["judgedAt"]): string {
  return judged?.unit === "%" ? `${numberText(bound * 100)}%` : numberText(bound);
}

/** A value of a candidate's setting as a person reads it: a number or word, a list as its items, never a raw object. */
function scalarText(value: unknown): string {
  if (Array.isArray(value)) return value.map(scalarText).join("、");
  if (value && typeof value === "object") return "";
  return typeof value === "number" ? numberText(value) : String(value);
}

/**
 * The direction of the best design against the reference. `improvement` is sign × (best − reference) with the sign of the objective, so it is
 * negative when the best feasible design is worse than the reference (an infeasible reference often is): the word follows the value.
 */
function improvementWord(direction: string, improvement: number): string {
  const minimize = direction === "min" || direction === "minimize";
  const better = improvement >= 0;
  return minimize === better ? "比参照方案少 " : "比参照方案多 ";
}

/** A varied path's name: the method's own words, then the shared field vocabulary, and only then the generic 「参数」. */
function candidatePathLabel(method: string, path: string): string {
  const own = methodFieldText(method, path, {}, {}, "").label;
  if (own) return own;
  const key = path.split(".").at(-1)?.replace(/\[\d*\]$/, "") ?? "";
  return hasFieldLabel(key) ? fieldLabel(key) : "参数";
}

/** What a candidate is, in the words of the method's own fields (never the raw path). */
function setText(method: string, set: Record<string, unknown>): string {
  const entries = Object.entries(set);
  if (!entries.length) return "";
  return entries.map(([path, value]) => `${candidatePathLabel(method, path)} ${scalarText(value)}`).join("，");
}

/** A candidate's constraints, one line each: the limit, the verdict and the conservative bound it was judged on. */
function ConstraintLines({ candidate }: { candidate: VcrCampaignCandidate }) {
  return (
    <ul className="flex flex-col gap-1">
      {candidate.constraints.map((constraint) => {
        const verdict = constraint.final ?? constraint.screening;
        if (!verdict) return <li key={constraint.index} className="text-caption text-text-3">{constraint.label}：还没判断</li>;
        const stage = verdict.final ? "复核" : "初筛";
        // a verdict rested on the test's own level says so; the worst-case wording is only for what was judged on a bound
        const nominal = verdict.boundKind === "nominal_level";
        return (
          <li key={constraint.index} data-vcr-constraint-status={verdict.status} className="text-ui text-text">
            {constraint.label}{op(constraint.op)} {boundText(constraint.bound, verdict.judgedAt)}：
            <span className={verdict.status === "pass" ? "text-text" : "text-text-2"}>{verdict.statusText ?? verdict.status}</span>
            {(nominal || verdict.judgedAt) && <span className="text-caption text-text-3">{nominal ? "（按检验的名义水准，模拟没有否定它）"
              : `（${stage}时最不利情况下的值 ${valueText(verdict.judgedAt!)}${verdict.judgedAt!.unit && verdict.judgedAt!.unit !== "%" ? ` ${verdict.judgedAt!.unit}` : ""}）`}</span>}
          </li>
        );
      })}
    </ul>
  );
}

const mcseSuffix = (value: { mcse?: number | null }) => (value.mcse ? ` ${mcseText(value.mcse)}` : "");
const seconds = (value: number | undefined) => `${numberText(Math.round(value ?? 0))} 秒`;

function CampaignView({ studyId, view, reload }: { studyId: string; view: VcrCampaignView; reload: () => void }) {
  const [offset, setOffset] = useState(0);
  const [only, setOnly] = useState<"all" | "finalists" | "set-aside">("all");
  const finalists = new Set(view.finalists);
  const rows = useMemo(() => view.candidates.filter((candidate) => only === "all" || (only === "finalists" ? finalists.has(candidate.key) : candidate.status === "eliminated" || candidate.status === "failed" || candidate.status === "unsupported")), [view, only]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = rows.slice(offset, offset + PAGE);
  const used = view.budget.used;
  const evaluated = Number(used.candidatesEvaluated ?? 0);
  const planned = Number(used.candidatesPlanned ?? view.candidates.length);
  const running = view.status === "running";
  const best = view.candidates.find((candidate) => candidate.key === view.best) ?? null;

  const statusChips: ToolbarChips = { kind: "chips", label: "方案", value: only, neutral: "all",
    onChange: (value) => { setOnly(value as typeof only); setOffset(0); },
    options: [{ value: "all", label: "全部", count: view.candidates.length }, { value: "finalists", label: "入围复核", count: view.finalists.length }, { value: "set-aside", label: "已排除或失败" }] };
  useLabToolbar(studyId, view, reload, [statusChips]);

  const columns: Array<DataColumn<VcrCampaignCandidate>> = [
    { key: "candidate", header: "方案", rowHeader: true, cell: (candidate) => (
      <span>
        <span className="tabular-nums">#{candidate.index + 1}</span>
        {candidate.key === view.best && !view.robust && <> <Tag tone="accent">在这些假设下最省</Tag></>}
        {view.robust?.rows.find((row) => row.key === candidate.key)?.tags.map((tag) => <Fragment key={tag}> <Tag tone={tag === "cheapest_acceptable" ? "accent" : "neutral"}>{view.robust!.tagText[tag] ?? tag}</Tag></Fragment>)}
        {candidate.key === view.reference && <> <Tag>参照</Tag></>}
        <span className="block text-caption text-text-3">{setText(view.method, candidate.set)}</span>
      </span>
    ) },
    { key: "objective", header: view.objective.label, align: "right", cell: (candidate) => {
      const value = candidate.objective.final ?? candidate.objective.screening;
      return value ? <span><VcrValueText value={value} />{!candidate.objective.final && <span className="text-caption text-text-3">（初筛）</span>}</span> : "—";
    }, isEmpty: (candidate) => !candidate.objective.final && !candidate.objective.screening },
    { key: "constraints", header: "约束", cell: (candidate) => <ConstraintLines candidate={candidate} /> },
    { key: "status", header: "状态", cell: (candidate) => <Tag tone={CANDIDATE_TONE[candidate.status] ?? "neutral"}>{candidate.statusText}</Tag> },
    { key: "reason", header: "原因", cell: (candidate) => candidate.reasonText, isEmpty: (candidate) => !candidate.reasonText },
  ];

  const facts: Fact[] = [
    { label: "已用计算", value: `${seconds(used.cpuSeconds)}（排队等待另计 ${seconds(used.queueSeconds)}）；上限 ${seconds(view.budget.declared.cpuSeconds)}` },
    { label: "已评估方案", value: `${numberText(evaluated)} / ${numberText(planned)} 个；总模拟 ${numberText(Math.round(used.replicates ?? 0))} 次` },
    ...(view.stop ? [{ label: "为什么停止", value: view.stop.text ?? "已停止。" }] : []),
    ...(running ? [{ label: "现在", value: view.cancelRequested ? "已要求停止，当前这一步算完后结束，已完成的方案保留。" : view.inFlight ? `正在计算${view.inFlight.stage ? STAGE_TEXT[view.inFlight.stage as keyof typeof STAGE_TEXT] ?? "" : ""}这一步，结果出来前不会显示数字。` : "排队等待计算。" }] : []),
  ];

  return (
    <section className="flex flex-col gap-6" aria-label="设计搜索" data-vcr-lab-kind="campaign">
      <div className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold text-text">{view.question || "设计搜索"}</h2>
        <Note result={["已评估 ", { n: evaluated }, ` / ${planned} 个方案，`, { n: view.finalists.length, onOpen: view.finalists.length ? () => { setOnly("finalists"); setOffset(0); } : undefined, label: `${view.finalists.length} 个入围复核，只看这些` }, " 个入围复核。",
          ...(view.robust ? [view.robust.statement]
            : best ? [`在这些假设下，满足约束且最省的是 #${best.index + 1}${best.objective.final ? `，${view.objective.label} ${valueText(best.objective.final)}` : ""}。`]
            : view.undecided?.closest ? [`没有方案确认满足全部约束；最接近的是 #${view.undecided.closest.index + 1}${view.undecided.closest.objective ? `，${view.objective.label} ${valueText(view.undecided.closest.objective)}` : ""}，还有 ${view.undecided.closest.constraints.length} 个约束无法确定。`] : [])]} />
        {view.againstReference?.difference
          ? <Note result={["与参照方案比，差值 ", { n: `${valueText(view.againstReference.difference)}${mcseSuffix(view.againstReference.difference)}` }, view.againstReference.couplingText ? `；${view.againstReference.couplingText}。` : "。"]} />
          : view.improvement != null && view.reference && <Note result={[improvementWord(view.objective.direction, view.improvement), { n: `${numberText(Math.abs(view.improvement))}${(best?.objective.final ?? best?.objective.screening)?.unit ?? ""}` }, `（${view.objective.label}）。`]} />}
      </div>

      <FactList rows={facts} />
      <VcrPremises premises={view.premises} />

      {view.robust && <RobustSection robust={view.robust} />}

      <Section title="参与比较的方案" level="sub" count={rows.length}>
        <div className="flex flex-col gap-3">
          <DataTable label="设计搜索比较的方案" rows={page} rowKey={(candidate) => candidate.key} columns={columns} emptyText="没有符合条件的方案。"
            footnote={rows.length ? `第 ${offset + 1}–${offset + page.length} 个，共 ${rows.length} 个。` : undefined} />
          {rows.length > PAGE && (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
              <Button variant="secondary" size="sm" disabled={offset + PAGE >= rows.length} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
            </div>
          )}
        </div>
      </Section>

      {view.inconclusive.length > 0 && (
        <Disclosure summary={`${view.inconclusive.length} 个方案无法确定是否满足约束`}>
          <FactList rows={[{ label: "方案", value: view.inconclusive.map((key) => `#${(view.candidates.find((candidate) => candidate.key === key)?.index ?? 0) + 1}`).join("、") },
            { label: "怎么办", value: view.undecided?.advice.length ? view.undecided.advice.join("") : "这些方案离限值太近，现有的复核次数下结论不了；在判断出来之前既不算通过，也不算不满足。" }]} />
        </Disclosure>
      )}
    </section>
  );
}

const pct = (value: { value?: number | null; text?: string | null; unit?: string | null; mcse?: number | null; precision?: number | null } | null | undefined) =>
  (value ? <VcrValueText value={value as never} /> : <>—</>);

/**
 * 稳健性比较 (plan R34): every finalist in every scenario of the search, side by side. No row is called the best: the page shows the
 * worst-case power, the largest regret, the Pareto and near-optimal sets, and the cheapest design that stays acceptable in every scenario
 * beside the cheapest under the base case, then the rule the sets were drawn by and each design's operating characteristics per scenario.
 */
function RobustSection({ robust }: { robust: VcrRobustView }) {
  const names = robust.scenarios.map((scenario) => scenario.name);
  const columns: Array<DataColumn<VcrRobustRow>> = [
    { key: "design", header: "方案", rowHeader: true, cell: (row) => (
      <span>
        <span className="tabular-nums">#{row.index + 1}</span>
        {row.tags.map((tag) => <Fragment key={tag}> <Tag tone={tag === "cheapest_acceptable" ? "accent" : "neutral"}>{robust.tagText[tag] ?? tag}</Tag></Fragment>)}
        {!row.eligible && row.complete && <span className="block text-caption text-text-3">{row.referenceOnly ? "仅作对照" : row.guardText}</span>}
      </span>
    ) },
    ...names.map((name) => ({ key: `power:${name}`, header: `“${name}”下的功效`, align: "right" as const, cell: (row: VcrRobustRow) => {
      const power = row.scenarios.find((scenario) => scenario.name === name)?.power;
      return power ? <span>{pct(power)}<span className="block text-caption text-text-3">{power.statusText}</span></span> : "—";
    }, isEmpty: (row: VcrRobustRow) => !row.scenarios.find((scenario) => scenario.name === name)?.power })),
    { key: "worst", header: "最差情形功效", align: "right", cell: (row) => (row.worstCase ? <span>{pct(row.worstCase)}<span className="block text-caption text-text-3">在“{row.worstCase.scenario}”下</span></span> : "—"), isEmpty: (row) => !row.worstCase },
    { key: "regret", header: "最大遗憾", align: "right", cell: (row) => (row.maxRegret ? <span>{pct(row.maxRegret)}<span className="block text-caption text-text-3">在“{row.maxRegret.scenario}”下</span></span> : "—"), isEmpty: (row) => !row.maxRegret },
    ...(robust.weighted ? [{ key: "expected", header: "按权重平均的功效", align: "right" as const, cell: (row: VcrRobustRow) => pct(row.expectedPower), isEmpty: (row: VcrRobustRow) => !row.expectedPower }] : []),
    { key: "n", header: "样本量", align: "right", cell: (row) => pct(row.n), isEmpty: (row) => !row.n },
    ...(robust.criteria.some((criterion) => criterion.name === "duration") ? [{ key: "duration", header: "研究时长", align: "right" as const, cell: (row: VcrRobustRow) => pct(row.duration), isEmpty: (row: VcrRobustRow) => !row.duration }] : []),
    { key: "ok", header: `各假设下是否达到 ${numberText(robust.floor * 100)}%`, cell: (row) => row.acceptableText, isEmpty: (row) => !row.acceptableText },
  ];
  const ocRows = robust.rows.flatMap((row) => row.scenarios.map((scenario) => ({ id: `${row.key}:${scenario.name}`, index: row.index, scenario, compared: scenario.compared })));
  const cheap = (entry: VcrRobustView["cheapestAcceptable"]) => (entry ? `#${entry.index + 1}${entry.n ? `，样本量 ${valueText(entry.n)}` : ""}` : "没有");
  return (
    <Section title="稳健性比较" level="sub" count={robust.rows.length}>
      <div className="flex flex-col gap-3" data-vcr-robust>
        <FactList rows={[
          { label: "各假设下都达标的最省方案", value: cheap(robust.cheapestAcceptable) },
          { label: "只看基准情形的最省方案", value: robust.sameDesign === true ? `${cheap(robust.cheapestUnderBase)}（与上一个是同一个方案）` : cheap(robust.cheapestUnderBase) },
        ]} />
        <DataTable label="每个方案在各假设下的结果" rows={robust.rows} rowKey={(row) => row.key} columns={columns} emptyText="没有方案完成了全部假设的复核。" />
        <Disclosure summary="各假设下的运行特征（每个数都带模拟误差）">
          <DataTable label="各方案在各假设下的运行特征" rows={ocRows} rowKey={(row) => row.id} columns={[
            { key: "design", header: "方案", rowHeader: true, cell: (row) => `#${row.index + 1}` },
            { key: "scenario", header: "假设", cell: (row) => `“${row.scenario.name}”${row.compared ? "" : "（只用于判断错误率）"}` },
            { key: "power", header: "功效", align: "right", cell: (row) => pct(row.scenario.power), isEmpty: (row) => !row.scenario.power },
            { key: "rest", header: "其他", cell: (row) => <ul className="flex flex-col gap-1">{row.scenario.oc.map((oc) => <li key={oc.measure} className="text-ui text-text">{oc.label} <VcrValueText value={oc as never} /></li>)}</ul>, isEmpty: (row) => !row.scenario.oc.length },
          ]} />
        </Disclosure>
        <Disclosure summary="这些集合是怎么划出来的">
          <p className="text-ui text-text-2">{robust.choiceRule}</p>
        </Disclosure>
      </div>
    </Section>
  );
}

function ExperimentView({ studyId, view, reload }: { studyId: string; view: VcrDesignExperimentView; reload: () => void }) {
  useLabToolbar(studyId, view, reload, []);
  // the calculated mean course of the treated group of each disease arm by visit, with the untreated course the first arm shows beside them
  const withCourse = view.arms.filter((arm) => arm.trajectory?.length);
  const course = (withCourse[0]?.trajectory ?? []).map((point, index) => ({
    visit: point.visit, none: point.control,
    values: Object.fromEntries(withCourse.map((arm) => [arm.name, arm.trajectory?.[index]?.treated ?? null])) as Record<string, number | null>,
  }));
  return (
    <section className="flex flex-col gap-6" aria-label="设计比较" data-vcr-lab-kind="experiment">
      <div className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold text-text">{view.question || "设计比较"}</h2>
        <Note result={["比较 ", { n: view.arms.length }, ` 个组，${view.arms.filter((arm) => arm.status === "complete").length} 个已有结果。`]} />
      </div>
      <VcrPremises premises={view.premises} />
      {view.comparison.map((measure) => (
        <Section key={measure.measure} title={measure.label} level="sub">
          <DataTable label={`各组的${measure.label}`} rows={measure.arms} rowKey={(arm) => arm.name}
            columns={[
              { key: "arm", header: "组", rowHeader: true, cell: (arm) => arm.name },
              { key: "status", header: "状态", cell: (arm) => ARM_STATUS[arm.status] ?? arm.status },
              { key: "value", header: "结果", align: "right", cell: (arm) => arm.value ? <VcrValueText value={arm.value} /> : "—", isEmpty: (arm) => !arm.value },
              { key: "precision", header: "精度", cell: (arm) => arm.precision === "screening" ? "初筛（只用于排序）" : "完整", isEmpty: (arm) => !arm.value },
              { key: "contrast", header: measure.contrasts[0] ? `与“${measure.contrasts[0].against}”的差值` : "差值", align: "right", cell: (arm) => {
                const contrast = measure.contrasts.find((entry) => entry.arm === arm.name);
                // a preliminary (screening) result an arm attached is never differenced against the reference as if it were a result
                if (arm.precision === "screening" && contrast) return "初筛结果不参与比较";
                return contrast ? (contrast.difference ? <span><VcrValueText value={contrast.difference} /><span className="block text-caption text-text-3">{contrast.couplingText}</span></span> : contrast.couplingText) : "—";
              }, isEmpty: () => measure.contrasts.length === 0 },
            ]} />
        </Section>
      ))}
      {course.length > 0 && (
        <Section title="平均病程" level="sub">
          <DataTable label="各组的平均病程（ADAS-cog 分，典型研究）" rows={course} rowKey={(row) => String(row.visit)} columns={[
            { key: "visit", header: "第几周", rowHeader: true, cell: (row) => row.visit },
            { key: "none", header: "不用药", align: "right", cell: (row) => (row.none === null ? "—" : row.none.toFixed(1)) },
            ...view.arms.filter((arm) => arm.trajectory).map((arm) => ({ key: arm.name, header: arm.name, align: "right" as const,
              cell: (row: { values: Record<string, number | null> }) => (row.values[arm.name] == null ? "—" : row.values[arm.name]!.toFixed(1)) })),
          ]} />
        </Section>
      )}
      <Disclosure summary="各组的设置">
        <DataTable label="各组" rows={view.arms} rowKey={(arm) => arm.name} columns={[
          { key: "name", header: "组", rowHeader: true, cell: (arm) => arm.name },
          { key: "hypothesis", header: "药物效果假设", cell: (arm) => arm.hypothesis?.text, isEmpty: (arm) => !arm.hypothesis },
          { key: "source", header: "来源", cell: (arm) => (arm.attached ? "已保存的结果，没有重算" : "按设定计算") },
          { key: "state", header: "状态", cell: (arm) => ARM_STATUS[arm.status] ?? arm.status },
          { key: "refused", header: "无法计算的原因", cell: (arm) => arm.refused?.join("；"), isEmpty: (arm) => !arm.refused?.length },
        ]} />
      </Disclosure>
    </section>
  );
}

/** One row in the band: the lab's switch and the object's filters, and 「停止搜索」 while a search runs. */
function useLabToolbar(studyId: string, view: VcrCampaignView | VcrDesignExperimentView, reload: () => void, filters: ToolbarChips[]) {
  const lead = useLabSwitcher();
  const { objectSelect } = useContext(LabContext);
  const { canRun } = useContext(LabContext);
  const [stopping, setStopping] = useState(false);
  const running = view.kind === "campaign" && view.status === "running" && !view.cancelRequested && canRun;
  const actions: VcrToolbarAction[] = running ? [{ key: "stop", label: "停止搜索", loading: stopping, onSelect: () => {
    setStopping(true);
    cancelVcrLabCampaign(studyId, view.id).then(() => { toast.success("已要求停止，已完成的方案会保留。"); reload(); },
      (error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法停止，请稍后重试。" }))).finally(() => setStopping(false));
  } }] : [];
  useVcrToolbar({ label: "虚拟实验室的筛选与操作", filters: [...(lead ? [lead] : []), ...(objectSelect ? [objectSelect] : []), ...filters],
    ...(actions.length ? { actions: <VcrToolbarActions actions={actions} /> } : {}) });
}

const LabContext = createContext<{ switcher: ToolbarChips | null; objectSelect: ToolbarSelect | null; canRun: boolean }>({ switcher: null, objectSelect: null, canRun: false });
const useLabSwitcher = () => useContext(LabContext).switcher;

export function VirtualLabWorkspace({ studyId, canRun = true, switcher = null }: { studyId: string; canRun?: boolean; switcher?: ToolbarChips | null }) {
  const list = useVcrLoad(`${studyId}:lab:list`, () => listVcrLabExperiments(studyId));
  const [chosen, setChosen] = useState("");
  const entries: VcrLabEntry[] = list.last?.experiments ?? [];
  const selected = entries.find((entry) => entry.id === chosen) ?? entries[0];
  const detail = useVcrLoad(`${studyId}:lab:${selected?.id ?? "none"}`, () => (selected ? getVcrLabExperiment(studyId, selected.id) : Promise.resolve(null)));
  const view = detail.state.kind === "ready" ? detail.state.data : null;
  const running = view?.status === "running";
  const { reload } = detail;
  const reloadList = list.reload;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { reload(); reloadList(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload, reloadList]);

  // Which experiment or search the page is about is a choice of object, so it sits in the band with the other filters.
  const objectSelect: ToolbarSelect | null = entries.length > 1 ? { kind: "select", label: "实验", value: selected?.id ?? null, onChange: (value) => { if (value) setChosen(value); },
    options: entries.map((entry) => ({ value: entry.id, label: `${entry.kind === "campaign" ? "设计搜索" : "设计比较"}：${entry.question.slice(0, 40) || "未命名"}` })) } : null;

  let body;
  // While there is no object to draw (loading, an error) the band still carries the lab's switch, so the reader can go back.
  if (list.state.kind === "loading") body = <><SwitcherOnly /><VcrTabSkeleton /></>;
  else if (list.state.kind === "error") body = <><SwitcherOnly /><VcrTabError message={list.state.message} onRetry={list.reload} /></>;
  else if (!selected) body = <LabEmpty studyId={studyId} canRun={canRun} />;
  else if (detail.state.kind === "loading") body = <><SwitcherOnly /><VcrTabSkeleton /></>;
  else if (detail.state.kind === "error") body = <><SwitcherOnly /><VcrTabError message={detail.state.message} onRetry={detail.reload} /></>;
  else if (view?.kind === "campaign") body = <CampaignView studyId={studyId} view={view} reload={() => { detail.reload(); list.reload(); }} />;
  else if (view) body = <ExperimentView studyId={studyId} view={view} reload={() => { detail.reload(); list.reload(); }} />;
  else body = <><SwitcherOnly /><VcrTabSkeleton /></>;

  return (
    <LabContext.Provider value={{ switcher, objectSelect, canRun }}>
      <div className="flex flex-col gap-6">
        {body}
      </div>
    </LabContext.Provider>
  );
}

function SwitcherOnly() {
  const lead = useLabSwitcher();
  const { objectSelect } = useContext(LabContext);
  useVcrToolbar(lead ? { label: "虚拟实验室的筛选与操作", filters: [lead, ...(objectSelect ? [objectSelect] : [])] } : null);
  return null;
}

function LabEmpty({ studyId, canRun }: { studyId: string; canRun: boolean }) {
  const frame = useStudyFrame();
  return (
    <>
    <SwitcherOnly />
    <EmptyState
      title="还没有虚拟实验"
      description="在对话里说出要比较的试验设计，或给出一个搜索范围和限制条件；每个方案的结果、满足约束的情况和用掉的计算会列在这里。"
      action={canRun && frame ? (
        <div className="flex flex-wrap gap-2">
          {VCR_LAB_EXAMPLES.map((example) => (
            <Button key={example.key} variant="secondary" actionKind="draft" onClick={() => frame.openChat(example.draft, { kind: "step", studyId, objectId: "trial" })}>{`${DRAFT_PREFIX}${example.label}`}</Button>
          ))}
        </div>
      ) : undefined}
      reason={canRun ? undefined : "有运行权限的成员可以在对话里开始。"}
    />
    </>
  );
}
