/**
 * What the fixed band above every GEO tab says, decided before anything is drawn (R19, audit C A.1–A.2): the eight steps as one row
 * and the one sentence at its end. The tabs below it are drawn by the layout; this is only the words and the states.
 */
import { agendaLocalDate, DISPLAY_TIME_ZONE } from "@evimed/domain";
import { GEO_STEP_KEYS, type GeoProject, type GeoStepKey } from "@/lib/geoClient";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import type { RailState } from "@/components/ui/ProgressRail";
import type { StepRailStep } from "@/components/ui/StepRail";
import { GEO_STEP_NAMES, GEO_STEP_WORK, monthDay, parseGeoDate } from "./geoText";
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
 * The eight steps for the rail. One of them may be `waiting`: the programme's single money stop — a placement budget only a person
 * may set — and the one a step the allowance would not start shares with it: both are the reader's. Without a market there is
 * nothing to owe: the step is untouched and its tooltip says it waits for the market, and nothing on the page asks for a budget.
 * A step that did not finish is `attention`; one a single run only half did is `partial`.
 *
 * `summary` is what the step produced — the server's own count (「86 条结论」), else its short note; it is the tooltip and never a
 * second line, so the band is one height whatever the states.
 */
export function bandSteps(project: GeoProject, hrefOf: (step: GeoStepKey) => string): StepRailStep[] {
  const steps = stepsOf(project);
  const needsBudget = project.budget === null || !(project.budget.totalCny > 0);
  const market = marketConnected(project);
  return GEO_STEP_KEYS.map((key) => {
    const step = steps[key];
    const status = step?.status ?? "none";
    const done = status === "done";
    const working = status === "running" || status === "queued";
    // Placing is asked for when the reader requested it or it is already moving; a step nobody asked for owes neither budget nor market.
    const asked = key === "distribution" && !done && status !== "minimal" && (step?.requested === true || working || status === "failed");
    const held = asked && !market;
    const budget = asked && market && needsBudget;
    const allowance = stepAllowanceWait(step);
    const state: RailState = budget || allowance ? "waiting"
      : status === "failed" ? "attention"
        : done ? "done"
          : status === "minimal" ? "partial"
            : held ? "todo"
              : working ? "active" : "todo";
    const summary = budget ? "待你确认预算" : held ? GEO_MARKET_OFF_NOTE : step?.summary?.text ?? shortNote(step?.note);
    return { id: key, label: GEO_STEP_NAMES[key], state, stateLabel: status === "none" ? step?.requested === true ? "待开始" : step?.requested === false ? "未请求" : "未开始" : status === "queued" ? "排队中" : undefined, summary, href: hrefOf(key) };
  });
}

/** 「周一」「周二」… for a day in the reader's calendar. */
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** The current persisted work state and next scheduled date; a due schedule proves no execution or current round identity. */
export function bandNow(
  project: GeoProject,
  next: { date: string; kind: string } | null | undefined,
  now: Date = new Date(),
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
  if (working.length > 0) parts.push(`正在${working.join("、")}`);
  if (queued.length > 0) parts.push(`排队中：${queued.join("、")}`);
  const monitor = steps.monitoring;
  if (stepAllowanceWait(monitor)) parts.push("复测等待额度");
  else if (monitor?.status === "running") parts.push("复测进行中");
  else if (monitor?.status === "queued") parts.push("复测排队中");
  if (next?.date) {
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
