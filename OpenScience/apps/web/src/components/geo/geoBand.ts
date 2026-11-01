/**
 * What the fixed band above every GEO tab says, decided before anything is drawn (R19, audit C A.1–A.2): the eight steps as one row
 * and the one sentence at its end. The tabs below it are drawn by the layout; this is only the words and the states.
 */
import { agendaLocalDate, DISPLAY_TIME_ZONE, geoAutomationEnabled, geoWorkflowState, workStateLabel } from "@evimed/domain";
import { GEO_STEP_KEYS, type GeoMeasurement, type GeoProject, type GeoStepKey } from "@/lib/geoClient";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import type { RailState } from "@/components/ui/ProgressRail";
import type { WorkState } from "@/lib/workState";
import type { StepRailStep } from "@/components/ui/StepRail";
import { engineName, GEO_STEP_NAMES, GEO_STEP_WORK, monthDay, parseGeoDate, zh } from "./geoText";
import { GEO_MARKET_OFF_NOTE, marketConnected } from "./geoOverviewModel";

/** The steps as the project's overview copy has them; an empty copy says nothing rather than that nothing has been done. */
function stepsOf(project: GeoProject): GeoProject["steps"] {
  const overview = project.overview?.steps ?? {};
  return Object.keys(overview).length > 0 ? overview : project.steps;
}

/** A step's own short note, when the server wrote one worth printing (≤ 12 characters). */
function shortNote(note: string | null | undefined): string | null {
  const text = (note ?? "").trim();
  return text && text.length <= 12 ? text : null;
}

/**
 * Where one step stands, in the platform's one vocabulary (`@evimed/domain` `workState.mjs`), and it is the list's, the preview's and
 * the rail's all three. A step outside the work that was asked for has no state at all, and says nothing but its name: eight 「未请求」
 * in a row told the reader nothing, and were wrong for the dependency that was about to run.
 *
 * `waiting` is the person's: the placement budget, a step the allowance would not start, automatic monitoring that was asked for and
 * never agreed to, and a scope an old project still has to confirm.
 */
export function geoStepView(project: Pick<GeoProject, "steps"> & Partial<Pick<GeoProject, "budget" | "overview" | "engines" | "coverageDays" | "market">>, key: GeoStepKey): { work: WorkState | null; state: RailState; word: string; waitingFor: string | null } {
  const steps = stepsOf(project as GeoProject);
  const step = steps[key];
  const workflow = geoWorkflowState(steps);
  const status = step?.status ?? "none";
  const working = status === "running" || status === "queued";
  const asked = step?.requested === true && step.requestOrigin !== "legacy";
  // Placing is the reader's money only once placing was asked for or is moving: a step nobody asked for owes neither budget nor market.
  const placing = key === "distribution" && status !== "done" && status !== "minimal" && (asked || working || status === "failed");
  const owesBudget = placing && "budget" in project && marketConnected(project as GeoProject) && !(project.budget && project.budget.totalCny > 0);
  // A person who said no (「暂不启动」) has answered: waiting on them for it would ask the same question for ever.
  const declined = key === "monitoring" && step?.automation?.state === "declined";
  const owesConsent = key === "monitoring" && asked && status === "none" && !declined && "engines" in project && !geoAutomationEnabled(project);
  const legacy = status === "none" && step?.requested === true && step.requestOrigin === "legacy";
  const waitingFor = owesBudget ? "设预算" : stepAllowanceWait(step) ? "补额度" : owesConsent ? "开启自动监测" : legacy ? "确认范围" : null;
  // Without a market a placing that was asked for cannot move, whatever its record says.
  const heldByMarket = placing && "budget" in project && !marketConnected(project as GeoProject);
  const work: WorkState | null = waitingFor ? "waiting"
    : status === "failed" ? "failed"
      : status === "done" ? "done"
        : status === "minimal" ? "minimal"
          : heldByMarket ? "todo"
            : status === "running" ? "running"
              : status === "queued" ? "queued"
                : declined && status === "none" ? null
                  : workflow.steps[key]?.required ? "todo" : null;
  const state: RailState = work === "waiting" ? "waiting" : work === "failed" ? "attention" : work === "done" ? "done" : work === "minimal" ? "partial" : work === "running" || work === "queued" ? "active" : "todo";
  return { work, state, word: workStateLabel(work, waitingFor), waitingFor };
}

/**
 * The eight steps for the rail. `summary` is what the step produced — the server's own count (「86 条结论」), else its short note; it is
 * the tooltip and never a second line.
 */
export function bandSteps(project: GeoProject, hrefOf: (step: GeoStepKey) => string): StepRailStep[] {
  const steps = stepsOf(project);
  const market = marketConnected(project);
  return GEO_STEP_KEYS.map((key) => {
    const step = steps[key];
    const view = geoStepView(project, key);
    // Without a market there is nothing to owe: the step's tooltip says it waits for the market, and nothing on the page asks for a budget.
    const held = key === "distribution" && view.work === "todo" && !market && (step?.requested === true || step?.status === "running" || step?.status === "queued");
    const summary = view.waitingFor === "设预算" ? "待你确认预算" : held ? GEO_MARKET_OFF_NOTE : step?.summary?.text ?? shortNote(step?.note);
    return { id: key, label: GEO_STEP_NAMES[key], state: view.state, stateLabel: view.word, outside: view.work === null, summary, href: hrefOf(key) };
  });
}

/** 「周一」「周二」… for a day in the reader's calendar. */
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * What the measurement's own state says, in the reader's words, or null while every engine of the project is measured as usual
 * (and from an older server, which says nothing). `paused`: no engine can be asked. `short` is the band's few words, `detail` what
 * happens next, `sentence` the two as one line. Nothing here names a code or the measuring host.
 */
export interface MeasurementPause {
  paused: boolean;
  short: string;
  detail: string;
  sentence: string;
}

export function measurementPause(measurement: GeoMeasurement | null | undefined): MeasurementPause | null {
  if (!measurement || typeof measurement !== "object") return null;
  if (measurement.state === "paused") {
    const day = monthDay(measurement.since ?? null);
    const short = `AI 回答测量暂停中${day ? `（${day}起）` : ""}`;
    const detail = "测量服务暂时不可用，产品依据和已有结果仍可查看";
    return { paused: true, short, detail, sentence: `${short}：${detail}。` };
  }
  const engines = Array.isArray(measurement.engines)
    ? measurement.engines.filter((engine, at, all): engine is string => typeof engine === "string" && !!engine && all.indexOf(engine) === at)
    : [];
  if (engines.length === 0) return null;
  const short = zh`${engines.map((engine) => engineName(engine)).join("、")}暂停测量`;
  const detail = "这些引擎暂时不可用；是否有测量任务以当前工作记录为准";
  return { paused: false, short, detail, sentence: `${short}，${detail}。` };
}

/**
 * The next full measurement as the page may say it: none for a project its owner paused, none while the measurement itself is
 * paused — the server says the same, and the page does not promise a round on an older server's word.
 */
export function nextMeasurement(
  project: Pick<GeoProject, "status"> & Partial<Pick<GeoProject, "steps" | "engines" | "coverageDays">>,
  watch: { next?: { date: string; kind: string; source?: "queued" | "schedule" } | null; measurement?: GeoMeasurement | null } | null | undefined,
): { date: string; kind: string } | null {
  if ((!geoAutomationEnabled(project) && watch?.next?.source !== "queued") || !watch?.next?.date || project.status === "paused" || watch.measurement?.state === "paused") return null;
  return watch.next;
}

/**
 * The current persisted work state and next scheduled date; a due schedule proves no execution or current round identity. No next
 * measurement is said for a project its owner paused, nor while the measurement itself is paused: neither one is coming.
 */
export function bandNow(
  project: GeoProject,
  next: { date: string; kind: string; source?: "queued" | "schedule" } | null | undefined,
  now: Date = new Date(),
  measurement: GeoMeasurement | null = null,
  /** The activity strip is saying what is going on: the band says only what is coming. */
  scheduleOnly = false,
): string | null {
  const steps = stepsOf(project);
  const working = GEO_STEP_KEYS
    .filter(key => key !== "monitoring")
    .filter(key => steps[key]?.status === "running" && !stepAllowanceWait(steps[key]))
    .map(key => GEO_STEP_WORK[key]);
  const queued = GEO_STEP_KEYS
    .filter(key => key !== "monitoring")
    .filter(key => steps[key]?.status === "queued" && !stepAllowanceWait(steps[key]))
    .map(key => GEO_STEP_WORK[key]);
  const parts: string[] = [];
  if (!scheduleOnly && working.length > 0) parts.push(`正在${working.join("、")}`);
  if (!scheduleOnly && queued.length > 0) parts.push(`排队中：${queued.join("、")}`);
  const monitor = steps.monitoring;
  if (stepAllowanceWait(monitor)) parts.push("复测等你补额度");
  else if (!scheduleOnly && monitor?.status === "running") parts.push("复测进行中");
  else if (!scheduleOnly && monitor?.status === "queued") parts.push("复测排队中");
  const pause = measurementPause(measurement);
  if (pause) parts.push(pause.short);
  if ((geoAutomationEnabled(project) || next?.source === "queued") && next?.date && project.status !== "paused" && !pause?.paused) {
    const today = agendaLocalDate(DISPLAY_TIME_ZONE, now.toISOString());
    const day = parseGeoDate(next.date);
    const date = `${day ? `${WEEKDAYS[day.getDay()]} ` : ""}${monthDay(next.date) ?? next.date}`.trim();
    if (next.date <= today) {
      // A due schedule is not evidence that a round began, nor an identity for the next round.
      if (monitor?.status !== "running") parts.push(`待复测 ${monthDay(next.date) ?? next.date}`);
      else parts.push(`计划日期 ${date}`);
    } else parts.push(`下次复测 ${date}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The band's strip for what the programme is doing: the step that runs (or, with none, the first in line) and how many stand behind it.
 * A step the allowance would not start is the person's and not the programme's: it is on the rail as 等你 and in the needs, not here.
 */
export function geoActivity(project: GeoProject): { label: string; startedAt?: string | null; waiting?: string; queued?: number; step: GeoStepKey; runId: string | null } | null {
  const steps = stepsOf(project);
  if (project.status === "paused") return null;
  const moving = GEO_STEP_KEYS.filter((key) => (steps[key]?.status === "running" || steps[key]?.status === "queued") && !stepAllowanceWait(steps[key]));
  if (moving.length === 0) return null;
  const running = moving.find((key) => steps[key]?.status === "running");
  const lead = running ?? moving[0];
  const others = moving.length - 1;
  return {
    step: lead,
    runId: steps[lead]?.runId ?? null,
    label: GEO_STEP_WORK[lead],
    ...(running ? { startedAt: steps[lead]?.updatedAt ?? null } : { waiting: "轮到时会自动开始" }),
    ...(others > 0 ? { queued: others } : {}),
  };
}
