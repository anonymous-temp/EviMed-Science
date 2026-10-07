import { AUTOPILOT_BUDGET_ERROR_CODES, BALANCE_REFUSAL_CODES, knownErrorCodeMessage, type VERIFICATION_UNSCHEDULED_REASONS } from "@evimed/domain";
import type { AgendaRecord, AgendaSchedule, EpisodePayload, EpisodeRecord, ResearchState } from "@/lib/autopilotClient";
export const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const TASK_TYPES = [
  ["literature-sentinel", "文献追踪"], ["evidence-update", "证据更新"], ["signal-monitoring", "安全信号监测"],
  ["data-prospecting", "数据探查"], ["hypothesis-suggestion", "研究假设"], ["writing-pipeline", "研究写作"],
];
export const RECOMMENDATIONS = [
  { title: "每日文献简报", prompt: "每天检索心力衰竭领域新发表的临床研究。说明研究设计、主要结局与局限，附可核验的来源；仅汇报有意义的新变化。", kind: "daily" as const },
  { title: "指南更新周报", prompt: "每周跟进 2 型糖尿病治疗指南及共识的更新，比较推荐变化、适用人群及证据等级，保留原文出处。", kind: "weekly" as const },
  { title: "药物安全追踪", prompt: "跟进司美格鲁肽的胰腺炎与胃轻瘫安全性证据，区分自发报告信号与因果证据，说明新增信息及不确定性。", kind: "weekly" as const },
  { title: "头对头研究更新", prompt: "每周检索替尔泊肽与司美格鲁肽在减重与血糖控制方面的直接比较研究，注明人群、剂量、随访和结局，不以间接比较冒充头对头证据。", kind: "weekly" as const },
  { title: "临床试验进展", prompt: "每周跟进国内减重药物 III 期临床试验的注册更新、完成时间和结果披露，以登记平台与正式发表为准，注明尚未公布的信息。", kind: "weekly" as const },
  { title: "特殊人群用药证据", prompt: "每周追踪妊娠期与哺乳期降压药的安全性研究，分别整理两类人群的证据及局限，附来源，不将观察结果直接转成个人用药建议。", kind: "weekly" as const },
];
export type Recommendation = typeof RECOMMENDATIONS[number];
export function scheduleOf(agenda: AgendaRecord): AgendaSchedule {
  return agenda.payload.schedule ?? { kind: "daily", timeZone: agenda.payload.timeZone || "Asia/Shanghai", time: `${String(agenda.payload.scheduleHour ?? 7).padStart(2, "0")}:00` };
}
/** `2026-10-12` as 「10月12日」, with the year only when it is not this one. A date the schedule holds is a calendar date, not a moment: no zone applies. */
function calendarDay(value: string | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return "";
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return `${year === new Date().getFullYear() ? "" : `${year}年`}${month}月${day}日`;
}
/** How often, without the clock time: 「每天」, 「每周一、周五」, 「仅一次」. */
export function repeatLabel(schedule: AgendaSchedule): string {
  if (schedule.kind === "once") return "仅一次";
  if (schedule.kind === "weekly") return `每${(schedule.weekdays ?? []).map(day => WEEKDAYS[day - 1]).join("、") || "周"}`;
  return "每天";
}
/** The repeat for a line that already names the next run: 「每天 07:00」, and just 「仅一次」 for a task that runs once (its day is the next run). */
export function repeatLine(schedule: AgendaSchedule): string {
  return schedule.kind === "once" ? repeatLabel(schedule) : `${repeatLabel(schedule)} ${schedule.time}`;
}
/** How often and when, as a sentence part: 「每天 07:00」, 「每周一、周五 07:30」, 「10月12日 · 仅一次 07:00」. */
export function recurrence(schedule: AgendaSchedule): string {
  const day = schedule.kind === "once" ? calendarDay(schedule.date) : "";
  return `${day ? `${day} · ` : ""}${repeatLabel(schedule)} ${schedule.time}`;
}
/** The zone as a reader names it (「中国标准时间」), or nothing for an identifier the runtime does not know. */
export function zoneName(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone, timeZoneName: "long" }).formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}
/** 「单次上限 ¥8」: what one run may spend, said where the task is described. */
export function episodeCap(value: number): string { return `单次上限 ¥${value}`; }
export function instant(value: string | undefined | null, timeZone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
/** 「10月7日」: the day of a moment in the task's zone. */
export function dayOf(value: string | undefined | null, timeZone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "long", day: "numeric" }).format(new Date(value));
}

/** What a run is called by its status. */
export const RUN_STATES: Record<string, string> = { queued: "排队中", verifying: "结果核验中", running: "研究进行中", failed: "未完成", canceled: "已取消", merged: "研究结果" };
/** A run held back because the allowance cannot pay for it. A simulated wallet refuses under its own code, and its run waits, and reads, the same way. */
const waitsForBalance = (code: string) => BALANCE_REFUSAL_CODES.includes(code);
/** The runs still on their way: nothing of theirs is a result yet. */
export const RUN_IN_FLIGHT = ["queued", "running", "verifying"];
/**
 * What a run says about itself, in one phrase. A run the task's own budget did not allow to start says whose budget it is, a run
 * waiting for the allowance or for a runtime says what it waits for, and the rest is the status.
 */
export function runState(payload: EpisodePayload | undefined): string {
  const deferrals = Object.values(payload?.resourceDeferrals ?? {}).filter(Boolean);
  const waiting = deferrals.find(value => value?.status === "waiting");
  const exhausted = deferrals.find(value => value?.status === "exhausted");
  const budgetSpent = payload?.status === "failed" && AUTOPILOT_BUDGET_ERROR_CODES.includes(payload.error?.code ?? "");
  return budgetSpent ? "任务预算已用完" : waiting ? (waitsForBalance(waiting.code) ? "等待余额" : "等待运行资源")
    : exhausted ? (waitsForBalance(exhausted.code) ? "余额不足" : "运行资源暂不可用") : RUN_STATES[payload?.status ?? ""] ?? "正在安排";
}
/** When a run belongs on the task's timeline. */
const runAt = (episode: EpisodeRecord) => episode.payload.scheduledAt ?? episode.payload.createdAt ?? episode.payload.date ?? "";
/** The newest run of one task among `episodes`, or null. */
export function latestRun(agendaId: string, episodes: readonly EpisodeRecord[]): EpisodeRecord | null {
  let newest: EpisodeRecord | null = null;
  for (const episode of episodes) if (episode.payload.agendaId === agendaId && (!newest || runAt(episode).localeCompare(runAt(newest)) > 0)) newest = episode;
  return newest;
}
/**
 * The line under a task: what its last run came to — 「上次 10月7日 · 研究结果」, 「上次 10月7日 · 未完成」 — or that it is on its way
 * (「研究进行中」) or has not run. `withTime` adds the clock for the drawer.
 */
export function lastRunLine(agenda: AgendaRecord, episodes: readonly EpisodeRecord[], { withTime = false } = {}): string {
  const run = latestRun(agenda.id, episodes);
  if (!run) return "还没有运行";
  const state = runState(run.payload);
  if (RUN_IN_FLIGHT.includes(run.payload.status)) return state;
  const zone = scheduleOf(agenda).timeZone;
  const when = withTime ? instant(runAt(run), zone) : dayOf(runAt(run), zone);
  return when ? `上次 ${when} · ${state}` : `上次 ${state}`;
}
export function activeAgenda(agenda: AgendaRecord): boolean { return agenda.payload.enabled && agenda.payload.status === "active" && !agenda.payload.archivedAt; }
export function scheduleStatus(agenda: AgendaRecord): string {
  if (agenda.payload.scheduleState === "completed") return "已完成";
  if (!activeAgenda(agenda)) return "已暂停";
  return agenda.payload.nextRunAt ? `下次 ${instant(agenda.payload.nextRunAt, scheduleOf(agenda).timeZone)}` : "暂无下次运行";
}
/** What the researcher should know about a task that is not simply running: the planner's stop, and any task type paused after failures. */
export function pauseNotes(agenda: AgendaRecord): string[] {
  const notes: string[] = [];
  const stop = agenda.payload.plannerStop;
  if (stop && !activeAgenda(agenda)) notes.push(`${stop.kind === "needs_input" ? "需要你补充：" : "已暂停："}${stop.reason}`);
  // A pause the server put on a task whose cap cannot fund a run: the registry's sentence, the one the edit form's refusal reads.
  const cause = !activeAgenda(agenda) && !stop && agenda.payload.pauseCode ? knownErrorCodeMessage(agenda.payload.pauseCode) : null;
  if (cause) notes.push(`已暂停：${cause}`);
  const paused = Object.entries(agenda.payload.taskTypeState ?? {}).filter(([, state]) => state.pausedAt).map(([type]) => TASK_TYPES.find(([value]) => value === type)?.[1] ?? type);
  if (paused.length > 0) notes.push(`${paused.join("、")}连续未能运行，已暂停；编辑任务类型或重新启用任务可恢复。`);
  return notes;
}
export function revisionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}
/** A task the planner paused (the question is answered, the evidence is used up, material is needed, or the researcher asked to hold). Their next message or added material can continue it; nothing else paused it this way. */
export function resumableByReply(agenda: AgendaRecord): boolean {
  return !activeAgenda(agenda) && !agenda.payload.archivedAt && agenda.payload.status === "paused" && Boolean(agenda.payload.plannerStop);
}
/** The planner stopped because it needs something only the researcher has. */
export function needsMaterial(agenda: AgendaRecord): boolean {
  return resumableByReply(agenda) && agenda.payload.plannerStop?.kind === "needs_input";
}
export const FOUND_PREFIX: Record<ResearchState["found"][number]["check"], string> = { reproduced: "已复现：", stands: "独立复核后仍成立：", refuted: "已被推翻：" };
const UNRESOLVED_PREFIX: Record<Exclude<ResearchState["unresolved"][number]["kind"], "not_run" | "not_rechecked">, string> = {
  unchecked: "尚未独立复核：", check_unavailable: "复核未能进行：", weakened: "被复核削弱：", question: "你的问题：",
};
/** Why no independent check will be made, one line each. An agenda that stopped leaves a re-check either unstarted or cancelled with it; both read the same. */
const NOT_RECHECKED: Record<typeof VERIFICATION_UNSCHEDULED_REASONS[number], string> = {
  agenda_stopped: "任务已停止，未做独立复核：", agenda_paused: "任务已暂停，未做独立复核：",
  verification_cap: "超出每次研究复核的条数，未安排独立复核：", verification_budget_unavailable: "单次上限不够再支付一次复核，未安排独立复核：",
};
export function unresolvedText(item: ResearchState["unresolved"][number]): string {
  // A run that did not run says nothing about the question, and the line says so.
  if (item.kind === "not_run") return "最近一次研究没有完成，结果未知。";
  if (item.kind === "not_rechecked") return `${NOT_RECHECKED[item.reason as keyof typeof NOT_RECHECKED] ?? "未做独立复核："}${item.text ?? ""}`;
  return `${UNRESOLVED_PREFIX[item.kind]}${item.text ?? ""}`;
}
/** What a researcher is told about an added document; a usable one needs no word. */
export const MATERIAL_STATE: Record<ResearchState["materials"][number]["state"], string> = { ready: "", reading: "正在读取", attention: "需要处理", unavailable: "无法使用" };
