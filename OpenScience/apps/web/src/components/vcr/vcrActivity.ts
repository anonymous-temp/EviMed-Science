/**
 * What a study is doing, as the page says it (R19, plan §5.3): the pure half of the activity strip, the polling rule and the version a
 * tab re-reads on.
 *
 * Hidden knowledge:
 *
 *  - **The server decides what is going on** (`activity`, `next`, `stepSummaries`: `vcrStudyStatus.mjs`); nothing here guesses. A
 *    run has an odometer and never a fuel gauge, so the strip says what was counted and for how long, never a percentage.
 *  - **The page reads again only while something moves.** A job waiting for its budget to be confirmed moves nothing until a person
 *    acts, and their action reads the study itself; polling for it would be a request every four seconds for hours.
 *  - **A tab re-reads when the study's `version` changes**, not on a clock: a step's status, an engine job's state, the end of a run.
 *    The count of a running job (3 / 10, then 4 / 10) is deliberately not in it — that is the strip's, and a table that refetched on
 *    every tick would never hold still.
 */
import { RUN_ACTIVITY_PHASE_LABELS_ZH, VCR_STEP_ACTION_LABELS_ZH, VCR_STEP_LABELS_ZH } from "@evimed/domain";
import { VCR_STEP_KEYS, type VcrActivity, type VcrActivityJob, type VcrStepKey, type VcrStudy, type VcrWaitingFor } from "@/lib/vcrClient";

/** How often the study is read while a run, a queue or an engine job moves. */
export const ACTIVITY_POLL_MS = 4_000;
/** How often it is read while the study's conversation is open or the study is still a draft: a sentence said there may name it. */
export const CONVERSATION_POLL_MS = 6_000;

/** A step as the person asked for it, verb and object (「生成虚拟患者」). */
export function stepAction(step: VcrStepKey | null | undefined): string {
  return step ? (VCR_STEP_ACTION_LABELS_ZH as Record<string, string>)[step] ?? "" : "";
}

/** A step's name (「患者」), for the places that name a step rather than ask for one. */
export function stepName(step: VcrStepKey): string {
  return (VCR_STEP_LABELS_ZH as Record<string, string>)[step] ?? step;
}

/** An engine job that is open and not waiting on a person. */
const moving = (job: VcrActivityJob) => job.state === "running" || job.state === "queued";

/** Whether anything is going on that will change by itself: a run, a step in line, an engine job under way. */
export function isMoving(activity: VcrActivity | null | undefined): boolean {
  if (!activity) return false;
  return activity.run !== null || activity.queue.length > 0 || activity.jobs.some(moving);
}

/**
 * When the study is read next, in ms, or null for not at all. A moving study is read every four seconds; one that has just stopped is
 * read again until its tail (`last`) has gone, so the end is seen once and what it produced is on screen; a conversation that is open
 * is read a little slower, for the sentence that names the study.
 */
export function pollInterval(study: Pick<VcrStudy, "activity" | "status">, view: string): number | null {
  if (isMoving(study.activity)) return ACTIVITY_POLL_MS;
  if (study.activity?.last) return ACTIVITY_POLL_MS + 1_000;
  if (view === "chat" || study.status === "draft") return CONVERSATION_POLL_MS;
  return null;
}

/**
 * What the study's tabs depend on, as one string: it changes when a step's state, an engine job's state or the study's own update
 * moves, and when a run has just ended. A tab that reads its own route reads it again when this does.
 */
export function studyVersion(study: VcrStudy): string {
  const steps = VCR_STEP_KEYS.map((key) => `${study.steps[key]?.status ?? ""}@${study.steps[key]?.updatedAt ?? ""}`).join(",");
  const jobs = study.jobs.map((job) => `${job.id}:${job.state}`).join(",");
  return [study.updatedAt ?? "", study.status, steps, jobs, study.activity?.last?.endedAt ?? "", study.activity?.run?.id ?? ""].join("|");
}

/**
 * What a queued step waits for, as one short phrase, for example 等“证据”做完. A wait the server does not name (`waitingFor` null: no run is
 * out and nothing it needs is open) is said as what is known of it — it has not started — and never as a guess at a cause.
 */
export function waitingSentence(waitingFor: VcrWaitingFor | null | undefined, engine = false): string {
  if (engine) return "等计算引擎恢复";
  if (waitingFor === "allowance" || waitingFor === "simulated_allowance") return "等研究额度";
  if (waitingFor === "run") return "等这次运行做完";
  if (waitingFor) return `等“${stepName(waitingFor)}”做完`;
  return "等待开始";
}

/** The odometer of a run: 「检索 6 次 · 纳入 23 篇 · 结论 41/72 已核对」. Only what has happened is named. */
export function runCountsLine(counts: Partial<Record<string, number>>): string {
  const parts: string[] = [];
  if ((counts.search ?? 0) > 0) parts.push(`检索 ${counts.search} 次`);
  if ((counts.included ?? 0) > 0) parts.push(`纳入 ${counts.included} 篇`);
  if ((counts.fullText ?? 0) > 0) parts.push(`全文 ${counts.fullText} 篇`);
  if ((counts.claims ?? 0) > 0) parts.push(`结论 ${counts.claimsVerified ?? 0}/${counts.claims} 已核对`);
  if ((counts.deliverables ?? 0) > 0) parts.push(`交付物 ${counts.deliverablesDone ?? 0}/${counts.deliverables}`);
  return parts.join(" · ");
}

/** What phase a run is in, as one word (「检索」), or null before its first labelled call. */
export function phaseWord(phase: string | null | undefined): string | null {
  if (!phase) return null;
  return (RUN_ACTIVITY_PHASE_LABELS_ZH as Record<string, string>)[phase] ?? null;
}

/**
 * What a run is doing, as one line: the phase it is in and what it has counted (「筛选 · 检索 6 次 · 纳入 3 篇」). A phase the counts
 * already begin with is not said twice — 「检索 1 次」, never 「检索 · 检索 1 次」 (found live, R19).
 */
export function runDetailLine(run: Pick<NonNullable<VcrActivity["run"]>, "phase" | "counts">): string {
  const phase = phaseWord(run.phase);
  const counted = runCountsLine(run.counts);
  const echoed = phase !== null && counted.split(" · ").some((part) => part.startsWith(phase));
  return (echoed ? [counted] : [phase, counted]).filter(Boolean).join(" · ");
}

/** The lead of the open engine jobs: the one under way, else the first in line. A job waiting for a budget is not a lead. */
export function leadJob(activity: VcrActivity | null | undefined): VcrActivityJob | null {
  const open = activity?.jobs.filter(moving) ?? [];
  return open.find((job) => job.state === "running") ?? open[0] ?? null;
}

/** The label of an engine job: its step's verb and object, else the name the study's job list gave it. */
export function jobLabel(job: VcrActivityJob, study: Pick<VcrStudy, "jobs">): string {
  return stepAction(job.step) || study.jobs.find((entry) => entry.id === job.id)?.label || "计算";
}
