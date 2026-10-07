import { Link } from "react-router";
import { AUTOPILOT_BUDGET_ERROR_CODES, knownErrorCodeMessage } from "@evimed/domain";
import type { AgendaRecord, EpisodeRecord } from "@/lib/autopilotClient";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { artifactDisplayName, splitArtifacts } from "@/lib/artifactNames";
import { snapshotHref } from "@/lib/readPages";
import { chatPath } from "@/lib/runLocation";
import { Disclosure } from "@/components/ui/Disclosure";
import { ClampedText } from "./ClampedText";
import { instant, runState, scheduleOf } from "./taskPresentation";

/** The runs shown in full; every earlier one is folded under one line, so the newest is never under a long scroll. */
export const RECENT_RUNS = 2;
export function TaskTimeline({ agenda, episodes, onOpen }: { agenda: AgendaRecord; episodes: EpisodeRecord[]; onOpen: (digest?: string | null) => void }) {
  const zone = scheduleOf(agenda).timeZone;
  // What the task was set to do. A run that was handed exactly this has nothing to add to it.
  const taskInstruction = agenda.payload.prompt ?? agenda.payload.topics.join("\n");
  // Episodes preserve complete follow-ups even after the agenda's latest-20 message window rotates.
  const timeline = [
    ...episodes.map(episode => ({ key: episode.id, at: episode.payload.createdAt || episode.payload.date, episode, note: episode.payload.followUpNote, paused: false })),
    // A message that asked to hold the research has no episode: the task was paused in answer to it.
    ...(agenda.payload.messages ?? []).filter(message => !episodes.some(episode => episode.id === message.runEpisodeId))
      .map(message => ({ key: message.requestId, at: message.at, note: message.note, episode: null, paused: message.outcome === "paused" })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const entry = (item: typeof timeline[number]) => {
    const episode = item.episode;
    const payload = episode?.payload;
    const deferrals = Object.values(payload?.resourceDeferrals ?? {}).filter(Boolean);
    const waiting = deferrals.find(value => value?.status === "waiting");
    // The task's own budget was spent between scheduling and starting: nothing ran, and the sentence says whose budget it is.
    const budgetSpent = payload?.status === "failed" && AUTOPILOT_BUDGET_ERROR_CODES.includes(payload.error?.code ?? "") ? payload.error?.code ?? null : null;
    const state = item.paused ? "已按你的要求暂停" : runState(payload);
    const { readable, other } = splitArtifacts((payload?.artifactRefs ?? []).filter(ref => ref.projectId === agenda.projectId && ref.runId === payload?.runId
      && ref.sessionId === payload?.sessionId && /^[A-Za-z0-9_-]{1,160}$/.test(ref.runId) && safeWorkspacePath(ref.path)));
    const link = (ref: typeof readable[number]) => <Link key={`${ref.runId}:${ref.path}`} to={snapshotHref(ref.runId, ref.path)} onClick={() => onOpen(payload?.digestId)} className="text-link hover:underline">{artifactDisplayName(ref.path)}</Link>;
    return <li key={item.key} className="space-y-3">
      <p className="text-center text-caption text-text-3">{instant(payload?.scheduledAt ?? item.at, zone)}</p>
      {item.note && <div className="ml-auto max-w-body rounded-panel bg-surface-2 px-5 py-4 text-ui text-text"><ClampedText text={item.note} lines={4} /></div>}
      <div className="space-y-3 text-ui text-text">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{state}</span><span className="text-caption text-text-3">{payload?.trigger === "manual" ? "手动运行" : payload?.trigger === "follow-up" ? "任务追问" : payload ? "定时运行" : "任务追问"}</span></div>
        {budgetSpent && <p className="text-caption text-text-3">{knownErrorCodeMessage(budgetSpent)}</p>}
        {waiting?.retryAt && <p className="text-caption text-text-3">预计重试 {instant(waiting.retryAt, zone)}</p>}
        {payload?.selection?.source === "model" && (payload.selection.focus || payload.selection.reason) && <p className="whitespace-pre-wrap break-words text-caption text-text-2">本次关注：{payload.selection.focus || payload.selection.reason}</p>}
        {(payload?.claims ?? []).map(claim => <p key={claim.id} className="whitespace-pre-wrap break-words leading-relaxed">{claim.tier === "reproduced" && claim.verification?.status === "recorded" && claim.verification.reproductionMatched && claim.verification.isolationEnforced ? "已复现：" : "研究线索："}{claim.statement}</p>)}
        {(payload?.claims?.length ?? 0) > 0 && readable.length === 0 && <p className="text-caption text-text-3">成果文件暂不可用</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-2">{readable.map(link)}
          {payload?.sessionId && <Link to={chatPath(payload.sessionId)} onClick={() => onOpen(payload.digestId)} className="text-link hover:underline">打开运行对话</Link>}
        </div>
        {/* The run's working files — its scripts, intermediate tables, logs — stay on record, behind one line. */}
        {other.length > 0 && <Disclosure summary={`其他文件 ${other.length} 个`} summaryClassName="text-caption"><div className="flex flex-wrap gap-x-4 gap-y-2 text-caption">{other.map(link)}</div></Disclosure>}
        {payload?.instruction && payload.instruction !== taskInstruction && <Disclosure summary="这次用的任务指令" summaryClassName="text-caption"><p className="whitespace-pre-wrap break-words text-caption text-text-2">{payload.instruction}</p></Disclosure>}
      </div>
    </li>;
  };
  const earlier = timeline.slice(0, Math.max(0, timeline.length - RECENT_RUNS));
  const recent = timeline.slice(earlier.length);
  return <div className="space-y-8">
    {timeline.length === 0 && <p className="text-ui text-text-3">还没有运行结果。</p>}
    {earlier.length > 0 && <Disclosure summary={`更早的 ${earlier.length} 次运行`}><ol aria-label="更早的任务记录" className="space-y-8 pt-4">{earlier.map(entry)}</ol></Disclosure>}
    <ol aria-label="任务记录" className="space-y-8">{recent.map(entry)}</ol>
  </div>;
}
