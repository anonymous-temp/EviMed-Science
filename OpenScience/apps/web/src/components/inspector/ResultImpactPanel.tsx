import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { inputClasses } from "@/components/ui/Input";
import { SourceUpdateBadges } from "@/components/markdown-viewer/SourceUpdateBadges";
import { listAgendas, type AgendaRecord } from "@/lib/autopilotClient";
import { productErrorMessage } from "@/lib/productClient";
import { checkResultSourceUpdates, continueResultImpact, listResultImpacts, type ResultImpact, type ResultSourceCheck } from "@/lib/resultImpactClient";

/** Current source notices are advisory; the selected historical result stays frozen. */
export function ResultImpactPanel({ projectId, versionId, digest }: { projectId: string; versionId: string; digest: string }) {
  const [items, setItems] = useState<ResultImpact[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [check, setCheck] = useState<ResultSourceCheck | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    setItems(null); setError(null); setCursor(null);
    void listResultImpacts(projectId, versionId).then(page => {
      if (!disposed) { setItems(page.items.filter(row => row.payload.versionId === versionId)); setCursor(page.nextCursor); }
    }).catch(caught => { if (!disposed) setError(productErrorMessage(caught)); });
    return () => { disposed = true; };
  }, [projectId, versionId, attempt]);
  const loadMore = async () => {
    setBusy(true); setError(null);
    try {
      const page = await listResultImpacts(projectId, versionId, cursor);
      setItems(current => [...new Map([...(current ?? []), ...page.items.filter(row => row.payload.versionId === versionId)].map(row => [row.id, row])).values()]);
      setCursor(page.nextCursor);
    } catch (caught) { setError(productErrorMessage(caught)); }
    finally { setBusy(false); }
  };
  const checkUpdates = async () => {
    setChecking(true); setCheckError(null); setCheck(null);
    try {
      const reply = await checkResultSourceUpdates(projectId, versionId);
      if (reply.versionId !== versionId || reply.digest !== digest) throw new Error("返回的来源更新与所选版本不一致");
      if (mounted.current) { setCheck(reply); setAttempt(value => value + 1); }
    } catch (caught) { if (mounted.current) setCheckError(productErrorMessage(caught)); }
    finally { if (mounted.current) setChecking(false); }
  };
  return <Disclosure summary="来源更新与后续研究" defaultOpen>
    <div className="space-y-3 py-3">
      <Button variant="secondary" loading={checking} disabled={checking} onClick={() => void checkUpdates()}>检查来源更新</Button>
      {checkError && <p role="alert" className="text-error">{checkError}</p>}
      {check && <div className="space-y-2" role="status">{check.statuses.length === 0 ? <p className="text-muted">此版本未记录可检查的来源。</p> : check.statuses.map((entry, index) => <div key={`${entry.source.id}:${index}`} className="space-y-1"><p className="break-all text-caption">{["restricted", "deleted"].includes(entry.updateStatus.reason ?? "") ? "原来源已不可用" : entry.doi ?? entry.source.id}</p><SourceUpdateBadges updates={entry.updateStatus.updates} updateStatus={entry.updateStatus} /></div>)}</div>}
      {items === null && !error && <p role="status" className="text-muted">正在查询来源更新</p>}
      {error && <div role="alert" className="space-y-2"><p className="text-error">{error}</p><Button variant="secondary" onClick={() => items === null ? setAttempt(value => value + 1) : void loadMore()}>重试来源更新</Button></div>}
      {items?.length === 0 && <p className="text-muted">暂无此版本的来源更新记录，更新状态尚未确认。</p>}
      {items?.map(impact => <ImpactItem key={impact.id} impact={impact} projectId={projectId} onUpdate={updated => setItems(current => current?.map(row => row.id === updated.id ? updated : row) ?? null)} onRefresh={() => setAttempt(value => value + 1)} />)}
      {cursor && <Button variant="text" loading={busy} onClick={() => void loadMore()}>更多来源更新</Button>}
    </div>
  </Disclosure>;
}

function ImpactItem({ impact, projectId, onUpdate, onRefresh }: { impact: ResultImpact; projectId: string; onUpdate: (impact: ResultImpact) => void; onRefresh: () => void }) {
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [agendaId, setAgendaId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const actionable = impact.payload.effect === "potentially_affected" && impact.payload.sourceStatus.state === "changed" && impact.payload.continuation.status !== "scheduled";
  useEffect(() => {
    if (!actionable) return;
    let disposed = false;
    setAgendas(null); setError(null); setAgendaId("");
    void listAgendas(projectId).then(page => {
      if (!disposed) setAgendas(page.items.filter(row => row.payload.enabled && row.payload.status === "active" && !row.payload.archivedAt));
    }).catch(caught => { if (!disposed) setError(productErrorMessage(caught)); });
    return () => { disposed = true; };
  }, [projectId, actionable, attempt]);
  const proceed = async () => {
    if (!agendas?.some(agenda => agenda.id === agendaId) || busy) return;
    setBusy(true); setError(null);
    try {
      const updated = await continueResultImpact(projectId, impact, agendaId);
      if (mounted.current) onUpdate(updated);
    } catch (caught) { if (mounted.current) setError(productErrorMessage(caught)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const status = impact.payload.sourceStatus;
  return <section aria-label={`来源更新 ${impact.payload.source.id}`} className="space-y-2 rounded-card border border-border p-3">
    <p className="break-all text-caption">{impact.payload.continuation.status === "unavailable" ? "原来源已不可用" : impact.payload.source.doi ?? impact.payload.source.id}</p>
    <SourceUpdateBadges updates={status.updates} updateStatus={status} />
    <p className="text-caption text-muted">{status.state === "changed" ? "此版本的结论可能受影响，尚未重新计算。" : "来源更新情况无法确认，不能据此判断结论已改变。"} 历史结果已保留。</p>
    {impact.payload.claimIds.length > 0 && <p className="text-caption">涉及 {impact.payload.claimIds.length} 处结论</p>}
    {impact.payload.continuation.status === "scheduled" ? <p role="status">已安排后续研究。<Link to="/app/autopilot" className="text-accent hover:underline">查看研究议程</Link></p> : actionable && <>
      {agendas === null && !error && <p role="status" className="text-muted">正在读取研究议程</p>}
      {agendas?.length === 0 && <p className="text-muted">需要已有且正在进行的研究议程。<Link to="/app/autopilot" className="text-accent hover:underline">查看研究议程</Link></p>}
      {Boolean(agendas?.length) && <><label className="block text-caption">选择已有研究议程<select aria-label={`研究议程 ${impact.payload.source.id}`} className={inputClasses({ className: "mt-2" })} value={agendaId} disabled={busy} onChange={event => setAgendaId(event.target.value)}><option value="">请选择</option>{agendas!.map(agenda => <option key={agenda.id} value={agenda.id}>{agenda.payload.title}</option>)}</select></label><Button variant="secondary" disabled={!agendaId} loading={busy} onClick={() => void proceed()}>在此议程中继续研究</Button></>}
    </>}
    {error && <div role="alert" className="space-y-2"><p className="text-error">{error}</p><Button variant="text" onClick={() => agendas === null ? setAttempt(value => value + 1) : onRefresh()}>刷新并重试</Button></div>}
  </section>;
}
