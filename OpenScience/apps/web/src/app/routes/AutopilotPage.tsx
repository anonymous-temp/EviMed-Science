import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { CalendarClock, PauseCircle, PlayCircle, Sparkles } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { decideDigest, getDigest, listAgendas, listDigests, markDigestOpened, scheduleAgenda, startAgenda, stopAgenda,
  type AgendaRecord, type DigestClaim, type DigestRecord } from "@/lib/autopilotClient";
import { productErrorMessage } from "@/lib/productClient";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";

function pendingFollowUps(agenda: AgendaRecord): number {
  return (agenda.payload.followUps ?? []).filter((item) => !item.consumedBy).length;
}

/**
 * How far a finding has been checked, and by whom.
 *
 * The tier is what separates "我们发现" from "看起来", so the reader is told which
 * one they are looking at rather than left to infer it from the position on the
 * page. A refutation is said out loud: a claim the digest offered yesterday and
 * an independent re-check overturned today is the one sentence a reader most
 * needs and would least expect to find.
 */
function verificationLabel(claim: DigestClaim): { text: string; refuted: boolean } | null {
  if (claim.refutation === "refuted") return { text: "独立复核未能复现，已降级为线索", refuted: true };
  if (claim.refutation === "weakened") return { text: "独立复核只能部分支持", refuted: false };
  if (claim.tier === "reproduced") return { text: "独立复核已复现", refuted: false };
  if (claim.refutation === "stands") return { text: "独立复核未能推翻", refuted: false };
  if (claim.verification?.status === "queued") return { text: "独立复核排队中", refuted: false };
  if (claim.verification?.status === "unavailable") return { text: "独立复核未完成，仍停留在门禁通过", refuted: false };
  // A claim that was never scheduled is not a claim awaiting its turn. The
  // service records the two separately on purpose, and a reader who cannot tell
  // them apart is waiting for something that is never coming.
  if (claim.verification?.status === "unscheduled") {
    return { text: claim.verification.reason === "verification_budget_unavailable"
      ? "本轮预算不足以安排独立复核" : "本轮复核名额已满，未安排独立复核", refuted: false };
  }
  if (claim.tier === "gated") return { text: "已通过交付门禁，尚未独立复核", refuted: false };
  if (claim.tier === "unverified") return { text: "尚未通过任何验证", refuted: false };
  return null;
}

function ClaimVerification({ claim }: { claim: DigestClaim }) {
  const label = verificationLabel(claim);
  if (!label) return null;
  return <p className={label.refuted ? "mt-1 text-caption text-error" : "mt-1 text-caption text-muted"}>{label.text}</p>;
}

/** What the researcher last said about a finding; a rejection is echoed back as the promise it makes. */
function decisionLabel(digest: DigestRecord, claimId: string): string | null {
  const last = [...(digest.payload.decisions ?? [])].reverse().find((decision) => decision.claimId === claimId);
  if (!last) return null;
  if (last.action === "adopt") return "已采纳";
  if (last.action === "reject") return "已记住：不再按这个方向";
  if (last.action === "question") return `已追问：${last.note}`;
  return null;
}

export function AutopilotPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const digestId = searchParams.get("digest");
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [digests, setDigests] = useState<DigestRecord[]>([]);
  const [selectedDigest, setSelectedDigest] = useState<DigestRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<{ digestId: string; claimId: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const digestView = useRef(0);
  const pendingOpen = useRef<string | null>(null);
  const recordedOpen = useRef<string | null>(null);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    setAgendas(null); setSelectedDigest(null);
    try {
      const selected = digestId ? await getDigest(digestId) : null;
      if (current !== generation.current) return;
      const projectId = selected?.projectId ?? getWebProjectId();
      const [agendaPage, digestPage] = await Promise.all([listAgendas(projectId), listDigests(projectId)]);
      if (current !== generation.current) return;
      setAgendas(agendaPage.items); setDigests(digestPage.items); setSelectedDigest(selected);
    } catch (loadError) {
      if (current !== generation.current) return;
      setAgendas([]); setDigests([]); setError(`主动科研状态不可用：${productErrorMessage(loadError)}`);
    }
  }, [digestId]);
  useEffect(() => {
    const requests = generation;
    const views = digestView;
    views.current++;
    pendingOpen.current = null;
    recordedOpen.current = null;
    setActivityError(null);
    void load();
    return () => { requests.current++; views.current++; };
  }, [load]);
  useEffect(() => {
    if (!selectedDigest || selectedDigest.id !== digestId || recordedOpen.current === digestId || pendingOpen.current === digestId) return;
    // Reloading this digest after a decision does not finish its pending read.
    // Only leaving the digest invalidates the completion or retry feedback.
    const view = digestView.current;
    pendingOpen.current = digestId;
    void markDigestOpened(selectedDigest.id).then(() => {
      if (view !== digestView.current) return;
      pendingOpen.current = null;
      recordedOpen.current = digestId;
      setActivityError(null);
    }).catch((openError) => {
      if (view !== digestView.current) return;
      pendingOpen.current = null;
      setActivityError(`阅读记录未保存：${productErrorMessage(openError)}`);
    });
  }, [selectedDigest, digestId]);
  const mutate = async (operation: () => Promise<unknown>) => {
    const current = generation.current;
    setBusy(true); setError(null);
    try { await operation(); if (current === generation.current) await load(); }
    catch (operationError) { if (current === generation.current) setError(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };
  const visibleDigests = selectedDigest ? [selectedDigest, ...digests.filter((digest) => digest.id !== selectedDigest.id)] : digests;
  const visibleError = error ?? activityError;
  const today = new Date().toISOString().slice(0, 10);
  return <main className="h-full overflow-y-auto px-5 py-6"><div className="mx-auto max-w-content-wide space-y-5">
    <header><h1 className="font-serif text-title text-text">主动科研</h1><p className="mt-2 text-ui text-muted">按研究议程运行受额度和停止规则约束的回合，结果仍走普通研究门禁。</p></header>
    {visibleError && <Card><div role="alert" className="flex items-center justify-between gap-3"><p className="text-ui text-error">{visibleError}</p>
      <Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div></Card>}
    {agendas === null ? <MemorySkeleton /> : agendas.length === 0 ? <EmptyState icon={CalendarClock} title="还没有主动科研议程" description="议程创建后默认暂停，只有你主动开始才会运行和产生费用。" />
      : <section className="space-y-3" aria-label="研究议程">{agendas.map((agenda) => <Card key={agenda.id} title={agenda.payload.title}
        hint={`${agenda.payload.status === "active" ? "运行中" : "已暂停"} · ${agenda.payload.topics.join("、")}`}><div className="space-y-3">
        <p className="text-ui-sm text-muted">每日 ¥{agenda.payload.dailyBudgetCny} · 每周 ¥{agenda.payload.weeklyBudgetCny} · 单回合 ¥{agenda.payload.maxEpisodeCny}</p>
        {agenda.payload.pauseReason && <p className="text-ui-sm text-muted">{agenda.payload.pauseReason}</p>}
        {pendingFollowUps(agenda) > 0 && <p className="text-ui-sm text-muted">下一回合先回答 {pendingFollowUps(agenda)} 条追问。</p>}
        <div className="flex flex-wrap gap-2">
          {agenda.payload.status === "active" ? <><Button size="sm" disabled={busy} onClick={() => void mutate(() => scheduleAgenda(agenda.id, today))}><Sparkles size={13} />立即运行一回合</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => stopAgenda(agenda.id, agenda.revision))}><PauseCircle size={13} />停止</Button></>
            : <Button size="sm" disabled={busy} onClick={() => void mutate(() => startAgenda(agenda.id, agenda.revision))}><PlayCircle size={13} />开始主动科研</Button>}
        </div></div></Card>)}</section>}
    <section className="space-y-3" aria-label="晨间简报"><h2 className="font-serif text-body text-text">晨间简报</h2>
      {agendas === null ? <MemorySkeleton /> : visibleDigests.length === 0 ? <EmptyState title="还没有简报" description="完成的主动科研回合会在这里汇总发现、变化与花费。" />
        : visibleDigests.map((digest) => <Card key={digest.id} title={digest.payload.date} hint={`本期花费 ¥${digest.payload.costCny}`}><div className="space-y-4">
          {selectedDigest?.id !== digest.id ? <Button size="sm" variant="ghost" onClick={() => setSearchParams({ digest: digest.id })}>查看简报</Button>
            : [...digest.payload.headlines.map((claim) => ({ claim, kind: "重点发现" })), ...digest.payload.leads.map((claim) => ({ claim, kind: "待验证线索" }))].map(({ claim, kind }) => <div key={claim.id} className="rounded-input bg-surface-2 p-3">
            <p className="text-caption text-muted">{kind}</p><p className="mt-1 text-ui text-text">{claim.statement}</p>
            <ClaimVerification claim={claim} />
            {decisionLabel(digest, claim.id) && <p className="mt-1 text-ui-sm text-muted">{decisionLabel(digest, claim.id)}</p>}
            <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="ghost" aria-label={`采纳${claim.statement}`} disabled={busy} onClick={() => void mutate(() => decideDigest(digest.id, { action: "adopt", claimId: claim.id, note: "" }))}>采纳</Button>
              <Button size="sm" variant="ghost" aria-label={`驳回${claim.statement}`} disabled={busy} onClick={() => void mutate(() => decideDigest(digest.id, { action: "reject", claimId: claim.id, note: "" }))}>驳回</Button>
              <Button size="sm" variant="ghost" aria-label={`追问${claim.statement}`} disabled={busy} onClick={() => setFollowUp(followUp?.claimId === claim.id && followUp.digestId === digest.id ? null : { digestId: digest.id, claimId: claim.id, note: "" })}>追问</Button></div>
            {followUp?.digestId === digest.id && followUp.claimId === claim.id && <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => {
              event.preventDefault();
              const note = followUp.note.trim();
              if (!note) return;
              void mutate(async () => { await decideDigest(digest.id, { action: "question", claimId: claim.id, note }); setFollowUp(null); });
            }}>
              <Input className="min-w-0 flex-1" label="追问" placeholder="想让下一回合先回答什么？" value={followUp.note} onChange={(event) => setFollowUp({ ...followUp, note: event.target.value })} />
              <Button size="sm" type="submit" disabled={busy || !followUp.note.trim()}>发送追问</Button>
            </form>}
          </div>)}</div></Card>)}</section>
  </div></main>;
}
