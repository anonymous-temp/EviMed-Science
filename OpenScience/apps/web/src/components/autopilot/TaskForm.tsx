import { useEffect, useRef, useState } from "react";
import { AGENDA_DEFAULT_BUDGETS, AGENDA_MIN_EPISODE_BUDGET_CNY } from "@evimed/domain";
import { createAgenda, getAgenda, startAgenda, updateAgenda, type AgendaRecord, type AgendaSchedule } from "@/lib/autopilotClient";
import { productErrorMessage } from "@/lib/productClient";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input, Textarea, Select } from "@/components/ui/Input";
import { scheduleOf, revisionConflict, TASK_TYPES, WEEKDAYS, type Recommendation } from "./taskPresentation";

export function TaskForm({ projectId, agenda, recommendation, onSaved, onRecorded, onBusyChange, onCancel }: {
  projectId: string; agenda?: AgendaRecord; recommendation?: Recommendation;
  onSaved: (record: AgendaRecord) => void; onRecorded: (record: AgendaRecord) => void; onBusyChange: (busy: boolean) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(agenda?.payload.title ?? recommendation?.title ?? "");
  const [prompt, setPrompt] = useState(agenda?.payload.prompt ?? agenda?.payload.topics.join("\n") ?? recommendation?.prompt ?? "");
  const [schedule, setSchedule] = useState<AgendaSchedule>(agenda ? scheduleOf(agenda) : {
    kind: recommendation?.kind ?? "daily", time: "07:00", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai", weekdays: [1],
  });
  const [taskTypes, setTaskTypes] = useState(agenda?.payload.taskTypes ?? ["literature-sentinel"]);
  // The defaults and the floor are the domain's, the ones the server holds the saved task to: the form cannot offer what the server refuses.
  const [budgets, setBudgets] = useState({ maxEpisodeCny: agenda?.payload.maxEpisodeCny ?? AGENDA_DEFAULT_BUDGETS.maxEpisodeCny, dailyBudgetCny: agenda?.payload.dailyBudgetCny ?? AGENDA_DEFAULT_BUDGETS.dailyBudgetCny, weeklyBudgetCny: agenda?.payload.weeklyBudgetCny ?? AGENDA_DEFAULT_BUDGETS.weeklyBudgetCny });
  const minimum = `¥${AGENDA_MIN_EPISODE_BUDGET_CNY.toFixed(2)}`;
  const episodeTooSmall = budgets.maxEpisodeCny < AGENDA_MIN_EPISODE_BUDGET_CNY;
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<AgendaRecord | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  let validZone = true;
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: schedule.timeZone }); } catch { validZone = false; }
  const valid = prompt.trim().length > 0 && validZone && taskTypes.length > 0
    && (schedule.kind !== "weekly" || (schedule.weekdays?.length ?? 0) > 0) && (schedule.kind !== "once" || !!schedule.date)
    && budgets.maxEpisodeCny >= AGENDA_MIN_EPISODE_BUDGET_CNY && budgets.maxEpisodeCny <= budgets.dailyBudgetCny && budgets.dailyBudgetCny <= budgets.weeklyBudgetCny;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!valid || saving || conflict) return;
    setSaving(true); onBusyChange(true); setError(null);
    let record = created;
    try {
      const value = { title: title.trim() || prompt.trim().slice(0, 60), prompt, taskTypes, ...budgets,
        schedule: { kind: schedule.kind, time: schedule.time, timeZone: schedule.timeZone,
          ...(schedule.kind === "once" ? { date: schedule.date } : schedule.kind === "weekly" ? { weekdays: schedule.weekdays } : {}) } };
      if (agenda) {
        const updated = await updateAgenda(agenda.id, { ...value, expectedRevision: agenda.revision });
        if (live.current) onSaved(updated);
      } else {
        if (!record) {
          record = await createAgenda({ ...value, projectId });
          if (!live.current) return;
          setCreated(record); onRecorded(record);
        }
        const started = await startAgenda(record.id, record.revision);
        if (live.current) onSaved(started);
      }
    } catch (caught) {
      if (!live.current) return;
      if (revisionConflict(caught)) {
        const id = agenda?.id ?? record?.id;
        if (id) {
          try { const fresh = await getAgenda(id); if (live.current) { onRecorded(fresh); if (record) setCreated(fresh); } }
          catch { /* Keep the failed edit and require an explicit reload. */ }
        }
        if (!live.current) return;
        if (agenda) setConflict(true);
        setError("任务已被更新。请关闭编辑后重新打开，核对最新内容再修改。");
      } else setError(`${record ? "任务已创建，启用未成功。" : ""}${productErrorMessage(caught)}`);
    } finally { if (live.current) { setSaving(false); onBusyChange(false); } }
  };
  return <form className="space-y-5" onSubmit={submit}>
    <fieldset disabled={saving || !!created || conflict} className="min-w-0 space-y-4">
      <Input label="名称" value={title} maxLength={200} placeholder="为任务起个名字" onChange={event => setTitle(event.target.value)} />
      <Textarea label="任务指令" required rows={5} maxLength={20000} value={prompt} placeholder="说明研究问题、关注范围和希望收到的结果…" onChange={event => setPrompt(event.target.value)} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select label="重复" value={schedule.kind} onChange={event => setSchedule({ ...schedule, kind: event.target.value as AgendaSchedule["kind"], weekdays: schedule.weekdays ?? [1] })}>
          <option value="once">仅一次</option><option value="daily">每天</option><option value="weekly">每周</option>
        </Select>
        <Input label="时间" type="time" required value={schedule.time} onChange={event => setSchedule({ ...schedule, time: event.target.value })} />
      </div>
      {schedule.kind === "once" && <Input label="日期" type="date" required value={schedule.date ?? ""} onChange={event => setSchedule({ ...schedule, date: event.target.value })} />}
      {schedule.kind === "weekly" && <fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-ui font-medium text-text">星期</legend>{WEEKDAYS.map((day, index) => <label key={day} className="flex items-center gap-1 text-ui text-text"><input type="checkbox" checked={schedule.weekdays?.includes(index + 1) ?? false} onChange={event => setSchedule({ ...schedule, weekdays: event.target.checked ? [...(schedule.weekdays ?? []), index + 1].sort() : schedule.weekdays?.filter(value => value !== index + 1) })} />{day}</label>)}</fieldset>}
      <Disclosure summary={<span>高级设置<span className="ml-2 text-caption text-text-3">{schedule.timeZone}</span></span>} defaultOpen={!validZone || episodeTooSmall}><div className="space-y-4 pt-2">
        <Input label="时区" value={schedule.timeZone} error={validZone ? undefined : "请输入有效时区，例如 Asia/Shanghai"} required onChange={event => setSchedule({ ...schedule, timeZone: event.target.value })} />
        <fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-ui font-medium text-text">任务类型</legend>{TASK_TYPES.map(([value, label]) => <label key={value} className="flex items-center gap-1 text-ui text-text"><input type="checkbox" checked={taskTypes.includes(value)} onChange={event => setTaskTypes(event.target.checked ? [...taskTypes, value] : taskTypes.filter(item => item !== value))} />{label}</label>)}</fieldset>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{([['maxEpisodeCny', '单次上限 ¥'], ['dailyBudgetCny', '每日上限 ¥'], ['weeklyBudgetCny', '每周上限 ¥']] as const).map(([key, label]) => <Input key={key} label={label} type="number" min={key === "maxEpisodeCny" ? String(AGENDA_MIN_EPISODE_BUDGET_CNY) : "0.01"} step="0.01" value={budgets[key]}
          error={key === "maxEpisodeCny" && episodeTooSmall ? `单次上限不能低于 ${minimum}` : undefined} onChange={event => setBudgets({ ...budgets, [key]: Number(event.target.value) })} />)}</div>
        <p className="text-caption text-text-3">单次上限最低 {minimum}：模型每次调用要先预留约 ¥1，预算再小，研究一开始就会被拒绝。单次 ≤ 每日 ≤ 每周。每日、每周按近 24 小时、近 7 天滚动计算，只计这个任务自己的花费，不含账户里的其他研究。</p>
      </div></Disclosure>
    </fieldset>
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
    <div className="flex justify-end gap-2 border-t border-border pt-4"><Button variant="secondary" disabled={saving} onClick={onCancel}>{conflict ? "关闭编辑" : "取消"}</Button><Button type="submit" loading={saving} disabled={!valid || conflict}>{agenda ? "保存修改" : created ? "重试启用" : "创建并启用"}</Button></div>
  </form>;
}
