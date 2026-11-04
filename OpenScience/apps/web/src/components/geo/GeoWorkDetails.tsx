import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { geoConversationHistory, geoConversationSources, geoConversationSourceScope, type GeoConversationScope } from "@/lib/geoNativeClient";
import { Link } from "react-router";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { KNOWLEDGE_BASE_ACCEPT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";
import { CONVERSATION_SETTLED_EVENT } from "@/lib/runtimeUiBridge";
import type { GeoProject, GeoStepKey } from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { bandSteps } from "./geoBand";
import { GEO_STEP_HOME, geoDestinationPath } from "./geoTabs";
import { useGeoPath } from "./useGeoPath";
import { GeoWeekActivity } from "./GeoWeekActivity";

/** Project context beside the native conversation. */
export function GeoWorkDetails({ project, sessionId = null, onOpenRuns, onOpenSettings }: { project: GeoProject; sessionId?: string | null; onOpenRuns: () => void; onOpenSettings: () => void }) {
  const ownerCanUpload = project.access?.owner === true && (!project.access.abilities || project.access.abilities.includes("edit"));
  const generation = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration, sessionGeneration);
  const identity = `${generation}:${project.id}:${project.projectId}:${sessionId ?? ""}:${ownerCanUpload}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const path = useGeoPath();
  const destination = (step: GeoStepKey) => path(geoDestinationPath(project.id, GEO_STEP_HOME[step]));
  const steps = project.overview?.steps && Object.keys(project.overview.steps).length ? project.overview.steps : project.steps;
  const progress = bandSteps(project, destination).filter((step) => !step.outside || steps[step.id as GeoStepKey]?.requested === true);
  const product = project.product;
  const identities = [product?.brandName, product?.genericName].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  return (
    <aside aria-label="项目资料" className="flex min-w-0 flex-col gap-5 text-ui">
      <section aria-labelledby="geo-work-product">
        <h2 id="geo-work-product" className="font-semibold text-text">产品与范围</h2>
        {identities.length > 0 && <p className="mt-2 text-text">{identities.join(" · ")}</p>}
        {product?.indication && <p className="mt-2 whitespace-pre-wrap text-text-2">{product.indication}</p>}
        {identities.length === 0 && !product?.indication && <p className="mt-2 text-text-3">产品资料尚未填写。</p>}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          <Link className="text-link hover:underline" to={destination("evidence")}>产品依据</Link>
          <Link className="text-link hover:underline" to={destination("journey")}>患者旅程</Link>
          <Link className="text-link hover:underline" to={destination("content")}>稿件与成果</Link>
        </div>
      </section>
      <WorkMaterials key={`${identity}:materials`} projectId={project.projectId} geoId={project.id} sessionId={sessionId} owner={ownerCanUpload} isCurrent={() => currentIdentity.current === identity} />
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer font-semibold text-text">任务进度{progress.length > 0 ? `（${progress.length}）` : ""}</summary>
        {progress.length ? <ul className="mt-3 flex flex-col gap-2">{progress.map((step) => <li key={step.id} className="flex justify-between gap-3">
          <Link className="min-w-0 text-link hover:underline" to={step.href!}>{step.label}</Link>
          <span className="shrink-0 text-text-2">{step.outside && steps[step.id as GeoStepKey]?.automation?.state === "declined" ? "已关闭" : step.stateLabel}</span>
        </li>)}</ul> : <p className="mt-3 text-text-3">暂无任务进度。</p>}
      </details>
      <GeoWeekActivity geoId={project.id} project={project} compact />
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button variant="secondary" size="sm" onClick={onOpenRuns}>执行详情</Button>
        <Button variant="secondary" size="sm" onClick={onOpenSettings}>项目设置</Button>
      </div>
    </aside>
  );
}


type ContextData = {
  sources: Awaited<ReturnType<typeof geoConversationSources>>;
  selection: Awaited<ReturnType<typeof geoConversationSourceScope>>;
  history: Awaited<ReturnType<typeof geoConversationHistory>>;
};
type Read<T> = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: T };

function ConversationContext({ scope, refresh }: { scope: GeoConversationScope; refresh: number }) {
  const { geoProjectId, sessionId } = scope;
  const [attempt, setAttempt] = useState(0);
  const [sources, setSources] = useState<Read<ContextData["sources"]>>({ kind: "loading" });
  const [selection, setSelection] = useState<Read<ContextData["selection"]>>({ kind: "loading" });
  const [history, setHistory] = useState<Read<ContextData["history"]>>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    const current: GeoConversationScope = { kind: "geo", geoProjectId, sessionId };
    setSources({ kind: "loading" }); setSelection({ kind: "loading" }); setHistory({ kind: "loading" });
    void geoConversationSources(current).then(data => { if (active) setSources({ kind: "ready", data }); }, () => { if (active) setSources({ kind: "error" }); });
    void geoConversationSourceScope(current).then(data => { if (active) setSelection({ kind: "ready", data }); }, () => { if (active) setSelection({ kind: "error" }); });
    void geoConversationHistory(current).then(data => { if (active) setHistory({ kind: "ready", data }); }, () => { if (active) setHistory({ kind: "error" }); });
    return () => { active = false; };
  }, [geoProjectId, sessionId, attempt, refresh]);
  const failed = sources.kind === "error" || selection.kind === "error" || history.kind === "error";
  const chosen = selection.kind === "ready" ? selection.data.sourceScope : undefined;
  const requests = history.kind === "ready" ? history.data.messages.filter(message => message.role === "user").slice(-3).reverse() : [];
  return <section aria-label="对话资料" className="border-t border-border pt-4">
    <h2 className="font-semibold text-text">对话资料</h2>
    {selection.kind === "loading" || sources.kind === "loading" ? <p className="mt-2 text-text-3">正在读取资料范围</p> : null}
    {selection.kind === "ready" && <p className="mt-2 text-text-2">{chosen === null ? "当前范围：项目默认资料" : chosen?.length === 0 ? "当前范围：不使用资料" : `当前范围：已选择 ${chosen?.length ?? 0} 份资料`}</p>}
    {sources.kind === "ready" && <>
      <p className="mt-2 text-caption text-text-3">本项目已就绪资料（{sources.data.length}）</p>
      {sources.data.length ? <ul className="mt-1 space-y-1">{sources.data.map(source => <li key={source.id} className="flex justify-between gap-2"><span className="min-w-0 break-words">{source.title}</span><span className="shrink-0 text-caption text-text-3">{chosen === undefined ? "范围未知" : chosen === null ? "项目默认" : chosen.includes(source.id) ? "已选择" : "未选择"}</span></li>)}</ul> : <p className="mt-1 text-text-3">本项目暂无已就绪资料。</p>}
      {chosen && chosen.some(id => !sources.data.some(source => source.id === id)) && <p className="mt-2 text-text-3">部分资料名称不可用。</p>}
    </>}
    <div className="mt-2"><Note action={<Button variant="text" size="sm" onClick={() => setAttempt(value => value + 1)}>刷新</Button>}>对话中用 @ 选择知识库资料；附件单独管理。项目默认范围也可能包含共享资料。</Note></div>
    <h3 className="mt-4 font-semibold text-text">最近对话请求</h3>
    {history.kind === "loading" && <p className="mt-1 text-text-3">正在读取请求</p>}
    {history.kind === "ready" && <>{history.data.partial && <p className="mt-1 text-caption text-text-3">历史记录不完整。</p>}{requests.length ? <ul className="mt-1 space-y-1">{requests.map(message => <li key={message.seq} className="line-clamp-2 break-words text-text-2">{message.text}</li>)}</ul> : <p className="mt-1 text-text-3">已保存的记录中暂无请求。</p>}</>}
    {failed && <p role="alert" className="mt-2 text-text-3">部分对话资料未能读取。 <Button variant="text" size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button></p>}
  </section>;
}


function WorkMaterials({ projectId, geoId, sessionId, owner, isCurrent }: { projectId: string; geoId: string; sessionId: string | null; owner: boolean; isCurrent: () => boolean }) {
  const mounted = useRef(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const update = (event: Event) => {
      if (sessionId && (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) setRefresh(value => value + 1);
    };
    window.addEventListener(CONVERSATION_SETTLED_EVENT, update);
    return () => window.removeEventListener(CONVERSATION_SETTLED_EVENT, update);
  }, [sessionId]);
  const add = async () => {
    const ownerGeneration = sessionGeneration();
    const valid = () => mounted.current && isCurrent() && sessionGeneration() === ownerGeneration;
    setUploading(true); setMessage("");
    try {
      const picked = await pickFiles(KNOWLEDGE_BASE_ACCEPT);
      if (!valid() || picked.length === 0) return;
      const { accepted, refused } = partitionKnowledgeBaseFiles(picked);
      if (accepted.length === 0) { setMessage("所选文件不符合知识库接收规则。"); return; }
      const names = await uploadFilesToWorkspace(accepted, "knowledge-base", "base", projectId, valid);
      if (!valid()) return;
      setMessage(names.length ? `已上传 ${names.length} 个文件，待解析；解析完成后可刷新资料列表。${refused.length ? ` ${refused.length} 个文件未被接收。` : ""}` : "未上传文件，请重试。");
      if (names.length) setRefresh(value => value + 1);
    } catch {
      if (valid()) setMessage("上传未完成，请重试。部分文件可能已上传，请先检查资料列表。");
    } finally { if (valid()) setUploading(false); }
  };
  return <>
    {owner && <div className="border-t border-border pt-4"><Button variant="secondary" size="sm" disabled={uploading} onClick={() => void add()}>{uploading ? "正在上传" : "添加项目资料"}</Button>{message && <p role="status" className="mt-2 text-text-3">{message}</p>}</div>}
    {sessionId ? <ConversationContext scope={{ kind: "geo", geoProjectId: geoId, sessionId }} refresh={refresh} /> : <section className="border-t border-border pt-4"><h2 className="font-semibold">对话资料</h2><p className="mt-2 text-text-3">打开对话后查看。</p></section>}
  </>;
}
