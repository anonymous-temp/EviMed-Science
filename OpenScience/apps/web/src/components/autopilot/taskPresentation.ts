import type { AgendaRecord, AgendaSchedule } from "@/lib/autopilotClient";
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
export function recurrence(schedule: AgendaSchedule): string {
  return `${schedule.kind === "once" ? `${schedule.date ?? ""} · 仅一次` : schedule.kind === "weekly" ? `每${(schedule.weekdays ?? []).map(day => WEEKDAYS[day - 1]).join("、")}` : "每天"} ${schedule.time}`;
}
export function instant(value: string | undefined | null, timeZone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
export function activeAgenda(agenda: AgendaRecord): boolean { return agenda.payload.enabled && agenda.payload.status === "active" && !agenda.payload.archivedAt; }
export function scheduleStatus(agenda: AgendaRecord): string {
  if (agenda.payload.scheduleState === "completed") return "已完成";
  if (!activeAgenda(agenda)) return "已暂停";
  return agenda.payload.nextRunAt ? `下次 ${instant(agenda.payload.nextRunAt, scheduleOf(agenda).timeZone)}` : "暂无下次运行";
}
export function revisionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}
