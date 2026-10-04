import { Link } from "react-router";
import { AUTOPILOT_BUDGET_ERROR_CODES, BALANCE_REFUSAL_CODES, knownErrorCodeMessage } from "@evimed/domain";
import type { AgendaRecord, EpisodeRecord } from "@/lib/autopilotClient";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { artifactDisplayName } from "@/lib/artifactNames";
import { snapshotHref } from "@/lib/readPages";
import { chatPath } from "@/lib/runLocation";
import { Disclosure } from "@/components/ui/Disclosure";
import { instant, scheduleOf } from "./taskPresentation";

const STATES: Record<string, string> = { queued: "排队中", verifying: "结果核验中", running: "研究进行中", failed: "未完成", canceled: "已取消", merged: "研究结果" };
/** A run held back because the allowance cannot pay for it. A simulated wallet refuses under its own code, and its run waits, and reads, the same way. */
const waitsForBalance = (code: string) => BALANCE_REFUSAL_CODES.includes(code);
export function TaskTimeline({ agenda, episodes, onOpen }: { agenda: AgendaRecord; episodes: EpisodeRecord[]; onOpen: (digest?: string | null) => void }) {
  const zone = scheduleOf(agenda).timeZone;
  // Episodes preserve complete follow-ups even after the agenda's latest-20 message window rotates.
  const timeline = [
    ...episodes.map(episode => ({ key: episode.id, at: episode.payload.createdAt || episode.payload.date, episode, note: episode.payload.followUpNote, paused: false })),
    // A message that asked to hold the research has no episode: the task was paused in answer to it.
    ...(agenda.payload.messages ?? []).filter(message => !episodes.some(episode => episode.id === message.runEpisodeId))
      .map(message => ({ key: message.requestId, at: message.at, note: message.note, episode: null, paused: message.outcome === "paused" })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return <div className="space-y-8">
    {timeline.length === 0 && <p className="text-ui text-text-3">还没有运行结果。</p>}
    <ol aria-label="任务记录" className="space-y-8">{timeline.map(item => {
      const episode = item.episode;
      const payload = episode?.payload;
      const deferrals = Object.values(payload?.resourceDeferrals ?? {}).filter(Boolean);
      const waiting = deferrals.find(value => value?.status === "waiting");
      const exhausted = deferrals.find(value => value?.status === "exhausted");
      // The task's own budget was spent between scheduling and starting: nothing ran, and the sentence says whose budget it is.
      const budgetSpent = payload?.status === "failed" && AUTOPILOT_BUDGET_ERROR_CODES.includes(payload.error?.code ?? "") ? payload.error?.code ?? null : null;
      const state = item.paused ? "已按你的要求暂停" : budgetSpent ? "任务预算已用完" : waiting ? (waitsForBalance(waiting.code) ? "等待余额" : "等待运行资源")
        : exhausted ? (waitsForBalance(exhausted.code) ? "余额不足" : "运行资源暂不可用") : STATES[payload?.status ?? ""] ?? "正在安排";
      const artifacts = (payload?.artifactRefs ?? []).filter(ref => ref.projectId === agenda.projectId && ref.runId === payload?.runId
        && ref.sessionId === payload?.sessionId && /^[A-Za-z0-9_-]{1,160}$/.test(ref.runId) && safeWorkspacePath(ref.path));
      return <li key={item.key} className="space-y-3">
        <p className="text-center text-caption text-text-3">{instant(payload?.scheduledAt ?? item.at, zone)}</p>
        {item.note && <p className="ml-auto max-w-body whitespace-pre-wrap break-words rounded-panel bg-surface-2 px-5 py-4 text-ui text-text">{item.note}</p>}
        <div className="space-y-3 text-ui text-text">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{state}</span><span className="text-caption text-text-3">{payload?.trigger === "manual" ? "手动运行" : payload?.trigger === "follow-up" ? "任务追问" : payload ? "定时运行" : "任务追问"}</span></div>
          {budgetSpent && <p className="text-caption text-text-3">{knownErrorCodeMessage(budgetSpent)}</p>}
          {waiting?.retryAt && <p className="text-caption text-text-3">预计重试 {instant(waiting.retryAt, zone)}</p>}
          {payload?.selection?.source === "model" && (payload.selection.focus || payload.selection.reason) && <p className="whitespace-pre-wrap break-words text-caption text-text-2">本次关注：{payload.selection.focus || payload.selection.reason}</p>}
          {(payload?.claims ?? []).map(claim => <p key={claim.id} className="whitespace-pre-wrap break-words leading-relaxed">{claim.tier === "reproduced" && claim.verification?.status === "recorded" && claim.verification.reproductionMatched && claim.verification.isolationEnforced ? "已复现：" : "研究线索："}{claim.statement}</p>)}
          {(payload?.claims?.length ?? 0) > 0 && artifacts.length === 0 && <p className="text-caption text-text-3">成果文件暂不可用</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-2">{artifacts.map(ref => <Link key={`${ref.runId}:${ref.path}`} to={snapshotHref(ref.runId, ref.path)} onClick={() => onOpen(payload?.digestId)} className="text-link hover:underline">{artifactDisplayName(ref.path)}</Link>)}
            {payload?.sessionId && <Link to={chatPath(payload.sessionId)} onClick={() => onOpen(payload.digestId)} className="text-link hover:underline">打开运行对话</Link>}
          </div>
          {payload?.instruction && <Disclosure summary="本次运行指令"><p className="whitespace-pre-wrap break-words text-caption text-text-2">{payload.instruction}</p></Disclosure>}
        </div>
      </li>;
    })}</ol>
  </div>;
}
