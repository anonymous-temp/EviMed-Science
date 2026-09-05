import { useCallback, useEffect, useState } from "react";
import { CalendarClock, PauseCircle, PlayCircle, Sparkles } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { decideDigest, listAgendas, listDigests, scheduleAgenda, startAgenda, stopAgenda,
  type AgendaRecord, type DigestRecord } from "@/lib/autopilotClient";
import { productErrorMessage } from "@/lib/productClient";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";

export function AutopilotPage() {
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [digests, setDigests] = useState<DigestRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const projectId = getWebProjectId();
      const [agendaPage, digestPage] = await Promise.all([listAgendas(projectId), listDigests(projectId)]);
      setAgendas(agendaPage.items); setDigests(digestPage.items);
    } catch (loadError) { setAgendas([]); setError(`主动科研状态不可用：${productErrorMessage(loadError)}`); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await operation(); await load(); } catch (operationError) { setError(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };
  const today = new Date().toISOString().slice(0, 10);
  return <main className="h-full overflow-y-auto px-5 py-6"><div className="mx-auto max-w-content-wide space-y-5">
    <header><h1 className="font-serif text-title text-text">主动科研</h1><p className="mt-2 text-ui text-muted">按研究议程运行受额度和停止规则约束的回合，结果仍走普通研究门禁。</p></header>
    {error && <Card><p className="text-ui text-error">{error}</p></Card>}
    {agendas === null ? <MemorySkeleton /> : agendas.length === 0 ? <EmptyState icon={CalendarClock} title="还没有主动科研议程" description="议程创建后默认暂停，只有你主动开始才会运行和产生费用。" />
      : <section className="space-y-3" aria-label="研究议程">{agendas.map((agenda) => <Card key={agenda.id} title={agenda.payload.title}
        hint={`${agenda.payload.status === "active" ? "运行中" : "已暂停"} · ${agenda.payload.topics.join("、")}`}><div className="space-y-3">
        <p className="text-ui-sm text-muted">每日 ¥{agenda.payload.dailyBudgetCny} · 每周 ¥{agenda.payload.weeklyBudgetCny} · 单回合 ¥{agenda.payload.maxEpisodeCny}</p>
        {agenda.payload.pauseReason && <p className="text-ui-sm text-muted">{agenda.payload.pauseReason}</p>}
        <div className="flex flex-wrap gap-2">
          {agenda.payload.status === "active" ? <><Button size="sm" disabled={busy} onClick={() => void mutate(() => scheduleAgenda(agenda.id, today))}><Sparkles size={13} />立即运行一回合</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => stopAgenda(agenda.id, agenda.revision))}><PauseCircle size={13} />停止</Button></>
            : <Button size="sm" disabled={busy} onClick={() => void mutate(() => startAgenda(agenda.id, agenda.revision))}><PlayCircle size={13} />开始主动科研</Button>}
        </div></div></Card>)}</section>}
    <section className="space-y-3" aria-label="晨间简报"><h2 className="font-serif text-body text-text">晨间简报</h2>
      {digests.length === 0 ? <EmptyState title="还没有简报" description="完成的主动科研回合会在这里汇总发现、变化与花费。" />
        : digests.map((digest) => <Card key={digest.id} title={digest.payload.date} hint={`本期花费 ¥${digest.payload.costCny}`}><div className="space-y-4">
          {[...digest.payload.headlines.map((claim) => ({ claim, kind: "重点发现" })), ...digest.payload.leads.map((claim) => ({ claim, kind: "待验证线索" }))].map(({ claim, kind }) => <div key={claim.id} className="rounded-input bg-surface-2 p-3">
            <p className="text-caption text-muted">{kind}</p><p className="mt-1 text-ui text-text">{claim.statement}</p>
            <div className="mt-2 flex gap-2"><Button size="sm" variant="ghost" aria-label={`采纳${claim.statement}`} disabled={busy} onClick={() => void mutate(() => decideDigest(digest.id, { action: "adopt", claimId: claim.id, note: "" }))}>采纳</Button>
              <Button size="sm" variant="ghost" aria-label={`驳回${claim.statement}`} disabled={busy} onClick={() => void mutate(() => decideDigest(digest.id, { action: "reject", claimId: claim.id, note: "" }))}>驳回</Button></div>
          </div>)}</div></Card>)}</section>
  </div></main>;
}
