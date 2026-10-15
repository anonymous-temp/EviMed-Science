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
    return { id: key, label: GEO_STEP_NAMES[key], state, summary, href: hrefOf(key) };
  });
}

/** 「周一」「周二」… for a day in the reader's calendar. */
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * The one sentence at the rail's right end — 「现在」: what the programme is doing and when it measures next. No percentage, no bar:
 * a number on work an agent is doing is one nobody can honour.
 *
 *  - the steps being worked on, in the work's own word (「正在写稿、投放」) — 监测 is the schedule's and is said by the next line;
 *  - a measurement under way (the next date has come and the round is queued or running): 「第 3 轮复测中」;
 *  - otherwise the next one: 「下次复测 周一 10月21日」.
 *
 * `next` is the monitoring read's `next` (a date and the round kind); null where it is not known yet, and then only the work is said.
 * Null when there is nothing to say.
 */
export function bandNow(
  project: GeoProject,
  next: { date: string; kind: string } | null | undefined,
  now: Date = new Date(),
): string | null {
  const steps = stepsOf(project);
  const working = GEO_STEP_KEYS
    .filter((key) => key !== "monitoring")
    .filter((key) => {
      const step = steps[key];
      return step && (step.status === "running" || step.status === "queued") && !stepAllowanceWait(step);
    })
    .map((key) => GEO_STEP_WORK[key]);
  const parts: string[] = [];
  if (working.length > 0) parts.push(`正在${working.join("、")}`);
  if (next?.date) {
    const today = agendaLocalDate(DISPLAY_TIME_ZONE, now.toISOString());
    const rounds = steps.monitoring?.summary?.count ?? project.overview?.metrics?.[0]?.trend?.length ?? 0;
    if (next.date <= today) {
      // The round the date names has begun: the baseline when nothing was measured yet, else the n-th re-test.
      parts.push(rounds > 0 ? `第 ${rounds} 轮复测中` : "基线测量中");
    } else {
      const day = parseGeoDate(next.date);
      parts.push(`下次复测 ${day ? `${WEEKDAYS[day.getDay()]} ` : ""}${monthDay(next.date) ?? ""}`.trim());
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
