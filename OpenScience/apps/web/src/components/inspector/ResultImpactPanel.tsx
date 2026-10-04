import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { inputClasses } from "@/components/ui/Input";
import { SourceUpdateBadges } from "@/components/markdown-viewer/SourceUpdateBadges";
import { tagClasses } from "@/components/ui/Tag";
import { listAgendas, type AgendaRecord } from "@/lib/autopilotClient";
import { productErrorMessage } from "@/lib/productClient";
import { checkResultSourceUpdates, continueResultImpact, listResultImpacts, type ResultImpact, type ResultImpactAffected, type ResultSourceCheck } from "@/lib/resultImpactClient";

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
      {check && <div className="space-y-2" role="status">{check.statuses.length === 0 ? <p className="text-muted">此版本未记录可检查的来源。</p> : check.statuses.map((entry, index) => <div key={`${entry.source.id}:${index}`} className="space-y-1"><p className="break-all text-caption">{["restricted", "deleted"].includes(entry.updateStatus.reason ?? "") ? "原来源已不可用" : entry.doi ?? entry.source.id}{entry.viaCalculation ? "（来自所依据的计算）" : ""}</p><SourceUpdateBadges updates={entry.updateStatus.updates} updateStatus={entry.updateStatus} /></div>)}</div>}
      {items === null && !error && <p role="status" className="text-muted">正在查询来源更新</p>}
      {error && <div role="alert" className="space-y-2"><p className="text-error">{error}</p><Button variant="secondary" onClick={() => items === null ? setAttempt(value => value + 1) : void loadMore()}>重试来源更新</Button></div>}
      {items?.length === 0 && <p className="text-muted">暂无此版本的来源更新记录，更新状态尚未确认。</p>}
      {items?.map(impact => <ImpactItem key={impact.id} impact={impact} projectId={projectId} onUpdate={updated => setItems(current => current?.map(row => row.id === updated.id ? updated : row) ?? null)} onRefresh={() => setAttempt(value => value + 1)} />)}
      {cursor && <Button variant="text" loading={busy} onClick={() => void loadMore()}>更多来源更新</Button>}
    </div>
  </Disclosure>;
}

/** What was found to rest on the changed source, in the words of a change: each class says what was found, or that it could
 *  not be looked up, which is not the same as none. Nothing here says the conclusion is wrong. */
function affectedLines(affected: ResultImpactAffected): string[] {
  const lines: string[] = [];
  const { calculations, dependents, memories, methods } = affected;
  if (calculations.status === "found") lines.push(`本版本里有 ${calculations.items.reduce((sum, item) => sum + item.boundValues, 0)} 处数值来自 ${calculations.total} 个依赖该来源的计算`);
  if (dependents.status === "found") lines.push(`${dependents.total} 个结果的数值引用了这个计算`);
  if (memories.status === "found") lines.push(`${memories.total} 条记忆依赖该来源，已标注“来源有变化”，记忆本身没有改动`);
  if (methods.status === "found") lines.push(`${methods.total} 个学到的方法与此结果相关，已标注“来源有变化”，方法本身没有改动`);
  const unknown = ([["计算", calculations], ["记忆", memories], ["方法", methods]] as const).filter(([, entry]) => entry.status === "unknown").map(([name]) => name);
  if (unknown.length) lines.push(`依赖该来源的${unknown.join("、")}暂时查不到，不能当作没有`);
  if (!lines.length) lines.push("未发现依赖该来源的其他计算、记忆或方法");
  return lines;
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
  // A file the knowledge base holds in a newer version is not a publisher's notice: it says so itself.
  const replaced = status.updates.some(update => update.kind === "replaced");
  return <section aria-label={`来源更新 ${impact.payload.source.id}`} className="space-y-2 rounded-card border border-border p-3">
    <p className="break-all text-caption">{impact.payload.continuation.status === "unavailable" ? "原来源已不可用" : replaced ? "资料库中的文件" : impact.payload.source.doi ?? impact.payload.source.id}</p>
    {replaced ? <span className={tagClasses({ tone: "warn" })}>资料库文件已有新版本</span> : <SourceUpdateBadges updates={status.updates} updateStatus={status} />}
    <p className="text-caption text-muted">{status.state === "changed" ? "来源有了变化，依赖它的部分值得核对。这不说明原来的结论有误，尚未重新计算。" : "来源更新情况无法确认，不能据此判断结论已改变。"} 历史结果已保留。</p>
    {impact.payload.claimIds.length > 0 && <p className="text-caption">涉及 {impact.payload.claimIds.length} 处结论</p>}
    {impact.payload.affected && impact.payload.continuation.status !== "unavailable" && <ul aria-label="依赖该来源的内容" className="list-disc space-y-1 pl-5 text-caption">
      {affectedLines(impact.payload.affected).map(line => <li key={line}>{line}</li>)}
    </ul>}
    {impact.payload.continuation.status === "scheduled" ? <p role="status">已安排后续研究，只重新核对上面列出的部分，其余结果不会重新运行。<Link to="/app/autopilot" className="text-accent hover:underline">查看研究议程</Link></p> : actionable && <>
      {agendas === null && !error && <p role="status" className="text-muted">正在读取研究议程</p>}
      {agendas?.length === 0 && <p className="text-muted">需要已有且正在进行的研究议程。<Link to="/app/autopilot" className="text-accent hover:underline">查看研究议程</Link></p>}
      {Boolean(agendas?.length) && <><label className="block text-caption">选择已有研究议程<select aria-label={`研究议程 ${impact.payload.source.id}`} className={inputClasses({ className: "mt-2" })} value={agendaId} disabled={busy} onChange={event => setAgendaId(event.target.value)}><option value="">请选择</option>{agendas!.map(agenda => <option key={agenda.id} value={agenda.id}>{agenda.payload.title}</option>)}</select></label><Button variant="secondary" disabled={!agendaId} loading={busy} onClick={() => void proceed()}>在此议程中继续研究</Button></>}
    </>}
    {error && <div role="alert" className="space-y-2"><p className="text-error">{error}</p><Button variant="text" onClick={() => agendas === null ? setAttempt(value => value + 1) : onRefresh()}>刷新并重试</Button></div>}
  </section>;
}
